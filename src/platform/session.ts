// A play session: emulator + frame loop + audio + Nuzlocke tracker + persistence.

import { Grinder, type GrindEnd, type GrindProgress } from '../bot/grinder.ts';
import { FRAME_RATE, SCREEN_H, SCREEN_W } from '../core/constants.ts';
import { createEmulator } from '../core/create.ts';
import type { CoreKind, Emulator } from '../core/emulator.ts';
import { nextMilestone, readMilestones, type Milestone } from '../gen1/milestones.ts';
import { detectVersion, Gen1Data } from '../gen1/rom.ts';
import { SYMBOLS } from '../gen1/symbols.ts';
import { EventDiffer, Gen1Reader, type Ram, type Snapshot } from '../gen1/watcher.ts';
import { applyEvent, liveWarnings, newRun, syncMons } from '../run/engine.ts';
import { DEFAULT_RULES, type Notice, type Rules, type Run } from '../run/types.ts';
import { AudioOut } from './audio.ts';
import { packPalette, paletteById } from './palettes.ts';
import { db, type RomRecord } from './storage.ts';

export const SPEEDS = [1, 2, 4, 8] as const;

export interface ToastItem extends Notice {
  id: number;
  at: number;
}

export interface SessionView {
  snap: Snapshot | null;
  run: Run | null;
  paused: boolean;
  speed: number;
  toasts: ToastItem[];
  warnings: string[];
  milestone: Milestone | null;
  fps: number;
  muted: boolean;
  version: string | null;
  /** Auto-grind progress while the bot is playing. */
  grind: GrindProgress | null;
  /** Why the last auto-grind stopped, until dismissed. */
  grindEnd: (GrindEnd & { summary: string }) | null;
  /** Which emulator core is running. */
  core: CoreKind;
  /** Average milliseconds of emulation per Game Boy frame (last second), or null before a sample. */
  emuMs: number | null;
  rev: number;
}

export interface GrindSettings {
  targetLevel: number;
  usePotions: boolean;
}

const FRAME_MS = 1000 / FRAME_RATE;
const TRACK_EVERY = 4;
/** Main-thread time per animation frame spent emulating while auto-grind runs. */
const GRIND_BUDGET_MS = 12;

export class Session {
  private emu: Emulator;
  private coreKind: CoreKind;
  readonly rom: RomRecord;
  readonly data: Gen1Data | null;
  readonly milestones: Milestone[];
  readonly audio = new AudioOut();
  private reader: Gen1Reader | null;
  private differ = new EventDiffer();
  private run: Run | null = null;
  private snap: Snapshot | null = null;
  private ram: Ram;

  private canvas: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;
  private pixels: Uint32Array | null = null;
  private palette = packPalette(paletteById('dusk'));

  private raf = 0;
  private last = 0;
  private acc = 0;
  private frameNo = 0;
  private paused = false;
  private hidden = false;
  private speed = 1;
  /** Endless Repel: keep the game's repel step counter topped up. */
  private repel = false;
  private repelApplied = false;
  private muted = false;
  private grinder: Grinder | null = null;
  private grindEnd: SessionView['grindEnd'] = null;
  private grindStartedAt = 0;
  private wakeLock: { release: () => Promise<void> } | null = null;
  private fpsFrames = 0;
  private fpsAt = 0;
  private fps = 0;
  private emuTime = 0;
  private emuFrames = 0;
  private emuMs: number | null = null;

  private toasts: ToastItem[] = [];
  private toastId = 0;
  private shownOnce = new Set<string>();
  private view: SessionView;
  private listeners = new Set<() => void>();
  private publishAt = 0;
  private runDirty = false;
  private runSaveTimer = 0;
  private sramTimer = 0;
  private resumeTimer = 0;
  private rev = 0;
  private destroyed = false;
  private onHide = () => this.handleHide();
  private onVis = () => (document.visibilityState === 'hidden' ? this.handleHide() : this.handleShow());

  private constructor(rom: RomRecord, sram: Uint8Array | undefined, gb: Emulator, core: CoreKind) {
    this.rom = rom;
    this.emu = gb;
    this.coreKind = core;
    if (sram && sram.length === this.gb.cart.ram.length) this.gb.cart.ram.set(sram);
    const version = detectVersion(rom.data);
    this.data = version ? new Gen1Data(rom.data, version) : null;
    this.milestones = this.data ? readMilestones(this.data) : [];
    this.reader = version ? new Gen1Reader(SYMBOLS[version]) : null;
    this.ram = this.bindRam();
    this.view = this.buildView();
    document.addEventListener('visibilitychange', this.onVis);
    window.addEventListener('pagehide', this.onHide);
  }

  static async open(rom: RomRecord, core: CoreKind = 'wasm'): Promise<Session> {
    const sram = await db.getSram(rom.key);
    const { gb, kind } = await createEmulator(rom.data, core);
    const s = new Session(rom, sram, gb, kind);
    const resume = await db.getState(rom.key, 'resume');
    if (resume) {
      try {
        s.gb.loadState(resume.state);
      } catch (err) {
        console.warn('Could not restore resume state', err);
      }
    }
    const activeRunId = await db.getKv<string>(`activeRun:${rom.key}`);
    if (activeRunId) {
      const run = await db.getRun(activeRunId);
      if (run) s.attachRun(run);
    }
    await db.putRom({ ...rom, lastPlayedAt: Date.now() });
    s.start();
    return s;
  }

  /** The running emulator core. Changes if the core is switched. */
  get gb(): Emulator {
    return this.emu;
  }

  get core(): CoreKind {
    return this.coreKind;
  }

  /** Work RAM reads straight from the array; everything else through the bus. */
  private bindRam(): Ram {
    const wram = this.gb.bus.wram;
    const bus = this.gb.bus;
    return { u8: (a: number) => (a >= 0xc000 && a < 0xe000 ? wram[a - 0xc000] : bus.read(a)) };
  }

  /**
   * Swap emulator cores mid-game by carrying a save state across. The cores
   * share a state format, so play continues from the same instant.
   */
  async switchCore(kind: CoreKind): Promise<CoreKind> {
    if (kind === this.coreKind) return kind;
    this.stopGrind();
    const state = this.gb.saveState();
    const dirty = this.gb.cart.ramDirty;
    const { gb, kind: got } = await createEmulator(this.rom.data, kind);
    if (this.destroyed) return this.coreKind;
    gb.loadState(state);
    gb.cart.ramDirty = dirty;
    this.emu = gb;
    this.coreKind = got;
    this.ram = this.bindRam();
    this.emuTime = this.emuFrames = 0;
    this.emuMs = null;
    this.audio.clear();
    this.present();
    this.publish();
    return got;
  }

  /** Run one Game Boy frame, timing it for the emulation-cost readout. */
  private emulateFrame(): void {
    const t = performance.now();
    this.gb.runFrame();
    this.emuTime += performance.now() - t;
    this.emuFrames++;
  }

  // ---- external store for React ----
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getView = (): SessionView => this.view;

  private buildView(): SessionView {
    const cap = this.snap ? nextMilestone(this.milestones, this.snap.badges) : null;
    return {
      snap: this.snap,
      run: this.run,
      paused: this.paused,
      speed: this.speed,
      toasts: this.toasts,
      warnings: this.run && this.snap ? liveWarnings(this.run, this.snap, cap?.ace ?? null) : [],
      milestone: cap,
      fps: this.fps,
      muted: this.muted,
      version: this.data?.version ?? null,
      grind: this.grinder ? { ...this.grinder.getProgress() } : null,
      grindEnd: this.grindEnd,
      core: this.coreKind,
      emuMs: this.emuMs,
      rev: this.rev,
    };
  }

  private publish(): void {
    this.rev++;
    this.view = this.buildView();
    for (const l of this.listeners) l();
  }

  // ---- rendering ----
  attachCanvas(canvas: HTMLCanvasElement | null): void {
    if (!canvas) {
      this.canvas = null;
      return;
    }
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    this.canvas = ctx;
    this.image = ctx.createImageData(SCREEN_W, SCREEN_H);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.present();
  }

  setRepel(on: boolean): void {
    this.repel = on;
  }

  setPalette(id: string): void {
    this.palette = packPalette(paletteById(id));
    this.present();
  }

  private present(): void {
    if (!this.canvas || !this.image || !this.pixels) return;
    const f = this.gb.ppu.frame;
    const px = this.pixels;
    const pal = this.palette;
    for (let i = 0; i < f.length; i++) px[i] = pal[f[i]];
    this.canvas.putImageData(this.image, 0, 0);
  }

  // ---- loop ----
  private start(): void {
    this.last = performance.now();
    this.fpsAt = this.last;
    const loop = (now: number) => {
      if (this.destroyed) return;
      this.raf = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.raf = requestAnimationFrame(loop);
    this.sramTimer = window.setInterval(() => void this.persistSram(), 2000);
    this.resumeTimer = window.setInterval(() => void this.saveResume(), 30000);
  }

  private tick(now: number): void {
    let dt = now - this.last;
    this.last = now;
    if (dt > 100) dt = FRAME_MS; // came back from a stall: don't spiral
    if (this.paused || this.hidden) return;
    if (this.grinder) {
      this.tickGrind(now);
      return;
    }
    const apu = this.gb.apu;
    const audioOn = this.speed === 1 && !this.muted && this.audio.ready;
    apu.outputEnabled = audioOn;
    if (audioOn) {
      // Nudge the resample rate to hold ~60ms of audio queued.
      const sr = this.audio.sampleRate;
      const target = sr * 0.06;
      const err = (target - this.audio.buffered) / target;
      apu.sampleRate = sr * (1 + Math.max(-0.006, Math.min(0.006, err * 0.006)));
    }
    this.acc += dt * this.speed;
    const t0 = performance.now();
    let frames = 0;
    while (this.acc >= FRAME_MS) {
      this.emulateFrame();
      this.acc -= FRAME_MS;
      frames++;
      if (++this.frameNo % TRACK_EVERY === 0) this.track();
      if (performance.now() - t0 > 13) {
        this.acc = Math.min(this.acc, FRAME_MS);
        break;
      }
    }
    if (frames > 0) {
      this.present();
      this.fpsFrames += frames;
      if (audioOn) this.flushAudio();
      else apu.clearBuffer();
    }
    if (now - this.fpsAt > 1000) {
      this.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsAt));
      this.fpsFrames = 0;
      this.fpsAt = now;
      if (this.emuFrames > 0) this.emuMs = this.emuTime / this.emuFrames;
      this.emuTime = this.emuFrames = 0;
    }
    if (now - this.publishAt > 250) {
      this.publishAt = now;
      this.expireToasts(now);
      this.publish();
    }
  }

  // ---- auto-grind ----

  /** Why auto-grind can't start right now, or null. */
  grindProblem(targetLevel: number): string | null {
    if (!this.data) return 'Auto-grind works with Pokémon Red, Blue and Yellow.';
    return Grinder.problem(this.gb, this.data, targetLevel);
  }

  startGrind(settings: GrindSettings): string | null {
    const problem = this.grindProblem(settings.targetLevel);
    if (problem || !this.data) return problem;
    for (let i = 0; i < 8; i++) this.gb.setButton(i, false);
    const data = this.data;
    this.grinder = new Grinder(this.gb, data, {
      ...settings,
      handBack: (snap) => this.grindHandBack(snap),
    });
    this.grindEnd = null;
    this.grindStartedAt = performance.now();
    this.paused = false;
    this.acc = 0;
    this.audio.clear();
    void this.keepAwake(true);
    this.publish();
    return null;
  }

  /** Stop the bot. A user stop doesn't pause or show a summary. */
  stopGrind(): void {
    if (!this.grinder) return;
    this.grinder.dispose();
    this.grinder = null;
    void this.keepAwake(false);
    this.publish();
  }

  dismissGrindEnd(): void {
    this.setPaused(false);
  }

  get grinding(): boolean {
    return this.grinder !== null;
  }

  /** A wild battle worth a human: the area's first encounter, or (with no run) a species not caught yet. */
  private grindHandBack(snap: Snapshot): string | null {
    const data = this.data;
    const enemy = snap.enemy;
    if (!data || !enemy) return null;
    const name = data.speciesName(enemy.species);
    if (this.run) {
      const enc = this.run.encounters.find((e) => e.id === this.run?.activeEncounterId);
      return enc?.outcome === 'pending' ? `Wild ${name}: your first encounter on ${enc.area}. It's all yours.` : null;
    }
    const dex = data.species.get(enemy.species)?.dex ?? 0;
    if (dex > 0) {
      const owned = this.gb.peek(data.sym.wPokedexOwned + ((dex - 1) >> 3)) & (1 << ((dex - 1) & 7));
      if (!owned) return `Wild ${name}: you haven't caught one yet.`;
    }
    return null;
  }

  private tickGrind(now: number): void {
    const grinder = this.grinder!;
    this.gb.apu.outputEnabled = false;
    let frames = 0;
    let end: GrindEnd | null = null;
    while (performance.now() - now < GRIND_BUDGET_MS) {
      this.emulateFrame();
      frames++;
      if (++this.frameNo % TRACK_EVERY === 0) this.track();
      end = grinder.step();
      if (end) break;
    }
    this.acc = 0;
    this.gb.apu.clearBuffer();
    this.present();
    this.fpsFrames += frames;
    if (now - this.fpsAt > 1000) {
      this.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsAt));
      this.fpsFrames = 0;
      this.fpsAt = now;
      if (this.emuFrames > 0) this.emuMs = this.emuTime / this.emuFrames;
      this.emuTime = this.emuFrames = 0;
    }
    if (end) {
      this.finishGrind(end);
      return;
    }
    if (now - this.publishAt > 250) {
      this.publishAt = now;
      this.expireToasts(now);
      this.publish();
    }
  }

  private finishGrind(end: GrindEnd): void {
    const p = this.grinder!.getProgress();
    this.grinder!.dispose();
    this.grinder = null;
    void this.keepAwake(false);
    const parts = [p.level > p.startLevel ? `Lv ${p.startLevel} → ${p.level}` : `Lv ${p.level}`, `${p.battles} ${p.battles === 1 ? 'battle' : 'battles'}`];
    const secs = Math.round((performance.now() - this.grindStartedAt) / 1000);
    parts.push(secs < 90 ? `${secs}s` : `${Math.round(secs / 60)} min`);
    this.grindEnd = { ...end, summary: parts.join(' · ') };
    // Freeze on the moment that needs you (an evolution keeps animating otherwise).
    this.paused = true;
    this.audio.clear();
    if ('vibrate' in navigator) navigator.vibrate?.(end.kind === 'done' ? 30 : [30, 60, 30]);
    this.publish();
  }

  /** Hold a screen wake lock while the bot plays, where the browser supports it. */
  private async keepAwake(on: boolean): Promise<void> {
    try {
      if (on && !this.wakeLock) {
        const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release: () => Promise<void> }> } }).wakeLock;
        this.wakeLock = (await wl?.request('screen')) ?? null;
      } else if (!on && this.wakeLock) {
        const lock = this.wakeLock;
        this.wakeLock = null;
        await lock.release();
      }
    } catch {
      this.wakeLock = null;
    }
  }

  private flushAudio(): void {
    const apu = this.gb.apu;
    const n = apu.available();
    if (n === 0) return;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    apu.drain(l, r, n);
    this.audio.push(l, r);
  }

  // ---- tracker ----
  private track(): void {
    if (!this.reader) return;
    const snap = this.reader.read(this.ram);
    if (!snap.valid) return;
    this.snap = snap;
    this.applyRepel();
    const events = this.differ.update(snap);
    if (this.run && this.data) {
      for (const ev of events) {
        const notices = applyEvent(this.run, ev, { data: this.data, snap });
        for (const n of notices) this.toast(n);
        this.runDirty = true;
      }
      syncMons(this.run, snap);
      if (this.run.rules.forceSetMode) {
        const a = SYMBOLS[this.data.version].wOptions - 0xc000;
        this.gb.bus.wram[a] |= 0x40;
      }
      if (events.length) this.scheduleRunSave();
    }
    if (events.length) this.publish();
  }

  /**
   * The game skips wild Pokémon below the lead's level while its repel step
   * counter is above zero, so holding it at 255 is a Repel that never wears off.
   * Turning it off clears the counter only if this session set it.
   */
  private applyRepel(): void {
    if (!this.data) return;
    const a = SYMBOLS[this.data.version].wRepelRemainingSteps - 0xc000;
    if (this.repel) {
      this.gb.bus.wram[a] = 0xff;
      this.repelApplied = true;
    } else if (this.repelApplied) {
      this.gb.bus.wram[a] = 0;
      this.repelApplied = false;
    }
  }

  private toast(n: Notice): void {
    // While the bot plays, the grind chip says what's going on; info notices
    // (no balls yet, dupes, ghosts) would only pile up at turbo speed.
    if (this.grinder && n.tone === 'info') return;
    if (n.once) {
      if (this.shownOnce.has(n.title)) return;
      this.shownOnce.add(n.title);
    }
    const now = performance.now();
    // A repeat of a toast still on screen replaces it rather than stacking.
    const rest = this.toasts.filter((t) => t.title !== n.title || t.body !== n.body);
    this.toasts = [...rest, { ...n, id: ++this.toastId, at: now }].slice(-3);
    if ((n.tone === 'bad' || n.tone === 'good') && 'vibrate' in navigator) navigator.vibrate?.(n.tone === 'bad' ? [40, 60, 40] : 20);
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.publish();
  }

  private expireToasts(now: number): void {
    const keep = this.toasts.filter((t) => now - t.at < (t.tone === 'bad' ? 7000 : 4500));
    if (keep.length !== this.toasts.length) this.toasts = keep;
  }

  // ---- runs ----
  private attachRun(run: Run): void {
    run.rules = { ...DEFAULT_RULES, ...run.rules };
    this.run = run;
    this.differ = new EventDiffer();
    this.differ.seedKnown(Object.keys(run.mons));
  }

  async startRun(name: string, rules: Partial<Rules>): Promise<Run> {
    const run = newRun({ name, romKey: this.rom.key, version: this.data?.version ?? 'unknown', rules });
    this.attachRun(run);
    await db.putRun(run);
    await db.putKv(`activeRun:${this.rom.key}`, run.id);
    this.publish();
    return run;
  }

  async endRun(): Promise<void> {
    if (!this.run) return;
    await db.putRun(this.run);
    await db.putKv(`activeRun:${this.rom.key}`, null);
    this.run = null;
    this.differ = new EventDiffer();
    this.publish();
  }

  /** Apply a manual change to the run (from the UI) and persist it. */
  updateRun(mut: (run: Run) => void): void {
    if (!this.run) return;
    mut(this.run);
    this.run.updatedAt = Date.now();
    this.scheduleRunSave();
    this.publish();
  }

  private scheduleRunSave(): void {
    if (this.runSaveTimer) return;
    this.runSaveTimer = window.setTimeout(() => {
      this.runSaveTimer = 0;
      void this.saveRun();
    }, 800);
  }

  private async saveRun(): Promise<void> {
    if (!this.run) return;
    this.runDirty = false;
    await db.putRun(this.run);
  }

  // ---- input & controls ----
  press(button: number, down: boolean): void {
    // Any button takes over from the bot, or resumes play after it handed back.
    if (this.grinder) {
      if (!down) return;
      this.stopGrind();
    }
    if (down && this.grindEnd) this.dismissGrindEnd();
    this.gb.setButton(button, down);
    if (down) void this.audio.unlock();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.acc = 0;
    this.audio.clear();
    this.publish();
  }

  cycleSpeed(): void {
    const i = SPEEDS.indexOf(this.speed as (typeof SPEEDS)[number]);
    this.setSpeed(SPEEDS[(i + 1) % SPEEDS.length]);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    // Resuming, however it happens, means the hand-back card has been seen.
    if (!p) this.grindEnd = null;
    if (p) this.audio.clear();
    this.last = performance.now();
    this.acc = 0;
    this.publish();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.audio.clear();
    this.publish();
  }

  reset(): void {
    this.stopGrind();
    // Soft reset: power cycle, keeping battery RAM.
    this.gb.reset();
    this.differ.reset();
  }

  // ---- save states ----
  canUseStates(): boolean {
    return !this.run?.rules.noSaveStates;
  }

  async saveSlot(slot: string): Promise<void> {
    if (!this.canUseStates()) throw new Error('Save states are disabled for this run');
    await db.putState({
      key: `${this.rom.key}:${slot}`,
      romKey: this.rom.key,
      slot,
      savedAt: Date.now(),
      state: this.gb.saveState(),
      thumb: this.gb.ppu.frame.slice(),
      runId: this.run?.id ?? null,
    });
  }

  async loadSlot(slot: string): Promise<boolean> {
    if (!this.canUseStates()) throw new Error('Save states are disabled for this run');
    const rec = await db.getState(this.rom.key, slot);
    if (!rec) return false;
    this.stopGrind();
    this.gb.loadState(rec.state);
    this.differ.reset();
    this.differ.seedKnown(Object.keys(this.run?.mons ?? {}));
    this.audio.clear();
    this.present();
    return true;
  }

  // ---- persistence ----
  private async persistSram(): Promise<void> {
    const cart = this.gb.cart;
    if (!cart.ramDirty || cart.ram.length === 0) return;
    cart.ramDirty = false;
    await db.putSram(this.rom.key, cart.ram.slice());
  }

  private async saveResume(): Promise<void> {
    await db.putState({
      key: `${this.rom.key}:resume`,
      romKey: this.rom.key,
      slot: 'resume',
      savedAt: Date.now(),
      state: this.gb.saveState(),
      runId: this.run?.id ?? null,
    });
  }

  async flush(): Promise<void> {
    await Promise.all([this.persistSram(), this.saveResume(), this.run ? db.putRun(this.run) : Promise.resolve()]);
  }

  private handleHide(): void {
    this.hidden = true;
    this.audio.suspend();
    void this.flush();
  }

  private handleShow(): void {
    this.hidden = false;
    // The browser drops wake locks when the page hides.
    if (this.grinder) {
      this.wakeLock = null;
      void this.keepAwake(true);
    }
    this.last = performance.now();
    this.acc = 0;
    this.audio.clear();
    this.audio.resume();
  }

  exportSave(): Blob {
    return new Blob([this.gb.cart.ram.slice()], { type: 'application/octet-stream' });
  }

  async importSave(data: Uint8Array): Promise<void> {
    if (data.length < this.gb.cart.ram.length) throw new Error(`Save file is ${data.length} bytes; expected ${this.gb.cart.ram.length}`);
    this.gb.cart.ram.set(data.subarray(0, this.gb.cart.ram.length));
    await db.putSram(this.rom.key, this.gb.cart.ram.slice());
    await db.deleteState(this.rom.key, 'resume');
    this.reset();
  }

  async destroy(): Promise<void> {
    this.stopGrind();
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.sramTimer);
    clearInterval(this.resumeTimer);
    clearTimeout(this.runSaveTimer);
    document.removeEventListener('visibilitychange', this.onVis);
    window.removeEventListener('pagehide', this.onHide);
    await this.flush();
    void this.audio.ctx?.close();
  }

  get dirty(): boolean {
    return this.runDirty;
  }
}

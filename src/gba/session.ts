// A Game Boy Advance play session: emulator + frame loop + audio + Nuzlocke
// tracker (Gen 3 Pokémon) + persistence. Exposes the same view and methods as
// platform/session.ts, so the play screen works with either.

import type { GrindEnd } from '../bot/grinder.ts';
import { dexOwned, Grinder3, repelCounter } from '../bot/grinder3.ts';
import { Button, Shoulder } from '../core/constants.ts';
import { Gen3Reader, workRam, type Mem } from '../gen3/reader.ts';
import { detectGen3, Gen3Data } from '../gen3/rom.ts';
import { AudioOut } from '../platform/audio.ts';
import { SPEEDS, type GrindSettings, type SessionView } from '../platform/session.ts';
import { db, type RomRecord, type StateRecord } from '../platform/storage.ts';
import { ScreenWake } from '../platform/wake.ts';
import type { Snapshot } from '../run/events.ts';
import { Tracker } from '../run/tracker.ts';
import type { Rules, Run } from '../run/types.ts';
import { AUDIO_RATE, GBA_FPS, GBA_H, GBA_W, Key, type Gba } from './gba.ts';
import { createGba } from './load.ts';
import { RingResampler } from './resample.ts';

/** Button id (Game Boy ids plus L and R) to GBA KEYINPUT bit. */
const KEY_BIT: Record<number, number> = {
  [Button.Right]: Key.Right,
  [Button.Left]: Key.Left,
  [Button.Up]: Key.Up,
  [Button.Down]: Key.Down,
  [Button.A]: Key.A,
  [Button.B]: Key.B,
  [Button.Select]: Key.Select,
  [Button.Start]: Key.Start,
  [Shoulder.L]: Key.L,
  [Shoulder.R]: Key.R,
};

export const THUMB_W = GBA_W / 2;
export const THUMB_H = GBA_H / 2;

const FRAME_MS = 1000 / GBA_FPS;
/** Read the game's state for the tracker every this many frames. */
const TRACK_EVERY = 4;
/**
 * Main-thread time per animation frame we'll spend emulating, at least. At a
 * lower display rate (iOS Low Power Mode caps requestAnimationFrame at 30 Hz)
 * each callback has more time and more frames to run, so the budget grows with it.
 */
const BUDGET_MS = 13;
/** Main-thread time per animation frame spent emulating while auto-grind runs. */
const GRIND_BUDGET_MS = 12;
/**
 * At normal speed, lock to the display when its refresh is within this share
 * of a whole number of GBA frames (60 Hz: 1, 30 Hz: 2): run exactly that many
 * per refresh. The GBA's 59.73 Hz is 0.45% off 60 Hz; the audio rate control
 * absorbs the difference instead of a frame being repeated every few seconds.
 */
const VSYNC_TOLERANCE = 0.02;

export class GbaSession {
  readonly gba: Gba;
  readonly rom: RomRecord;
  readonly system = 'gba' as const;
  /** Gen 3 Pokémon data, or null for other games (which just play). */
  readonly data: Gen3Data | null;
  readonly tracker: Tracker;
  readonly audio = new AudioOut();
  private reader: Gen3Reader | null;
  private mem: Mem;
  private frameNo = 0;
  private resampler = new RingResampler();
  // What the core's sound output was last set to; null means unknown (after a
  // reset or state load, which change the core's flag), so the next tick sets it.
  private audioWasOn: boolean | null = null;

  private canvas: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;

  private keys = 0;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private paused = false;
  private hidden = false;
  private speed = 1;
  private muted = false;
  private fpsFrames = 0;
  private fpsAt = 0;
  private fps = 0;
  private emuTime = 0;
  private emuFrames = 0;
  private emuMs: number | null = null;
  /** The last callback ran out of budget before its drawn frame. */
  private undrawn = false;
  /** Smoothed time between animation frames. */
  private vsyncMs = 0;
  private clockAt = 0;
  /** Endless Repel: keep the game's repel step counter topped up. */
  private repel = false;
  private repelApplied = false;
  private grinder: Grinder3 | null = null;
  private grindEnd: SessionView['grindEnd'] = null;
  private grindStartedAt = 0;
  private readonly wake = new ScreenWake();

  private view: SessionView;
  private listeners = new Set<() => void>();
  private publishAt = 0;
  private sramTimer = 0;
  private resumeTimer = 0;
  private rev = 0;
  private destroyed = false;
  private onHide = () => this.handleHide();
  private onVis = () => (document.visibilityState === 'hidden' ? this.handleHide() : this.handleShow());

  private constructor(rom: RomRecord, sav: Uint8Array | undefined, gba: Gba) {
    this.rom = rom;
    this.gba = gba;
    if (sav && sav.length >= gba.save.length && gba.save.length > 0) gba.save.set(sav.subarray(0, gba.save.length));
    const game = detectGen3(rom.data);
    this.data = game ? new Gen3Data(rom.data, game) : null;
    this.reader = this.data ? new Gen3Reader(this.data) : null;
    this.mem = workRam(gba.ewram, gba.iwram);
    // The game sets its battle flag after the intro transition, so starts need no long hold.
    // While the bot plays, the grind chip says what's going on; info notices would only pile up.
    this.tracker = new Tracker(this.data, rom.key, this.data?.readMilestones() ?? [], () => this.publish(), {
      wildStartDelay: 2,
      mute: (n) => !!this.grinder && n.tone === 'info',
    });
    this.view = this.buildView();
    document.addEventListener('visibilitychange', this.onVis);
    window.addEventListener('pagehide', this.onHide);
  }

  static async open(rom: RomRecord): Promise<GbaSession> {
    const sav = await db.getSram(rom.key);
    const s = new GbaSession(rom, sav, await createGba(rom.data));
    const resume = await db.getState<Uint8Array>(rom.key, 'resume');
    if (resume) {
      try {
        s.gba.loadState(resume.state);
        s.gba.setTime(new Date());
      } catch (err) {
        // A state from an older core: boot from the in-game save instead.
        console.warn('Could not restore resume state', err);
        await db.deleteState(rom.key, 'resume');
      }
    }
    await s.tracker.restore();
    await db.putRom({ ...rom, version: s.data?.version ?? rom.version, lastPlayedAt: Date.now() });
    s.start();
    return s;
  }

  // ---- external store for React ----
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getView = (): SessionView => this.view;

  private buildView(): SessionView {
    return {
      ...this.tracker.view(),
      paused: this.paused,
      speed: this.speed,
      fps: this.fps,
      muted: this.muted,
      version: this.data?.version ?? null,
      grind: this.grinder ? { ...this.grinder.getProgress() } : null,
      grindEnd: this.grindEnd,
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
    canvas.width = GBA_W;
    canvas.height = GBA_H;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    this.canvas = ctx;
    this.image = ctx.createImageData(GBA_W, GBA_H);
    this.present();
  }

  private present(): void {
    if (!this.canvas || !this.image) return;
    this.image.data.set(this.gba.frame);
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
    this.sramTimer = window.setInterval(() => void this.persistSave(), 2000);
    this.resumeTimer = window.setInterval(() => void this.saveResume(), 30000);
  }

  private tick(now: number): void {
    let dt = now - this.last;
    this.last = now;
    if (dt > 100) dt = FRAME_MS; // came back from a stall: don't spiral
    else if (dt > 0) this.vsyncMs = this.vsyncMs ? this.vsyncMs * 0.95 + dt * 0.05 : dt;
    if (this.paused || this.hidden) return;
    const gba = this.gba;
    // The cartridge clock reads whatever the host last set.
    if (now - this.clockAt > 1000) {
      this.clockAt = now;
      gba.setTime(new Date());
    }
    if (this.grinder) {
      this.tickGrind(now);
      return;
    }
    const audioOn = this.speed === 1 && !this.muted && this.audio.ready;
    if (audioOn !== this.audioWasOn) {
      gba.audio = audioOn;
      gba.discardAudio();
      this.resampler.reset();
      this.audioWasOn = audioOn;
    }
    const budget = Math.min(Math.max(BUDGET_MS, this.vsyncMs * 0.8), 40);
    const perRefresh = Math.round(this.vsyncMs / FRAME_MS);
    const locked = this.speed === 1 && perRefresh >= 1 && Math.abs(this.vsyncMs - perRefresh * FRAME_MS) <= perRefresh * FRAME_MS * VSYNC_TOLERANCE;
    let due: number;
    let n: number;
    if (locked) {
      // A whole number of frames per refresh (more after a dropped one), however
      // long the last few frames took: an even cadence doesn't depend on estimates.
      due = Math.min(Math.max(1, Math.round(dt / FRAME_MS)), perRefresh * 3);
      n = due;
      this.acc = 0;
    } else {
      this.acc += dt * this.speed;
      // Frames due now, capped to what fits the time budget at the recent cost per frame.
      due = Math.floor(this.acc / FRAME_MS);
      n = Math.min(due, Math.max(1, Math.floor(budget / Math.max(this.emuMs ?? 1, 0.05))));
    }
    const t0 = performance.now();
    gba.setKeys(this.keys);
    let frames = 0;
    let cost = this.emuMs ?? 0;
    while (frames < n) {
      // Only the frame we show needs drawing. Draw early when another frame
      // won't fit the budget, or when the last callback stopped before drawing,
      // so a slow device never leaves the screen frozen.
      const start = performance.now();
      const draw = frames === n - 1 || this.undrawn || start - t0 + cost > budget;
      gba.render = draw;
      gba.runFrame();
      if (draw) this.undrawn = false;
      cost = performance.now() - start;
      if (!locked) this.acc -= FRAME_MS;
      frames++;
      if (++this.frameNo % TRACK_EVERY === 0) this.track();
      if (performance.now() - t0 > budget) {
        if (!draw) this.undrawn = true;
        break;
      }
    }
    // Falling behind (slow device, or a budget overrun): drop the debt rather than spiral.
    if (!locked && frames < due) this.acc = Math.min(this.acc, FRAME_MS);
    if (frames > 0) {
      this.emuTime += performance.now() - t0;
      this.emuFrames += frames;
      this.present();
      this.fpsFrames += frames;
      if (audioOn) this.flushAudio();
    }
    this.stats(now);
    if (now - this.publishAt > 250) {
      this.publishAt = now;
      this.tracker.expireToasts(now);
      this.publish();
    }
  }

  /** Frames shown per second and the average emulation cost per frame, over the last second. */
  private stats(now: number): void {
    if (now - this.fpsAt <= 1000) return;
    this.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsAt));
    this.fpsFrames = 0;
    this.fpsAt = now;
    if (this.emuFrames > 0) this.emuMs = this.emuTime / this.emuFrames;
    this.emuTime = this.emuFrames = 0;
  }

  // ---- auto-grind ----

  /** Why auto-grind can't start right now, or null. */
  grindProblem(targetLevel: number): string | null {
    if (!this.data) return 'Auto-grind works with Pokémon Ruby, Sapphire, Emerald, FireRed and LeafGreen.';
    return Grinder3.problem(this.mem, this.data, targetLevel);
  }

  startGrind(settings: GrindSettings): string | null {
    const problem = this.grindProblem(settings.targetLevel);
    if (problem || !this.data) return problem;
    this.keys = 0;
    this.gba.setKeys(0);
    this.grinder = new Grinder3(this.mem, this.data, (a, v) => this.gba.x.poke8(a, v), {
      ...settings,
      handBack: (snap) => this.grindHandBack(snap),
    });
    this.grindEnd = null;
    this.grindStartedAt = performance.now();
    this.paused = false;
    this.acc = 0;
    this.clearAudio();
    void this.wake.set(true);
    this.publish();
    return null;
  }

  /** Stop the bot. A user stop doesn't pause or show a summary. */
  stopGrind(): void {
    if (!this.grinder) return;
    this.grinder.dispose();
    this.grinder = null;
    this.gba.setKeys(this.keys);
    this.clearAudio();
    void this.wake.set(false);
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
    const run = this.tracker.run;
    if (run) {
      const enc = run.encounters.find((e) => e.id === run.activeEncounterId);
      return enc?.outcome === 'pending' ? `Wild ${name}: your first encounter on ${enc.area}. It's all yours.` : null;
    }
    return dexOwned(this.mem, data, enemy.species) === false ? `Wild ${name}: you haven't caught one yet.` : null;
  }

  private tickGrind(now: number): void {
    const gba = this.gba;
    const grinder = this.grinder!;
    if (this.audioWasOn !== false) {
      gba.audio = false;
      gba.discardAudio();
      this.resampler.reset();
      this.audioWasOn = false;
    }
    // As many frames as fit the budget at the recent cost per frame; draw the last.
    const n = Math.max(1, Math.floor(GRIND_BUDGET_MS / Math.max(this.emuMs ?? 1, 0.05)));
    const t0 = performance.now();
    let frames = 0;
    let end: GrindEnd | null = null;
    while (frames < n) {
      gba.setKeys(grinder.keys);
      gba.render = frames === n - 1;
      gba.runFrame();
      frames++;
      if (++this.frameNo % TRACK_EVERY === 0) this.track();
      end = grinder.step();
      if (end || performance.now() - t0 > GRIND_BUDGET_MS) break;
    }
    if (end && frames < n) {
      // Stopped before the frame that gets drawn: draw the moment it stopped on.
      gba.setKeys(0);
      gba.render = true;
      gba.runFrame();
    }
    this.acc = 0;
    this.emuTime += performance.now() - t0;
    this.emuFrames += frames;
    this.present();
    this.fpsFrames += frames;
    this.stats(now);
    if (end) {
      this.finishGrind(end);
      return;
    }
    if (now - this.publishAt > 250) {
      this.publishAt = now;
      this.tracker.expireToasts(now);
      this.publish();
    }
  }

  private finishGrind(end: GrindEnd): void {
    const p = this.grinder!.getProgress();
    this.grinder!.dispose();
    this.grinder = null;
    this.gba.setKeys(this.keys);
    void this.wake.set(false);
    const parts = [p.level > p.startLevel ? `Lv ${p.startLevel} → ${p.level}` : `Lv ${p.level}`, `${p.battles} ${p.battles === 1 ? 'battle' : 'battles'}`];
    const secs = Math.round((performance.now() - this.grindStartedAt) / 1000);
    parts.push(secs < 90 ? `${secs}s` : `${Math.round(secs / 60)} min`);
    this.grindEnd = { ...end, summary: parts.join(' · ') };
    // Freeze on the moment that needs you (an evolution keeps animating otherwise).
    this.paused = true;
    this.clearAudio();
    if ('vibrate' in navigator) navigator.vibrate?.(end.kind === 'done' ? 30 : [30, 60, 30]);
    this.publish();
  }

  // ---- tracker ----
  private track(): void {
    if (!this.reader) return;
    const snap = this.reader.read(this.mem);
    if (!snap.valid) return;
    this.applyRepel();
    const changed = this.tracker.observe(snap);
    if (this.tracker.run?.rules.forceSetMode) this.reader.setBattleStyle(this.mem, (a, v) => this.gba.x.poke8(a, v));
    if (changed) this.publish();
  }

  /**
   * The game skips wild Pokémon weaker than your lead while its repel step
   * counter (VAR_REPEL_STEP_COUNT) is above zero, so holding it up is a Repel
   * that never wears off. Turning it off clears the counter only if this session set it.
   */
  private applyRepel(): void {
    if (!this.data) return;
    const a = repelCounter(this.mem, this.data);
    if (a === null) return;
    if (this.repel) {
      if (this.mem.u16(a) < 200) this.gba.x.poke16(a, 250);
      this.repelApplied = true;
    } else if (this.repelApplied) {
      this.gba.x.poke16(a, 0);
      this.repelApplied = false;
    }
  }

  dismissToast(id: number): void {
    this.tracker.dismissToast(id);
    this.publish();
  }

  startRun(name: string, rules: Partial<Rules>): Promise<Run> {
    return this.tracker.startRun(name, rules);
  }

  endRun(): Promise<void> {
    return this.tracker.endRun();
  }

  updateRun(mut: (run: Run) => void): void {
    this.tracker.updateRun(mut);
  }

  // Game Boy only (palettes).
  setPalette(_id: string): void {}

  setRepel(on: boolean): void {
    this.repel = on;
  }

  private flushAudio(): void {
    const x = this.gba.x;
    const read = x.audio_read_pos();
    const write = x.audio_write_pos();
    if (read === write) return;
    // Nudge the output rate to hold ~60ms of audio queued. Locked to a 60 Hz
    // display the core runs 0.45% fast; this settles that at about 80ms.
    const sr = this.audio.sampleRate;
    const target = sr * 0.06;
    const err = (target - this.audio.buffered) / target;
    const outRate = sr * (1 + Math.max(-0.006, Math.min(0.006, err * 0.012)));
    const { l, r } = this.resampler.drain(this.gba.audioRing, read, write, AUDIO_RATE / outRate);
    x.audio_set_read_pos(write);
    if (l.length) this.audio.push(l, r);
  }

  private clearAudio(): void {
    this.audio.clear();
    this.gba.discardAudio();
    this.resampler.reset();
    this.audioWasOn = null;
  }

  // ---- input & controls ----
  press(button: number, down: boolean): void {
    // Any button takes over from the bot, or resumes play after it handed back.
    if (this.grinder) {
      if (!down) return;
      this.stopGrind();
    }
    if (down && this.grindEnd) this.dismissGrindEnd();
    const bit = KEY_BIT[button];
    if (bit === undefined) return;
    this.keys = down ? this.keys | bit : this.keys & ~bit;
    this.gba.setKeys(this.keys);
    if (down) void this.audio.unlock();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.acc = 0;
    this.clearAudio();
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
    if (p) this.clearAudio();
    this.last = performance.now();
    this.acc = 0;
    this.publish();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.clearAudio();
    this.publish();
  }

  /** Power cycle, keeping the in-game save. */
  reset(): void {
    this.stopGrind();
    this.gba.reset();
    this.gba.setTime(new Date());
    this.tracker.resync();
    this.clearAudio();
    this.present();
  }

  // ---- save states ----
  /** Half-size RGBA copy of the screen. */
  private thumb(): Uint8Array {
    const f = this.gba.frame;
    const src = new Uint32Array(f.buffer, f.byteOffset, GBA_W * GBA_H);
    const out = new Uint32Array(THUMB_W * THUMB_H);
    for (let y = 0; y < THUMB_H; y++) for (let x = 0; x < THUMB_W; x++) out[y * THUMB_W + x] = src[y * 2 * GBA_W + x * 2];
    return new Uint8Array(out.buffer);
  }

  canUseStates(): boolean {
    return !this.tracker.run?.rules.noSaveStates;
  }

  async saveSlot(slot: string): Promise<void> {
    if (!this.canUseStates()) throw new Error('Save states are disabled for this run');
    await db.putState({
      key: `${this.rom.key}:${slot}`,
      romKey: this.rom.key,
      slot,
      savedAt: Date.now(),
      state: this.gba.saveState(),
      thumb: this.thumb(),
      runId: this.tracker.run?.id ?? null,
    });
  }

  /** Throws with a readable message if the slot holds a state this core can't load. */
  async loadSlot(slot: string): Promise<boolean> {
    if (!this.canUseStates()) throw new Error('Save states are disabled for this run');
    const rec = await db.getState<Uint8Array>(this.rom.key, slot);
    if (!rec) return false;
    this.stopGrind();
    this.gba.loadState(rec.state);
    this.gba.setTime(new Date());
    this.tracker.resync();
    this.clearAudio();
    this.present();
    return true;
  }

  listSlots(): Promise<StateRecord<Uint8Array>[]> {
    return db.listStates<Uint8Array>(this.rom.key);
  }

  // ---- persistence ----
  private async persistSave(): Promise<void> {
    const g = this.gba;
    if (!g.saveDirty || g.save.length === 0) return;
    g.saveDirty = false;
    await db.putSram(this.rom.key, g.save.slice());
  }

  private async saveResume(): Promise<void> {
    await db.putState({
      key: `${this.rom.key}:resume`,
      romKey: this.rom.key,
      slot: 'resume',
      savedAt: Date.now(),
      state: this.gba.saveState(),
      runId: this.tracker.run?.id ?? null,
    });
  }

  async flush(): Promise<void> {
    await Promise.all([this.persistSave(), this.saveResume(), this.tracker.save()]);
  }

  private handleHide(): void {
    this.hidden = true;
    this.audio.suspend();
    void this.flush();
  }

  private handleShow(): void {
    this.hidden = false;
    // The browser drops wake locks when the page hides.
    if (this.grinder) this.wake.reacquire();
    this.last = performance.now();
    this.acc = 0;
    this.clearAudio();
    this.audio.resume();
  }

  get hasSave(): boolean {
    return this.gba.save.length > 0;
  }

  exportSave(): Blob {
    return new Blob([this.gba.save.slice()], { type: 'application/octet-stream' });
  }

  async importSave(data: Uint8Array): Promise<void> {
    const len = this.gba.save.length;
    if (len === 0) throw new Error("This game doesn't use a save chip Lockstep supports");
    // Other emulators may append extra bytes (e.g. an RTC footer); they're ignored.
    if (data.length < len) throw new Error(`Save file is ${data.length} bytes; expected ${len}`);
    this.gba.save.set(data.subarray(0, len));
    await db.putSram(this.rom.key, this.gba.save.slice());
    await db.deleteState(this.rom.key, 'resume');
    this.reset();
  }

  async destroy(): Promise<void> {
    this.stopGrind();
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.sramTimer);
    clearInterval(this.resumeTimer);
    this.tracker.dispose();
    document.removeEventListener('visibilitychange', this.onVis);
    window.removeEventListener('pagehide', this.onHide);
    await this.flush();
    void this.audio.ctx?.close();
  }
}

// A Game Boy Advance play session: emulator + frame loop + audio + persistence.
// No tracker: GBA games just play. Mirrors the shape of platform/session.ts so
// the shared controls work with either.

import { Button, Shoulder } from '../core/constants.ts';
import { AudioOut } from '../platform/audio.ts';
import { SPEEDS } from '../platform/session.ts';
import { db, type RomRecord, type StateRecord } from '../platform/storage.ts';
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

export interface GbaView {
  paused: boolean;
  speed: number;
  fps: number;
  muted: boolean;
  /** Average milliseconds of emulation per frame (last second), or null before a sample. */
  emuMs: number | null;
  rev: number;
}

const FRAME_MS = 1000 / GBA_FPS;
/** Main-thread time per animation frame we'll spend emulating. */
const BUDGET_MS = 13;

export class GbaSession {
  readonly gba: Gba;
  readonly rom: RomRecord;
  readonly audio = new AudioOut();
  private resampler = new RingResampler();
  private audioWasOn = false;

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
  private clockAt = 0;

  private view: GbaView;
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
    await db.putRom({ ...rom, lastPlayedAt: Date.now() });
    s.start();
    return s;
  }

  // ---- external store for React ----
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getView = (): GbaView => this.view;

  private buildView(): GbaView {
    return { paused: this.paused, speed: this.speed, fps: this.fps, muted: this.muted, emuMs: this.emuMs, rev: this.rev };
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
    if (this.paused || this.hidden) return;
    const gba = this.gba;
    // The cartridge clock reads whatever the host last set.
    if (now - this.clockAt > 1000) {
      this.clockAt = now;
      gba.setTime(new Date());
    }
    const audioOn = this.speed === 1 && !this.muted && this.audio.ready;
    if (audioOn !== this.audioWasOn) {
      gba.audio = audioOn;
      gba.discardAudio();
      this.resampler.reset();
      this.audioWasOn = audioOn;
    }
    this.acc += dt * this.speed;
    // Frames due now, capped to what fits the time budget at the recent cost per frame.
    const due = Math.floor(this.acc / FRAME_MS);
    const n = Math.min(due, Math.max(1, Math.floor(BUDGET_MS / Math.max(this.emuMs ?? 1, 0.05))));
    const t0 = performance.now();
    gba.setKeys(this.keys);
    let frames = 0;
    while (frames < n) {
      // Only the frame we show needs drawing.
      gba.render = frames === n - 1;
      gba.runFrame();
      this.acc -= FRAME_MS;
      frames++;
      if (performance.now() - t0 > BUDGET_MS) break;
    }
    // Falling behind (slow device, or a budget overrun): drop the debt rather than spiral.
    if (frames < due) this.acc = Math.min(this.acc, FRAME_MS);
    if (frames > 0) {
      this.emuTime += performance.now() - t0;
      this.emuFrames += frames;
      this.present();
      this.fpsFrames += frames;
      if (audioOn) this.flushAudio();
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
      this.publish();
    }
  }

  private flushAudio(): void {
    const x = this.gba.x;
    const read = x.audio_read_pos();
    const write = x.audio_write_pos();
    if (read === write) return;
    // Nudge the output rate to hold ~60ms of audio queued.
    const sr = this.audio.sampleRate;
    const target = sr * 0.06;
    const err = (target - this.audio.buffered) / target;
    const outRate = sr * (1 + Math.max(-0.006, Math.min(0.006, err * 0.006)));
    const { l, r } = this.resampler.drain(this.gba.audioRing, read, write, AUDIO_RATE / outRate);
    x.audio_set_read_pos(write);
    if (l.length) this.audio.push(l, r);
  }

  private clearAudio(): void {
    this.audio.clear();
    this.gba.discardAudio();
    this.resampler.reset();
  }

  // ---- input & controls ----
  press(button: number, down: boolean): void {
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
    this.gba.reset();
    this.gba.setTime(new Date());
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

  async saveSlot(slot: string): Promise<void> {
    await db.putState({
      key: `${this.rom.key}:${slot}`,
      romKey: this.rom.key,
      slot,
      savedAt: Date.now(),
      state: this.gba.saveState(),
      thumb: this.thumb(),
    });
  }

  /** Throws with a readable message if the slot holds a state this core can't load. */
  async loadSlot(slot: string): Promise<boolean> {
    const rec = await db.getState<Uint8Array>(this.rom.key, slot);
    if (!rec) return false;
    this.gba.loadState(rec.state);
    this.gba.setTime(new Date());
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
    });
  }

  async flush(): Promise<void> {
    await Promise.all([this.persistSave(), this.saveResume()]);
  }

  private handleHide(): void {
    this.hidden = true;
    this.audio.suspend();
    void this.flush();
  }

  private handleShow(): void {
    this.hidden = false;
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
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.sramTimer);
    clearInterval(this.resumeTimer);
    document.removeEventListener('visibilitychange', this.onVis);
    window.removeEventListener('pagehide', this.onHide);
    await this.flush();
    void this.audio.ctx?.close();
  }
}

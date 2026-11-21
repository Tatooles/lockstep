// Game Boy Advance core: a thin wrapper over the Rust core in wasm-gba/,
// compiled to lockstep_gba.wasm. The caller compiles the module (Node:
// readFileSync + new WebAssembly.Module; browser: src/gba/load.ts) and hands
// it over.

export const GBA_W = 240;
export const GBA_H = 160;
/** 16.78 MHz / 280896 cycles per frame. */
export const GBA_FPS = 16777216 / 280896;

/** KEYINPUT bits, active high. */
export const Key = {
  A: 1,
  B: 2,
  Select: 4,
  Start: 8,
  Right: 16,
  Left: 32,
  Up: 64,
  Down: 128,
  R: 256,
  L: 512,
} as const;

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  init(ptr: number, len: number): void;
  reset(): void;
  run_frame(): number;
  frame_ptr(): number;
  set_keys(mask: number): void;
  cycles(): number;
  idle_cycles(): number;
  reg(i: number): number;
  set_reg(i: number, v: number): void;
  hook_add(addr: number): number;
  hook_clear(): void;
  hook_hit(): number;
  peek8(a: number): number;
  peek16(a: number): number;
  peek32(a: number): number;
  poke8(a: number, v: number): void;
  poke16(a: number, v: number): void;
  poke32(a: number, v: number): void;
  ewram_ptr(): number;
  iwram_ptr(): number;
  vram_ptr(): number;
  palette_ptr(): number;
  oam_ptr(): number;
  save_ptr(): number;
  save_len(): number;
  save_dirty(): number;
  set_save_dirty(v: number): void;
  set_time(unixLocal: number): void;
  set_audio(enabled: number): void;
  audio_ptr(): number;
  audio_write_pos(): number;
  audio_read_pos(): number;
  audio_set_read_pos(p: number): void;
  state_version(): number;
  state_size(): number;
  state_ptr(): number;
  save_state(): void;
  load_state(): void;
  set_render(enabled: number): void;
}

/** Floats in the core's audio ring: interleaved stereo at AUDIO_RATE. */
export const AUDIO_LEN = 16384;
export const AUDIO_RATE = 32768;

/** Save states start with "LGBA", the core's state version, the machine size and the game's header. */
const STATE_MAGIC = 0x4142474c;
const STATE_HEADER = 20;

export const RUN_FRAME_DONE = 0;
export const RUN_HOOK = 1;

export class Gba {
  /** RGBA8888, 240×160. */
  readonly frame: Uint8ClampedArray;
  /** 256 KB on-board work RAM (0x02000000), writable in place. */
  readonly ewram: Uint8Array;
  /** 32 KB on-chip work RAM (0x03000000), writable in place. */
  readonly iwram: Uint8Array;
  /** Cartridge save (Flash or SRAM), writable in place. */
  readonly save: Uint8Array;
  /** The core's audio ring (see AUDIO_LEN). */
  readonly audioRing: Float32Array;
  readonly x: Exports;
  private readonly romId: Uint8Array;

  static async create(module: WebAssembly.Module, rom: Uint8Array): Promise<Gba> {
    return new Gba(await WebAssembly.instantiate(module, {}), rom);
  }

  static createSync(module: WebAssembly.Module, rom: Uint8Array): Gba {
    return new Gba(new WebAssembly.Instance(module, {}), rom);
  }

  private constructor(inst: WebAssembly.Instance, rom: Uint8Array) {
    const x = inst.exports as unknown as Exports;
    this.x = x;
    const p = x.alloc(rom.length);
    new Uint8Array(x.memory.buffer, p, rom.length).set(rom);
    x.init(p, rom.length);
    const buf = x.memory.buffer;
    this.frame = new Uint8ClampedArray(buf, x.frame_ptr(), GBA_W * GBA_H * 4);
    this.ewram = new Uint8Array(buf, x.ewram_ptr(), 0x40000);
    this.iwram = new Uint8Array(buf, x.iwram_ptr(), 0x8000);
    this.save = new Uint8Array(buf, x.save_ptr(), x.save_len());
    this.audioRing = new Float32Array(buf, x.audio_ptr(), AUDIO_LEN);
    // Game code, maker code, version and header checksum.
    this.romId = Uint8Array.of(...rom.subarray(0xac, 0xb2), rom[0xbc], rom[0xbd]);
    this.setTime(new Date());
  }

  /** Run to the next VBlank. Returns RUN_HOOK if a hook address was reached first (call again to continue). */
  runFrame(): number {
    return this.x.run_frame();
  }

  setKeys(mask: number): void {
    this.x.set_keys(mask);
  }

  /** Stop `runFrame` before the CPU executes `addr`. */
  addHook(addr: number): void {
    this.x.hook_add(addr);
  }

  clearHooks(): void {
    this.x.hook_clear();
  }

  get hookHit(): number {
    return this.x.hook_hit() >>> 0;
  }

  /** r0..r14, 15 = address of the next instruction, 16 = CPSR. */
  reg(i: number): number {
    return this.x.reg(i) >>> 0;
  }

  read8(a: number): number {
    return this.x.peek8(a);
  }

  read16(a: number): number {
    return this.x.peek16(a);
  }

  read32(a: number): number {
    return this.x.peek32(a) >>> 0;
  }

  write8(a: number, v: number): void {
    this.x.poke8(a, v);
  }

  write16(a: number, v: number): void {
    this.x.poke16(a, v);
  }

  write32(a: number, v: number): void {
    this.x.poke32(a, v);
  }

  get cycles(): number {
    return this.x.cycles();
  }

  /** Cycles the CPU spent halted or in a detected idle loop. */
  get idleCycles(): number {
    return this.x.idle_cycles();
  }

  set render(on: boolean) {
    this.x.set_render(on ? 1 : 0);
  }

  set audio(on: boolean) {
    this.x.set_audio(on ? 1 : 0);
  }

  /** Wall-clock time for the cartridge RTC (Ruby/Sapphire/Emerald). */
  setTime(d: Date): void {
    this.x.set_time(d.getTime() / 1000 - d.getTimezoneOffset() * 60);
  }

  get saveDirty(): boolean {
    return this.x.save_dirty() === 1;
  }

  set saveDirty(d: boolean) {
    this.x.set_save_dirty(d ? 1 : 0);
  }

  reset(): void {
    this.x.reset();
  }

  /** Drop queued audio, e.g. after it was off or the game was paused. */
  discardAudio(): void {
    this.x.audio_set_read_pos(this.x.audio_write_pos());
  }

  /** A copy of the whole machine, behind a header naming the core version and the game. */
  saveState(): Uint8Array {
    const x = this.x;
    x.save_state();
    const size = x.state_size();
    const out = new Uint8Array(STATE_HEADER + size);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, STATE_MAGIC, true);
    dv.setUint32(4, x.state_version(), true);
    dv.setUint32(8, size, true);
    out.set(this.romId, 12);
    out.set(new Uint8Array(x.memory.buffer, x.state_ptr(), size), STATE_HEADER);
    return out;
  }

  /** Throws (leaving the machine untouched) if the state is from another core version or game. */
  loadState(state: Uint8Array): void {
    const x = this.x;
    const size = x.state_size();
    if (state.length < STATE_HEADER) throw new Error('Not a save state');
    const dv = new DataView(state.buffer, state.byteOffset, state.byteLength);
    if (dv.getUint32(0, true) !== STATE_MAGIC) throw new Error('Not a Game Boy Advance save state');
    if (dv.getUint32(4, true) !== x.state_version() || dv.getUint32(8, true) !== size || state.length !== STATE_HEADER + size) {
      throw new Error('This save state is from an older version of Lockstep and can no longer be loaded');
    }
    if (!this.romId.every((b, i) => b === state[12 + i])) throw new Error('This save state is for a different game');
    new Uint8Array(x.memory.buffer, x.state_ptr(), size).set(state.subarray(STATE_HEADER));
    x.load_state();
  }
}

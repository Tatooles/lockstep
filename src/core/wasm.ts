// The Rust core (wasm-core/) behind the Emulator interface. Environment
// agnostic: the caller compiles lockstep_core.wasm and hands over the module.

import { parseHeader, type CartHeader } from './cart.ts';
import { SCREEN_H, SCREEN_W } from './constants.ts';
import { checkState, STATE_VERSION, type Emulator, type SaveState } from './emulator.ts';

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  init(ptr: number, len: number): void;
  reset(): void;
  run_frame(): void;
  step(): void;
  mcycles(): number;
  reg(i: number): number;
  peek(addr: number): number;
  poke(addr: number, v: number): void;
  set_button(id: number, down: number): void;
  frame_ptr(): number;
  wram_ptr(): number;
  hram_ptr(): number;
  vram_ptr(): number;
  oam_ptr(): number;
  cart_ram_ptr(): number;
  cart_ram_len(): number;
  cart_ram_dirty(): number;
  set_cart_ram_dirty(v: number): void;
  rom_bank(): number;
  set_audio(enabled: number, sampleRate: number): void;
  audio_ptr(): number;
  audio_write_pos(): number;
  audio_read_pos(): number;
  audio_set_read_pos(p: number): void;
  audio_clear(): void;
  state_nums_ptr(): number;
  state_bytes_ptr(): number;
  save_state(): void;
  load_state(): void;
}

interface Hooks {
  serial: ((b: number) => void) | null;
}

const AUDIO_LEN = 16384;
// Layout of the save-state scratch areas (see wasm-core/src/lib.rs).
const NUMS = 66;
const CPU = [0, 15];
const BUS = [15, 27];
const PPU = [27, 44];
const TIMER = [44, 50];
const CART = [50, 55];
const RTC = [55, 64];
const APU_POWER = 64;
const HAS_RTC = 65;

function imports(hooks: Hooks): WebAssembly.Imports {
  return {
    env: {
      now_ms: () => Date.now(),
      serial_byte: (b: number) => hooks.serial?.(b),
    },
  };
}

/** Views over Wasm memory. Valid for the instance's lifetime: the core allocates only at init. */
interface Views {
  frame: Uint8Array;
  wram: Uint8Array;
  hram: Uint8Array;
  vram: Uint8Array;
  oam: Uint8Array;
  cartRam: Uint8Array;
  audio: Float32Array;
  nums: Float64Array;
  bytes: Uint8Array;
}

export class WasmGameBoy implements Emulator {
  readonly cart: Emulator['cart'];
  readonly bus: Emulator['bus'] & { readonly mcycles: number; onSerialByte: ((b: number) => void) | null };
  readonly cpu: {
    readonly a: number;
    readonly f: number;
    readonly b: number;
    readonly c: number;
    readonly d: number;
    readonly e: number;
    readonly h: number;
    readonly l: number;
    readonly sp: number;
    readonly pc: number;
    readonly halted: boolean;
    step(): void;
  };
  readonly ppu: Emulator['ppu'];
  readonly apu: Emulator['apu'];
  private readonly x: Exports;
  private readonly v: Views;
  private readonly header: CartHeader;

  /** Instantiate asynchronously (required on browser main threads for modules over 4 KB). */
  static async create(module: WebAssembly.Module, rom: Uint8Array): Promise<WasmGameBoy> {
    const hooks: Hooks = { serial: null };
    const inst = await WebAssembly.instantiate(module, imports(hooks));
    return new WasmGameBoy(inst, rom, hooks);
  }

  /** Synchronous instantiation, for Node tools and workers. */
  static createSync(module: WebAssembly.Module, rom: Uint8Array): WasmGameBoy {
    const hooks: Hooks = { serial: null };
    return new WasmGameBoy(new WebAssembly.Instance(module, imports(hooks)), rom, hooks);
  }

  private constructor(inst: WebAssembly.Instance, rom: Uint8Array, hooks: Hooks) {
    const x = inst.exports as unknown as Exports;
    this.x = x;
    this.header = parseHeader(rom);
    const p = x.alloc(rom.length);
    new Uint8Array(x.memory.buffer, p, rom.length).set(rom);
    x.init(p, rom.length);
    const buf = x.memory.buffer;
    const v: Views = {
      frame: new Uint8Array(buf, x.frame_ptr(), SCREEN_W * SCREEN_H),
      wram: new Uint8Array(buf, x.wram_ptr(), 0x2000),
      hram: new Uint8Array(buf, x.hram_ptr(), 0x7f),
      vram: new Uint8Array(buf, x.vram_ptr(), 0x2000),
      oam: new Uint8Array(buf, x.oam_ptr(), 0xa0),
      cartRam: new Uint8Array(buf, x.cart_ram_ptr(), x.cart_ram_len()),
      audio: new Float32Array(buf, x.audio_ptr(), AUDIO_LEN),
      nums: new Float64Array(buf, x.state_nums_ptr(), NUMS),
      bytes: new Uint8Array(buf, x.state_bytes_ptr(), 0x40),
    };
    this.v = v;
    const header = this.header;

    this.cart = {
      header,
      ram: v.cartRam,
      get ramDirty() {
        return x.cart_ram_dirty() === 1;
      },
      set ramDirty(d: boolean) {
        x.set_cart_ram_dirty(d ? 1 : 0);
      },
      get currentRomBank() {
        return x.rom_bank();
      },
    };
    this.bus = {
      wram: v.wram,
      read: (addr) => x.peek(addr & 0xffff),
      write: (addr, val) => x.poke(addr & 0xffff, val & 0xff),
      get mcycles() {
        return x.mcycles();
      },
      get onSerialByte() {
        return hooks.serial;
      },
      set onSerialByte(fn) {
        hooks.serial = fn;
      },
    };
    this.cpu = {
      get a() { return x.reg(0); },
      get f() { return x.reg(1); },
      get b() { return x.reg(2); },
      get c() { return x.reg(3); },
      get d() { return x.reg(4); },
      get e() { return x.reg(5); },
      get h() { return x.reg(6); },
      get l() { return x.reg(7); },
      get sp() { return x.reg(8); },
      get pc() { return x.reg(9); },
      get halted() { return x.reg(10) === 1; },
      step: () => x.step(),
    };
    this.ppu = { frame: v.frame };

    let outputEnabled = true;
    let sampleRate = 48000;
    this.apu = {
      get outputEnabled() {
        return outputEnabled;
      },
      set outputEnabled(on: boolean) {
        if (on === outputEnabled) return;
        outputEnabled = on;
        x.set_audio(on ? 1 : 0, sampleRate);
      },
      get sampleRate() {
        return sampleRate;
      },
      set sampleRate(sr: number) {
        if (sr === sampleRate) return;
        sampleRate = sr;
        x.set_audio(outputEnabled ? 1 : 0, sr);
      },
      available: () => ((x.audio_write_pos() - x.audio_read_pos() + AUDIO_LEN) % AUDIO_LEN) >> 1,
      drain: (left, right, frames) => {
        const buf = v.audio;
        const w = x.audio_write_pos();
        let r = x.audio_read_pos();
        let i = 0;
        while (i < frames && r !== w) {
          left[i] = buf[r];
          right[i] = buf[r + 1];
          r = (r + 2) % AUDIO_LEN;
          i++;
        }
        x.audio_set_read_pos(r);
        return i;
      },
      clearBuffer: () => x.audio_clear(),
    };
  }

  runFrame(): void {
    this.x.run_frame();
  }

  setButton(id: number, down: boolean): void {
    this.x.set_button(id, down ? 1 : 0);
  }

  peek(addr: number): number {
    return this.x.peek(addr & 0xffff);
  }

  reset(): void {
    this.x.reset();
  }

  saveState(): SaveState {
    const { x, v } = this;
    x.save_state();
    const n = v.nums;
    const nums = ([a, b]: number[]) => Array.from(n.subarray(a, b));
    return {
      version: STATE_VERSION,
      title: this.header.title,
      globalChecksum: this.header.globalChecksum,
      cpu: nums(CPU),
      bus: { wram: v.wram.slice(), hram: v.hram.slice(), regs: nums(BUS) },
      ppu: { vram: v.vram.slice(), oam: v.oam.slice(), regs: nums(PPU) },
      apu: { regs: v.bytes.slice(0, 0x30), wave: v.bytes.slice(0x30, 0x40), power: n[APU_POWER] === 1 },
      timer: nums(TIMER),
      cart: { ram: v.cartRam.slice(), regs: nums(CART), rtc: nums(RTC) },
    };
  }

  loadState(s: SaveState): void {
    checkState(s, this.header);
    const { x, v } = this;
    const n = v.nums;
    const put = ([a, b]: number[], src: number[] | undefined) => {
      for (let i = a; i < b; i++) n[i] = src?.[i - a] ?? 0;
    };
    put(CPU, s.cpu);
    put(BUS, s.bus.regs);
    put(PPU, s.ppu.regs);
    put(TIMER, s.timer);
    put(CART, s.cart.regs);
    put(RTC, s.cart.rtc);
    n[APU_POWER] = s.apu.power ? 1 : 0;
    n[HAS_RTC] = s.cart.rtc ? 1 : 0;
    v.bytes.fill(0);
    v.bytes.set(s.apu.regs.subarray(0, 0x30));
    v.bytes.set(s.apu.wave.subarray(0, 0x10), 0x30);
    v.wram.set(s.bus.wram);
    v.hram.set(s.bus.hram);
    v.vram.set(s.ppu.vram);
    v.oam.set(s.ppu.oam);
    v.cartRam.set(s.cart.ram.subarray(0, v.cartRam.length));
    x.load_state();
  }
}

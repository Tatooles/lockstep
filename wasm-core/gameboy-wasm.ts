// Loads the Rust/Wasm core and wraps it in the subset of the GameBoy API the
// tools use (runFrame, ppu.frame, cpu registers, peek, serial, audio toggle).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  init(ptr: number, len: number): void;
  run_frame(): void;
  step(): void;
  frame_ptr(): number;
  wram_ptr(): number;
  mcycles(): number;
  reg(i: number): number;
  peek(addr: number): number;
  set_button(id: number, down: number): void;
  set_audio(enabled: number, sampleRate: number): void;
  audio_ptr(): number;
  audio_write_pos(): number;
  audio_read_pos(): number;
  audio_set_read_pos(p: number): void;
}

const WASM = join(import.meta.dirname, 'target/wasm32-unknown-unknown/release/lockstep_core.wasm');
let module: WebAssembly.Module | null = null;

export class WasmGameBoy {
  private x: Exports;
  private sampleRate = 48000;
  onSerial: ((b: number) => void) | null = null;
  /** 160x144 shade indices (0-3), a live view into Wasm memory. */
  readonly frame: Uint8Array;
  /** 8 KiB work RAM, a live view into Wasm memory (writable). */
  readonly wram: Uint8Array;
  readonly audio: Float32Array;

  constructor(rom: Uint8Array) {
    module ??= new WebAssembly.Module(readFileSync(WASM));
    const inst = new WebAssembly.Instance(module, {
      env: {
        now_ms: () => Date.now(),
        serial_byte: (b: number) => this.onSerial?.(b),
      },
    });
    this.x = inst.exports as unknown as Exports;
    const p = this.x.alloc(rom.length);
    new Uint8Array(this.x.memory.buffer, p, rom.length).set(rom);
    this.x.init(p, rom.length);
    // Memory doesn't grow after init, so these views stay valid.
    const buf = this.x.memory.buffer;
    this.frame = new Uint8Array(buf, this.x.frame_ptr(), 160 * 144);
    this.wram = new Uint8Array(buf, this.x.wram_ptr(), 0x2000);
    this.audio = new Float32Array(buf, this.x.audio_ptr(), 16384);
  }

  runFrame(): void {
    this.x.run_frame();
  }

  step(): void {
    this.x.step();
  }

  peek(addr: number): number {
    return this.x.peek(addr & 0xffff);
  }

  setButton(id: number, down: boolean): void {
    this.x.set_button(id, down ? 1 : 0);
  }

  get mcycles(): number {
    return this.x.mcycles();
  }

  /** a f b c d e h l sp pc halted */
  reg(i: number): number {
    return this.x.reg(i);
  }

  set outputEnabled(on: boolean) {
    this.x.set_audio(on ? 1 : 0, this.sampleRate);
  }

  /** Stereo frames buffered in the ring. */
  audioAvailable(): number {
    const n = 16384;
    return ((this.x.audio_write_pos() - this.x.audio_read_pos() + n) % n) >> 1;
  }

  /** Drain buffered audio as interleaved stereo samples. */
  drainAudio(): Float32Array {
    const w = this.x.audio_write_pos();
    let r = this.x.audio_read_pos();
    const out: number[] = [];
    while (r !== w) {
      out.push(this.audio[r], this.audio[r + 1]);
      r = (r + 2) % 16384;
    }
    this.x.audio_set_read_pos(r);
    return Float32Array.from(out);
  }
}

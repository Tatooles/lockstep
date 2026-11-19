// What the app needs from an emulator core. Two cores implement it: the
// TypeScript GameBoy (gameboy.ts) and the Rust core compiled to Wasm (wasm.ts).
// Both read and write the same SaveState, so states move freely between them.

import type { CartHeader, CartState } from './cart.ts';
import type { PpuState } from './ppu.ts';

export const STATE_VERSION = 1;

export interface SaveState {
  version: number;
  title: string;
  globalChecksum: number;
  cpu: number[];
  bus: { wram: Uint8Array; hram: Uint8Array; regs: number[] };
  ppu: PpuState;
  apu: { regs: Uint8Array; wave: Uint8Array; power: boolean };
  timer: number[];
  cart: CartState;
}

export type CoreKind = 'wasm' | 'ts';

export interface Emulator {
  readonly cart: {
    readonly header: CartHeader;
    /** Battery RAM. Writable in place; its length never changes. */
    readonly ram: Uint8Array;
    /** Set whenever battery RAM is written; the host clears it after persisting. */
    ramDirty: boolean;
    readonly currentRomBank: number;
  };
  readonly bus: {
    /** Work RAM, writable in place. */
    readonly wram: Uint8Array;
    read(addr: number): number;
    write(addr: number, val: number): void;
  };
  readonly cpu: { readonly pc: number; readonly sp: number };
  readonly ppu: {
    /** Final shades (0 = lightest .. 3 = darkest), one byte per pixel. */
    readonly frame: Uint8Array;
  };
  readonly apu: {
    outputEnabled: boolean;
    sampleRate: number;
    /** Stereo frames buffered. */
    available(): number;
    drain(left: Float32Array, right: Float32Array, frames: number): number;
    clearBuffer(): void;
  };
  /** Run until the next VBlank (or one frame's worth of cycles if the LCD is off). */
  runFrame(): void;
  setButton(id: number, down: boolean): void;
  /** Side-effect-free memory read. */
  peek(addr: number): number;
  saveState(): SaveState;
  loadState(s: SaveState): void;
  /** Power cycle, keeping battery RAM. */
  reset(): void;
}

/** Throws if a state can't be loaded into this cartridge. */
export function checkState(s: SaveState, header: CartHeader): void {
  if (s.version !== STATE_VERSION) throw new Error('Incompatible save state version');
  if (s.globalChecksum !== header.globalChecksum) throw new Error('Save state is for a different ROM');
}

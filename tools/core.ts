// The emulator core for Node tools: compiles src/core/lockstep_core.wasm once.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GameBoy } from '../src/core/gameboy.ts';

const WASM_PATH = join(import.meta.dirname, '..', 'src', 'core', 'lockstep_core.wasm');
let module: WebAssembly.Module | null = null;

export function gameBoy(rom: Uint8Array): GameBoy {
  module ??= new WebAssembly.Module(readFileSync(WASM_PATH));
  return GameBoy.createSync(module, rom);
}

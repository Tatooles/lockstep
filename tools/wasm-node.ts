// The Rust/Wasm core for Node tools: compiles src/core/lockstep_core.wasm once.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WasmGameBoy } from '../src/core/wasm.ts';

export const WASM_PATH = join(import.meta.dirname, '..', 'src', 'core', 'lockstep_core.wasm');
let module: WebAssembly.Module | null = null;

export function wasmGameBoy(rom: Uint8Array): WasmGameBoy {
  module ??= new WebAssembly.Module(readFileSync(WASM_PATH));
  return WasmGameBoy.createSync(module, rom);
}

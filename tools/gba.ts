// The GBA core for Node tools: compiles src/gba/lockstep_gba.wasm once.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { Gba, GBA_H, GBA_W } from '../src/gba/gba.ts';

const WASM_PATH = join(import.meta.dirname, '..', 'src', 'gba', 'lockstep_gba.wasm');
let module: WebAssembly.Module | null = null;

export function gba(rom: Uint8Array): Gba {
  module ??= new WebAssembly.Module(readFileSync(WASM_PATH));
  return Gba.createSync(module, rom);
}

export function screenshot(g: Gba, path: string): void {
  const png = new PNG({ width: GBA_W, height: GBA_H });
  png.data.set(g.frame);
  writeFileSync(path, PNG.sync.write(png));
}

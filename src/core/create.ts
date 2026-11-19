// Picks and builds an emulator core in the browser. The Rust/Wasm core is the
// default; the TypeScript core is the fallback and stays selectable.

import { GameBoy } from './gameboy.ts';
import type { CoreKind, Emulator } from './emulator.ts';
import wasmUrl from './lockstep_core.wasm?url';
import { WasmGameBoy } from './wasm.ts';

let compiled: Promise<WebAssembly.Module> | null = null;

function wasmModule(): Promise<WebAssembly.Module> {
  compiled ??= (async () => {
    try {
      return await WebAssembly.compileStreaming(fetch(wasmUrl));
    } catch {
      // Servers that don't send application/wasm, or no streaming support.
      const res = await fetch(wasmUrl);
      return WebAssembly.compile(await res.arrayBuffer());
    }
  })();
  return compiled;
}

/** Start fetching and compiling the Wasm core early (it's small, but why wait). */
export function preloadCore(): void {
  if (typeof WebAssembly === 'object') wasmModule().catch(() => (compiled = null));
}

export async function createEmulator(rom: Uint8Array, prefer: CoreKind): Promise<{ gb: Emulator; kind: CoreKind }> {
  if (prefer === 'wasm' && typeof WebAssembly === 'object') {
    try {
      return { gb: await WasmGameBoy.create(await wasmModule(), rom), kind: 'wasm' };
    } catch (err) {
      compiled = null;
      console.warn('Rust/Wasm core unavailable; using the TypeScript core', err);
    }
  }
  return { gb: new GameBoy(rom), kind: 'ts' };
}

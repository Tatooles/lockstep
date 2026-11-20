// Fetches and compiles the Rust core (lockstep_core.wasm) in the browser.

import { GameBoy } from './gameboy.ts';
import wasmUrl from './lockstep_core.wasm?url';

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

/** Start fetching and compiling the core early, so opening a game doesn't wait on it. */
export function preloadCore(): void {
  if (typeof WebAssembly === 'object') wasmModule().catch(() => (compiled = null));
}

export async function createGameBoy(rom: Uint8Array): Promise<GameBoy> {
  if (typeof WebAssembly !== 'object') {
    throw new Error("This browser can't run WebAssembly, which the emulator needs. On iPhone, Lockdown Mode can turn it off.");
  }
  try {
    return await GameBoy.create(await wasmModule(), rom);
  } catch (err) {
    compiled = null; // let the next attempt refetch
    throw new Error(`The emulator failed to load: ${err instanceof Error ? err.message : String(err)}`);
  }
}

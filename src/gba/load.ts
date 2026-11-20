// Fetches and compiles the GBA core (lockstep_gba.wasm) in the browser.

import { Gba } from './gba.ts';
import wasmUrl from './lockstep_gba.wasm?url';

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

export async function createGba(rom: Uint8Array): Promise<Gba> {
  if (typeof WebAssembly !== 'object') {
    throw new Error("This browser can't run WebAssembly, which the emulator needs. On iPhone, Lockdown Mode can turn it off.");
  }
  try {
    return await Gba.create(await wasmModule(), rom);
  } catch (err) {
    compiled = null; // let the next attempt refetch
    throw new Error(`The emulator failed to load: ${err instanceof Error ? err.message : String(err)}`);
  }
}

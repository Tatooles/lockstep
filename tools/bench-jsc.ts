// The TS-vs-Wasm benchmark for Apple's JavaScriptCore shell (Safari's engine).
// Bundled and run by:  node tools/bench-jsc-run.ts [rom]

import { GameBoy } from '../src/core/gameboy.ts';

declare function readFile(path: string, mode: 'binary'): Uint8Array;
declare function preciseTime(): number;
declare function print(...a: unknown[]): void;
// The jsc shell exposes its command-line arguments as a global named `arguments`.
const scriptArgs = (globalThis as unknown as { arguments: string[] }).arguments;

const [romPath, wasmPath] = scriptArgs;
const rom = new Uint8Array(readFile(romPath, 'binary'));
const wasmModule = new WebAssembly.Module(readFile(wasmPath, 'binary'));
const now = () => preciseTime() * 1000;
const FRAMES = 3600;
const TRIALS = 5;

interface Runner {
  runFrame(): void;
  drain(): void;
}

function makeTs(audio: boolean): Runner {
  const gb = new GameBoy(rom.slice());
  gb.apu.outputEnabled = audio;
  return { runFrame: () => gb.runFrame(), drain: () => gb.apu.clearBuffer() };
}

function makeWasm(audio: boolean): Runner {
  const inst = new WebAssembly.Instance(wasmModule, { env: { now_ms: () => Date.now(), serial_byte: () => {} } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const x = inst.exports as any;
  const p = x.alloc(rom.length);
  new Uint8Array(x.memory.buffer, p, rom.length).set(rom);
  x.init(p, rom.length);
  x.set_audio(audio ? 1 : 0, 48000);
  return { runFrame: () => x.run_frame(), drain: () => x.audio_set_read_pos(x.audio_write_pos()) };
}

function trial(r: Runner): number {
  for (let i = 0; i < 300; i++) r.runFrame();
  const t0 = now();
  for (let i = 0; i < FRAMES; i++) {
    r.runFrame();
    if (i % 60 === 0) r.drain();
  }
  return now() - t0;
}

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];

for (const audio of [true, false]) {
  const ts: number[] = [];
  const wa: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    ts.push(trial(makeTs(audio)));
    wa.push(trial(makeWasm(audio)));
  }
  const tsMs = median(ts);
  const waMs = median(wa);
  const x = (ms: number) => (FRAMES / (ms / 1000) / 59.7275).toFixed(1);
  print(
    `JSC audio ${audio ? 'on ' : 'off'}  TS ${(tsMs / FRAMES).toFixed(3)} ms/frame (${x(tsMs)}x)   ` +
      `Wasm ${(waMs / FRAMES).toFixed(3)} ms/frame (${x(waMs)}x)   speedup ${(tsMs / waMs).toFixed(2)}x`,
  );
}

// TypeScript core vs Rust/Wasm core, headless, alternating trials.
//   node tools/bench-wasm.ts [rom]

import { readFileSync } from 'node:fs';
import { GameBoy } from '../src/core/gameboy.ts';
import { wasmGameBoy } from './wasm-node.ts';

const romPath = process.argv[2] ?? 'roms/pokered.gb';
const rom = new Uint8Array(readFileSync(romPath));
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
  const gb = wasmGameBoy(rom.slice());
  gb.apu.outputEnabled = audio;
  return { runFrame: () => gb.runFrame(), drain: () => gb.apu.clearBuffer() };
}

function trial(r: Runner): number {
  for (let i = 0; i < 300; i++) r.runFrame();
  const t0 = performance.now();
  for (let i = 0; i < FRAMES; i++) {
    r.runFrame();
    if (i % 60 === 0) r.drain();
  }
  return performance.now() - t0;
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
  console.log(
    `audio ${audio ? 'on ' : 'off'}  TS ${(tsMs / FRAMES).toFixed(3)} ms/frame (${x(tsMs)}x)   ` +
      `Wasm ${(waMs / FRAMES).toFixed(3)} ms/frame (${x(waMs)}x)   speedup ${(tsMs / waMs).toFixed(2)}x`,
  );
}

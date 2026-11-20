// Emulation speed, headless in Node (V8).
//   node tools/bench.ts [rom]
import { readFileSync } from 'node:fs';
import { gameBoy } from './core.ts';

const rom = process.argv[2] ?? 'test-roms/blargg/cpu_instrs/cpu_instrs.gb';
const gb = gameBoy(new Uint8Array(readFileSync(rom)));
const frames = 3600;
for (let i = 0; i < 300; i++) gb.runFrame();
const t0 = performance.now();
for (let i = 0; i < frames; i++) gb.runFrame();
const ms = performance.now() - t0;
console.log(`${frames} frames in ${ms.toFixed(0)}ms = ${(frames / (ms / 1000) / 59.73).toFixed(1)}x realtime (audio on), ${(ms / frames).toFixed(3)} ms per frame`);

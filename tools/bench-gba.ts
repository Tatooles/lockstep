// GBA core emulation speed, headless in Node (V8), uncapped.
//   node tools/bench-gba.ts <rom> [state] [frames]
// With a state (see tools/gba-play.ts), it walks around the overworld; without
// one it measures from power-on.
import { existsSync, readFileSync } from 'node:fs';
import { bench, formatResult } from '../src/gba/bench.ts';
import { gba } from './gba.ts';

const romPath = process.argv[2];
if (!romPath) {
  console.error('usage: node tools/bench-gba.ts <rom> [state] [frames]');
  process.exit(1);
}
const statePath = process.argv[3] ?? romPath.replace(/\.gba$/, '.state');
const frames = Number(process.argv[4] ?? 3600);
const g = gba(new Uint8Array(readFileSync(romPath)));
const state = existsSync(statePath) ? new Uint8Array(readFileSync(statePath)) : null;
console.log(`${romPath}${state ? ` from ${statePath}` : ' from power-on'}, node ${process.version}`);
console.log(formatResult(await bench(g, state, frames)));

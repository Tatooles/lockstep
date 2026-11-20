// Drive a GBA game with scripted input, e.g. to reach the overworld and save a
// state for tools/bench-gba.ts and bench-gba.html.
//   node tools/gba-play.ts <rom> "<steps>" [--from in.state] [--save out.state] [--shots dir]
// Steps are space separated: "N" waits N frames with no keys, "N:A+Up" holds
// keys for N frames. With --shots, a PNG is written after every step.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Key } from '../src/gba/gba.ts';
import { gba, screenshot } from './gba.ts';

const [romPath, script = ''] = process.argv.slice(2);
const opt = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const g = gba(new Uint8Array(readFileSync(romPath)));
const from = opt('--from');
if (from) g.loadState(new Uint8Array(readFileSync(from)));
const shots = opt('--shots');
if (shots) mkdirSync(shots, { recursive: true });

let frame = 0;
script
  .split(/\s+/)
  .filter(Boolean)
  .forEach((step, i) => {
    const [n, keys = ''] = step.split(':');
    const mask = keys
      .split('+')
      .filter(Boolean)
      .reduce((m, k) => m | Key[k as keyof typeof Key], 0);
    for (let f = 0; f < Number(n); f++) {
      g.setKeys(mask);
      g.runFrame();
      frame++;
    }
    if (shots) screenshot(g, join(shots, `step-${String(i).padStart(3, '0')}.png`));
  });
g.setKeys(0);
const save = opt('--save');
if (save) writeFileSync(save, g.saveState());
console.log(`ran ${frame} frames; pc ${g.reg(15).toString(16)}`);

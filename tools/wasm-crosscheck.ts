// Runs the TypeScript core and the Rust/Wasm core side by side with the same
// scripted input and checks they stay identical: screen, work RAM, CPU
// registers and audio samples, every frame.
//   node tools/wasm-crosscheck.ts [rom] [frames]

import { readFileSync } from 'node:fs';
import { GameBoy } from '../src/core/gameboy.ts';
import { WasmGameBoy } from '../wasm-core/gameboy-wasm.ts';

const romPath = process.argv[2] ?? 'roms/pokered.gb';
const frames = Number(process.argv[3] ?? 20000);
const rom = new Uint8Array(readFileSync(romPath));
const ts = new GameBoy(rom.slice());
const wa = new WasmGameBoy(rom.slice());

// Deterministic button mashing: hold a random button for a random number of frames.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / (1 << 24);
let held = -1;
let holdLeft = 0;

const tsRegs = () => {
  const c = ts.cpu;
  return [c.a, c.f, c.b, c.c, c.d, c.e, c.h, c.l, c.sp, c.pc, c.halted ? 1 : 0];
};
const waRegs = () => Array.from({ length: 11 }, (_, i) => wa.reg(i));

function firstDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return -1;
}

let samples = 0;
const t0 = performance.now();
for (let f = 0; f < frames; f++) {
  if (holdLeft-- <= 0) {
    if (held >= 0) {
      ts.setButton(held, false);
      wa.setButton(held, false);
    }
    // Mostly A and directions (moves through menus and the overworld); Start rarely.
    const r = rand();
    held = r < 0.35 ? 4 : r < 0.4 ? 5 : r < 0.42 ? 7 : r < 0.5 ? -1 : (Math.floor(rand() * 4) as number);
    holdLeft = 2 + Math.floor(rand() * 20);
    if (held >= 0) {
      ts.setButton(held, true);
      wa.setButton(held, true);
    }
  }
  ts.runFrame();
  wa.runFrame();

  const problems: string[] = [];
  const fd = firstDiff(ts.ppu.frame, wa.frame);
  if (fd >= 0) problems.push(`frame pixel ${fd} (x=${fd % 160}, y=${Math.floor(fd / 160)})`);
  const wd = firstDiff(ts.bus.wram, wa.wram);
  if (wd >= 0) problems.push(`wram $${(0xc000 + wd).toString(16)}: ts=${ts.bus.wram[wd]} wasm=${wa.wram[wd]}`);
  const rt = tsRegs();
  const rw = waRegs();
  if (firstDiff(rt, rw) >= 0) problems.push(`regs ts=[${rt.map((v) => v.toString(16))}] wasm=[${rw.map((v) => v.toString(16))}]`);
  if (ts.bus.mcycles !== wa.mcycles) problems.push(`mcycles ts=${ts.bus.mcycles} wasm=${wa.mcycles}`);

  const n = ts.apu.available();
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  ts.apu.drain(l, r, n);
  const wAudio = wa.drainAudio();
  const tAudio = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    tAudio[i * 2] = l[i];
    tAudio[i * 2 + 1] = r[i];
  }
  const ad = firstDiff(tAudio, wAudio);
  if (ad >= 0) problems.push(`audio sample ${ad} of ${tAudio.length}/${wAudio.length}: ts=${tAudio[ad]} wasm=${wAudio[ad]}`);
  samples += n;

  if (problems.length) {
    console.log(`DIVERGED at frame ${f}:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
}
const ms = performance.now() - t0;
console.log(
  `IDENTICAL for ${frames} frames (${(frames / 59.7275 / 60).toFixed(1)} min of play, ${samples} stereo audio frames) in ${(ms / 1000).toFixed(1)}s`,
);

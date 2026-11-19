// Headless conformance runner: blargg + dmg-acid2 (screenshot compare) and
// mooneye (Fibonacci register signature on LD B,B).
//   node tools/run-test-roms.ts [filter] [--wasm]

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { PNG } from 'pngjs';
import { GameBoy } from '../src/core/gameboy.ts';
import { CLOCK_HZ, SCREEN_H, SCREEN_W } from '../src/core/constants.ts';
import type { WasmGameBoy } from '../src/core/wasm.ts';
import { wasmGameBoy } from './wasm-node.ts';

const ROOT = join(import.meta.dirname, '..', 'test-roms');
const OUT = join(import.meta.dirname, 'out');
const useWasm = process.argv.includes('--wasm');
const filter = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '';

/** Either core: both expose the members this runner uses. */
type Core = GameBoy | WasmGameBoy;
const makeCore = (rom: Uint8Array): Core => (useWasm ? wasmGameBoy(rom) : new GameBoy(rom));
const SHADES = [0xff, 0xaa, 0x55, 0x00];

interface Result {
  name: string;
  pass: boolean;
  detail: string;
  ms: number;
}

function framePng(gb: Core): PNG {
  const png = new PNG({ width: SCREEN_W, height: SCREEN_H });
  const f = gb.ppu.frame;
  for (let i = 0; i < f.length; i++) {
    const s = SHADES[f[i]];
    png.data[i * 4] = s;
    png.data[i * 4 + 1] = s;
    png.data[i * 4 + 2] = s;
    png.data[i * 4 + 3] = 255;
  }
  return png;
}

function matches(gb: Core, expected: PNG): number {
  const f = gb.ppu.frame;
  let diff = 0;
  for (let i = 0; i < f.length; i++) {
    if (SHADES[f[i]] !== expected.data[i * 4]) diff++;
  }
  return diff;
}

function saveFailure(name: string, gb: Core): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name.replace(/[\\/]/g, '__') + '.png'), PNG.sync.write(framePng(gb)));
}

function screenshotTest(rom: string, png: string, seconds: number): Result {
  const name = relative(ROOT, rom);
  const t0 = performance.now();
  const gb = makeCore(new Uint8Array(readFileSync(rom)));
  let serial = '';
  gb.bus.onSerialByte = (b) => {
    serial += String.fromCharCode(b);
  };
  gb.apu.outputEnabled = false;
  const expected = PNG.sync.read(readFileSync(png));
  const frames = Math.ceil(seconds * 59.7275);
  let diff = -1;
  for (let i = 0; i < frames; i++) {
    gb.runFrame();
    // Check periodically so passing tests finish early.
    if (i % 30 === 29) {
      diff = matches(gb, expected);
      if (diff === 0) break;
    }
  }
  diff = matches(gb, expected);
  const pass = diff === 0;
  if (!pass) saveFailure(name, gb);
  const s = serial.trim().replace(/\s+/g, ' ');
  return { name, pass, detail: pass ? '' : `${diff}px differ${s ? ` | serial: ${s.slice(-160)}` : ''}`, ms: performance.now() - t0 };
}

function mooneyeTest(rom: string): Result {
  const name = relative(ROOT, rom);
  const t0 = performance.now();
  const gb = makeCore(new Uint8Array(readFileSync(rom)));
  gb.apu.outputEnabled = false;
  const cpu = gb.cpu;
  const limit = gb.bus.mcycles + (CLOCK_HZ / 4) * 20;
  let done = false;
  while (gb.bus.mcycles < limit) {
    if (!cpu.halted && gb.peek(cpu.pc) === 0x40) {
      done = true;
      break;
    }
    cpu.step();
  }
  const regs = [cpu.b, cpu.c, cpu.d, cpu.e, cpu.h, cpu.l];
  const pass = done && regs.join() === '3,5,8,13,21,34';
  if (!pass) saveFailure(name, gb);
  return {
    name,
    pass,
    detail: pass ? '' : done ? `regs ${regs.map((r) => r.toString(16)).join(' ')}` : 'timeout',
    ms: performance.now() - t0,
  };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.gb')) out.push(p);
  }
  return out.sort();
}

/** Mooneye model suffix filter: keep tests valid on DMG ABC. */
function dmgCompatible(file: string): boolean {
  const m = /-([A-Za-z0-9]+)\.gb$/.exec(basename(file));
  if (!m) return true;
  const tag = m[1];
  if (tag === 'dmgABC' || tag === 'dmgABCmgb' || tag.includes('G')) return true;
  // Tags like "timing" (hyphenated names) aren't model tags.
  const models = ['dmg0', 'mgb', 'sgb', 'sgb2', 'S', 'C', 'A', 'cgb', 'agb', 'ags', 'cgb0', 'cgbABCDE', 'cgbE'];
  return !models.some((x) => tag === x || tag.startsWith(x));
}

const results: Result[] = [];
const B = join(ROOT, 'blargg');
const screenshotTests: [string, string, number][] = [
  [join(B, 'cpu_instrs/cpu_instrs.gb'), join(B, 'cpu_instrs/cpu_instrs-dmg-cgb.png'), 55],
  [join(B, 'instr_timing/instr_timing.gb'), join(B, 'instr_timing/instr_timing-dmg-cgb.png'), 2],
  [join(B, 'mem_timing/mem_timing.gb'), join(B, 'mem_timing/mem_timing-dmg-cgb.png'), 4],
  [join(B, 'mem_timing-2/mem_timing.gb'), join(B, 'mem_timing-2/mem_timing-dmg-cgb.png'), 5],
  [join(B, 'halt_bug.gb'), join(B, 'halt_bug-dmg-cgb.png'), 3],
  [join(B, 'dmg_sound/dmg_sound.gb'), join(B, 'dmg_sound/dmg_sound-dmg.png'), 37],
  [join(B, 'oam_bug/oam_bug.gb'), join(B, 'oam_bug/oam_bug-dmg.png'), 22],
  [join(ROOT, 'dmg-acid2/dmg-acid2.gb'), join(ROOT, 'dmg-acid2/dmg-acid2-dmg.png'), 3],
];
for (const [rom, png, secs] of screenshotTests) {
  if (filter && !rom.includes(filter)) continue;
  if (!existsSync(rom)) continue;
  results.push(screenshotTest(rom, png, secs));
  const r = results[results.length - 1];
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}  (${r.ms.toFixed(0)}ms)`);
}

const mooneyeDirs = ['mooneye-test-suite/acceptance', 'mooneye-test-suite/emulator-only'];
for (const d of mooneyeDirs) {
  for (const rom of walk(join(ROOT, d))) {
    if (!dmgCompatible(rom)) continue;
    if (filter && !rom.includes(filter)) continue;
    const r = mooneyeTest(rom);
    results.push(r);
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}  (${r.ms.toFixed(0)}ms)`);
  }
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
writeFileSync(
  join(import.meta.dirname, '..', useWasm ? 'test-results-wasm.json' : 'test-results.json'),
  JSON.stringify({ passed, total: results.length, results: results.map(({ name, pass, detail }) => ({ name, pass, detail })) }, null, 2),
);

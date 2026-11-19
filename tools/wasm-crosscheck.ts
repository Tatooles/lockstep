// Runs the TypeScript core and the Rust/Wasm core side by side with the same
// scripted input and checks they stay identical every frame: screen, work RAM,
// CPU registers, cycle count and audio samples. Along the way it moves save
// states between the cores in both directions, resets both, compares their
// saveState() output, and replays any play.ts states in roms/states/.
//   node tools/wasm-crosscheck.ts [rom] [frames]

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SaveState } from '../src/core/emulator.ts';
import { GameBoy } from '../src/core/gameboy.ts';
import type { WasmGameBoy } from '../src/core/wasm.ts';
import { wasmGameBoy } from './wasm-node.ts';

const romPath = process.argv[2] ?? 'roms/pokered.gb';
const frames = Number(process.argv[3] ?? 20000);
const rom = new Uint8Array(readFileSync(romPath));
let ts = new GameBoy(rom.slice());
let wa: WasmGameBoy = wasmGameBoy(rom.slice());

// Deterministic button mashing: hold a random button for a random number of frames.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / (1 << 24);
let held = -1;
let holdLeft = 0;

function press(): void {
  if (holdLeft-- > 0) return;
  if (held >= 0) {
    ts.setButton(held, false);
    wa.setButton(held, false);
  }
  // Mostly A and directions (moves through menus and the overworld); Start rarely.
  const r = rand();
  held = r < 0.35 ? 4 : r < 0.4 ? 5 : r < 0.42 ? 7 : r < 0.5 ? -1 : Math.floor(rand() * 4);
  holdLeft = 2 + Math.floor(rand() * 20);
  if (held >= 0) {
    ts.setButton(held, true);
    wa.setButton(held, true);
  }
}

const tsRegs = () => {
  const c = ts.cpu;
  return [c.a, c.f, c.b, c.c, c.d, c.e, c.h, c.l, c.sp, c.pc, c.halted ? 1 : 0];
};
const waRegs = () => {
  const c = wa.cpu;
  return [c.a, c.f, c.b, c.c, c.d, c.e, c.h, c.l, c.sp, c.pc, c.halted ? 1 : 0];
};

function firstDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function drain(gb: GameBoy | WasmGameBoy): Float32Array {
  const n = gb.apu.available();
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  gb.apu.drain(l, r, n);
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = l[i];
    out[i * 2 + 1] = r[i];
  }
  return out;
}

let samples = 0;
let checkedFrames = 0;
function compare(where: string): void {
  const problems: string[] = [];
  const fd = firstDiff(ts.ppu.frame, wa.ppu.frame);
  if (fd >= 0) problems.push(`frame pixel ${fd} (x=${fd % 160}, y=${Math.floor(fd / 160)})`);
  const wd = firstDiff(ts.bus.wram, wa.bus.wram);
  if (wd >= 0) problems.push(`wram $${(0xc000 + wd).toString(16)}: ts=${ts.bus.wram[wd]} wasm=${wa.bus.wram[wd]}`);
  const rt = tsRegs();
  const rw = waRegs();
  if (firstDiff(rt, rw) >= 0) problems.push(`regs ts=[${rt.map((v) => v.toString(16))}] wasm=[${rw.map((v) => v.toString(16))}]`);
  if (ts.bus.mcycles !== wa.bus.mcycles) problems.push(`mcycles ts=${ts.bus.mcycles} wasm=${wa.bus.mcycles}`);
  if (firstDiff(ts.cart.ram, wa.cart.ram) >= 0) problems.push('cart RAM differs');
  const ta = drain(ts);
  const wAudio = drain(wa);
  const ad = firstDiff(ta, wAudio);
  if (ad >= 0) problems.push(`audio sample ${ad} of ${ta.length}/${wAudio.length}: ts=${ta[ad]} wasm=${wAudio[ad]}`);
  samples += ta.length / 2;
  checkedFrames++;
  if (problems.length) {
    console.log(`DIVERGED ${where}:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
}

/** Deep comparison of two save states, ignoring the RTC base timestamp (wall-clock at creation). */
function sameState(a: SaveState, b: SaveState): string | null {
  const norm = (s: SaveState) => JSON.stringify({ ...s, cart: { ...s.cart, rtc: s.cart.rtc?.map((v, i) => (i === 5 ? 0 : v)) } }, (_k, v) =>
    v instanceof Uint8Array ? Array.from(v) : v,
  );
  const x = norm(a);
  const y = norm(b);
  if (x === y) return null;
  const i = firstDiff(Array.from(x, (c) => c.charCodeAt(0)), Array.from(y, (c) => c.charCodeAt(0)));
  return `…${x.slice(Math.max(0, i - 80), i + 40)}\n  vs\n  …${y.slice(Math.max(0, i - 80), i + 40)}`;
}

function checkStates(where: string): void {
  const d = sameState(ts.saveState(), wa.saveState());
  if (d) {
    console.log(`SAVE STATES DIFFER ${where}:\n  ${d}`);
    process.exit(1);
  }
}

function run(n: number, label: string): void {
  for (let f = 0; f < n; f++) {
    press();
    ts.runFrame();
    wa.runFrame();
    compare(`${label}, frame ${f}`);
  }
}

const t0 = performance.now();
const quarter = Math.floor(frames / 4);

// 1. From power-on.
run(quarter, 'from boot');
checkStates('after boot run');
const early = ts.saveState();
console.log(`ok  ${quarter} frames from boot, save states match`);

// Save states don't capture channel internals (timers, LFSR, envelopes), so a
// core that loaded a state is only comparable with another that loaded it too.
// 2. A state saved by the TS core, loaded into a fresh core of each kind.
let st = ts.saveState();
ts = new GameBoy(rom.slice());
ts.loadState(st);
wa = wasmGameBoy(rom.slice());
wa.loadState(st);
checkStates('after TS -> Wasm load');
run(quarter, 'after TS -> Wasm load');
console.log(`ok  TS state loaded into Wasm, ${quarter} more frames`);

// 3. A state saved by the Wasm core, loaded into a fresh core of each kind.
st = wa.saveState();
ts = new GameBoy(rom.slice());
ts.loadState(st);
wa = wasmGameBoy(rom.slice());
wa.loadState(st);
checkStates('after Wasm -> TS load');
run(quarter, 'after Wasm -> TS load');
console.log(`ok  Wasm state loaded into TS, ${quarter} more frames`);

// 4. Reset both (keeps battery RAM), then rewind both to an earlier state.
ts.reset();
wa.reset();
checkStates('after reset');
run(quarter >> 1, 'after reset');
ts.loadState(early);
wa.loadState(early);
run(quarter >> 1, 'after rewinding to an earlier state');
console.log(`ok  reset and rewind, ${quarter} more frames`);

// 5. Real gameplay states from tools/play.ts (battles, menus, catches), if present.
const statesDir = join(import.meta.dirname, '..', 'roms', 'states');
if (existsSync(statesDir)) {
  const revive = (o: unknown): unknown => {
    if (o && typeof o === 'object') {
      const r = o as Record<string, unknown>;
      if (r.__u8) return Uint8Array.from(r.__u8 as number[]);
      for (const k of Object.keys(r)) r[k] = revive(r[k]);
    }
    return o;
  };
  const files = readdirSync(statesDir).filter((f) => f.endsWith('.state'));
  for (const f of files) {
    const st = revive(JSON.parse(readFileSync(join(statesDir, f), 'utf8'))) as SaveState;
    if (st.globalChecksum !== ts.cart.header.globalChecksum) continue;
    ts.loadState(st);
    wa.loadState(st);
    run(600, `state ${f}`);
  }
  console.log(`ok  ${files.length} gameplay states from roms/states, 600 frames each`);
}

const ms = performance.now() - t0;
console.log(
  `\nIDENTICAL across ${checkedFrames} frames (${(checkedFrames / 59.7275 / 60).toFixed(1)} min of play, ${samples} stereo audio frames) in ${(ms / 1000).toFixed(1)}s`,
);

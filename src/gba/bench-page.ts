// bench-gba.html: loads /roms/<name>.gba (+ .state) from the dev server, or a
// picked file, and measures uncapped speed. ?rom=<name>&frames=<n>

import { bench, formatResult } from './bench.ts';
import { Gba, GBA_H, GBA_W } from './gba.ts';
import wasmUrl from './lockstep_gba.wasm?url';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const out = $<HTMLPreElement>('out');
const runBtn = $<HTMLButtonElement>('run');
const speedEl = $<HTMLDivElement>('speed');
const canvas = $<HTMLCanvasElement>('screen');
const ctx = canvas.getContext('2d')!;
const params = new URLSearchParams(location.search);
const name = params.get('rom') ?? 'emerald';
const frames = Number(params.get('frames') ?? 3600);

let gba: Gba | null = null;
let state: Uint8Array | null = null;
let romLabel = '';
let lines: string[] = [];

function log(s: string) {
  lines.push(s);
  out.textContent = lines.join('\n');
}

function draw() {
  if (!gba) return;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(gba.frame), GBA_W, GBA_H), 0, 0);
}

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  // Vite answers unknown paths with index.html.
  if (buf.length < 1024 || (buf[0] === 0x3c && buf[1] === 0x21)) return null;
  return buf;
}

const module = WebAssembly.compileStreaming(fetch(wasmUrl)).catch(async () =>
  WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer()),
);

async function load(rom: Uint8Array, st: Uint8Array | null, label: string) {
  gba = await Gba.create(await module, rom);
  state = null;
  if (st) {
    try {
      gba.loadState(st);
      state = st;
    } catch (e) {
      log(`state not loaded: ${(e as Error).message}`);
    }
  }
  if (!state) for (let i = 0; i < 60; i++) gba.runFrame();
  romLabel = `${label}${state ? ' (overworld state)' : ' (from power-on, no state)'}`;
  draw();
  lines = [];
  log(`ROM: ${romLabel}`);
  runBtn.disabled = false;
  runBtn.textContent = `Run benchmark (${frames} frames × 2)`;
}

async function run() {
  if (!gba) return;
  runBtn.disabled = true;
  lines = [`ROM: ${romLabel}`];
  const t0 = performance.now();
  const r = await bench(gba, state, frames, {
    chunkFrames: 120,
    chunk: async (phase, done) => {
      runBtn.textContent = `${phase}: ${done}/${phase === 'warm-up' ? Math.min(300, frames) : frames}`;
      draw();
      await new Promise((res) => setTimeout(res, 0));
    },
  });
  speedEl.textContent = `${r.full.speed.toFixed(1)}× real time`;
  log(formatResult(r));
  log(`wall time: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  log(`UA: ${navigator.userAgent}`);
  log(`cores: ${navigator.hardwareConcurrency ?? '?'}`);
  // Report to the dev server (tools/out/bench-results.jsonl); harmless if absent.
  fetch('/__bench-result', {
    method: 'POST',
    body: JSON.stringify({
      at: new Date().toISOString(),
      rom: romLabel,
      ua: navigator.userAgent,
      label: params.get('label') ?? '',
      full: r.full,
      cpuOnly: r.cpuOnly,
      graphicsShare: r.graphicsShare,
    }),
  }).catch(() => {});
  runBtn.disabled = false;
  runBtn.textContent = 'Run again';
}

runBtn.onclick = run;
$<HTMLButtonElement>('copy').onclick = () => navigator.clipboard?.writeText(out.textContent ?? '');
$<HTMLInputElement>('file').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) await load(new Uint8Array(await f.arrayBuffer()), null, f.name);
};

const rom = await fetchBytes(`/roms/${name}.gba`);
if (rom) {
  await load(rom, await fetchBytes(`/roms/${name}.state`), `${name}.gba`);
  if (params.has('auto')) run();
} else {
  runBtn.textContent = 'No ROM';
  log(`/roms/${name}.gba not found on the server. Pick a ROM file below.`);
}

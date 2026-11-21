// Frame pacing check for the GBA play loop in headless Chromium.
//   node tools/gba-pacing.ts <rom.gba> [--every N] [--seconds S] [--cpu X]
// Wraps requestAnimationFrame so callbacks fire every Nth vsync, counts the GBA
// frames each callback emulates, and prints the spread. Headless Chromium's
// vsync is 120 Hz, so --every 4 is iOS Low Power Mode's 30 Hz and --every 2 is
// 60 Hz. --cpu X slows the page's CPU X times, like a phone in Low Power Mode.
// An even loop runs the same number of frames on every callback.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = join(import.meta.dirname, '..');
const rom = process.argv[2];
if (!rom) throw new Error('usage: node tools/gba-pacing.ts <rom.gba> [--every N] [--seconds S]');
const opt = (name: string, d: number) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const every = opt('--every', 2);
const seconds = opt('--seconds', 6);
const cpu = opt('--cpu', 1);
const PORT = 5198;
const exe = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');
if (!existsSync(exe)) throw new Error(`Chromium not found at ${exe}`);

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite did not start')), 20000);
  server.stdout.on('data', (d: Buffer) => {
    if (d.toString().includes('Local')) {
      clearTimeout(t);
      resolve();
    }
  });
});

const browser = await chromium.launch({ executablePath: exe });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript((n: number) => {
    const w = window as unknown as { __frames: number; __log: [number, number][] };
    w.__frames = 0;
    w.__log = [];
    // Count GBA frames: wrap the core's run_frame export.
    const instantiate = WebAssembly.instantiate.bind(WebAssembly);
    (WebAssembly as { instantiate: unknown }).instantiate = async (m: WebAssembly.Module, imports?: WebAssembly.Imports) => {
      const inst = (await instantiate(m, imports)) as unknown as WebAssembly.Instance;
      const exports: Record<string, unknown> = { ...inst.exports };
      const run = inst.exports.run_frame as () => number;
      exports.run_frame = () => {
        w.__frames++;
        return run();
      };
      return { exports } as WebAssembly.Instance;
    };
    // Fire animation frame callbacks every Nth vsync, logging frames emulated per callback.
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      let left = n;
      // Only the play session's loop is logged (other callbacks, like gamepad polling, share the wrapper).
      const session = String(cb).includes('tick(');
      const step = (t: number) => {
        if (--left > 0) {
          raf(step);
          return;
        }
        const before = w.__frames;
        cb(t);
        if (session) w.__log.push([t, w.__frames - before]);
      };
      return raf(step);
    };
  }, every);
  page.on('pageerror', (e) => console.log(`page error: ${e}`));
  page.on('console', (m) => m.type() === 'error' && console.log(`console: ${m.text()}`));
  if (cpu > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: cpu });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('.wordmark');
  await page.setInputFiles('input[type=file]', rom);
  await page.waitForSelector('canvas.screen', { timeout: 15000 });
  // Let it settle (the display-rate estimate needs a moment), then measure.
  await page.waitForTimeout(2000);
  await page.evaluate(() => ((window as unknown as { __log: unknown[] }).__log = []));
  await page.waitForTimeout(seconds * 1000);
  const total = await page.evaluate(() => (window as unknown as { __frames: number }).__frames);
  console.log(`run_frame calls so far: ${total}`);
  const log = await page.evaluate(() => (window as unknown as { __log: [number, number][] }).__log);
  const counts = new Map<number, number>();
  for (const [, f] of log) counts.set(f, (counts.get(f) ?? 0) + 1);
  const gaps = log.slice(1).map(([t], i) => t - log[i][0]);
  const avg = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
  const frames = log.reduce((a, [, f]) => a + f, 0);
  const span = (log.at(-1)![0] - log[0][0]) / 1000;
  console.log(`every ${every} vsync: ${log.length} callbacks, ${avg.toFixed(2)} ms apart (min ${Math.min(...gaps).toFixed(1)}, max ${Math.max(...gaps).toFixed(1)})`);
  console.log(`frames per callback: ${[...counts].sort((a, b) => a[0] - b[0]).map(([f, c]) => `${f}×${c}`).join(', ')}`);
  console.log(`emulated ${(frames / span).toFixed(2)} frames/s (GBA is 59.73)`);
  const emuMs = await page.evaluate(() => document.querySelector('.fps, [data-emu-ms]')?.textContent ?? '');
  if (emuMs) console.log(`on screen: ${emuMs}`);
  const expected = Math.max(1, Math.round(avg / (1000 / (16777216 / 280896))));
  const odd = log.map(([, f], i) => [i, f]).filter(([, f]) => f !== expected);
  console.log(`${odd.length} of ${log.length} callbacks ran other than ${expected} frames`);
  if (odd.length) console.log(`off-cadence callbacks at: ${odd.slice(0, 20).map(([i, f]) => `#${i}=${f}`).join(' ')}`);
} finally {
  await browser.close();
  server.kill();
}

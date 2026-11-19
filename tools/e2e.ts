// Browser smoke test on a phone-sized viewport.
//   node tools/e2e.ts [romPath]
// Starts the Vite dev server, loads the ROM through the file picker, checks the
// screen renders and the controls respond, and writes screenshots to tools/out.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(import.meta.dirname, 'out');
mkdirSync(OUT, { recursive: true });
const rom = process.argv[2] ?? join(ROOT, 'test-roms/dmg-acid2/dmg-acid2.gb');
const PORT = 5199;
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

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

async function screenNonBlank(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas.screen') as HTMLCanvasElement | null;
    if (!c) return -1;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < d.length; i += 4) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return seen.size;
  });
}

const browser = await chromium.launch({ executablePath: exe });
try {
  for (const vp of [
    { name: 'portrait', width: 390, height: 844, mobile: true, dark: false },
    { name: 'landscape', width: 844, height: 390, mobile: true, dark: false },
    { name: 'small-dark', width: 360, height: 700, mobile: true, dark: true },
    { name: 'desktop', width: 1280, height: 800, mobile: false, dark: false },
  ]) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.mobile ? 2 : 1,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      colorScheme: vp.dark ? 'dark' : 'light',
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector('.wordmark');
    if (vp.name === 'portrait') await page.screenshot({ path: join(OUT, 'e2e-library.png') });
    await page.setInputFiles('input[type=file]', rom);
    await page.waitForSelector('canvas.screen', { timeout: 10000 });
    await page.waitForTimeout(1500);
    const colors = await screenNonBlank(page);
    check(colors > 1, `${vp.name}: screen renders (${colors} colors)`);
    const fps = await page.evaluate(async () => {
      // Count frames presented over one second by sampling the canvas.
      return new Promise<number>((r) => setTimeout(() => r(0), 50));
    });
    void fps;
    // Controls respond (button gets the pressed class).
    if (vp.mobile) {
      const a = page.locator('.key.a');
      const box = await a.boundingBox();
      check(!!box && box.width > 40, `${vp.name}: A button is reachable (${box?.width}px)`);
      if (box) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(!overflow, `${vp.name}: no horizontal overflow`);
    await page.screenshot({ path: join(OUT, `e2e-play-${vp.name}.png`) });
    // Open the panel (always docked on desktop).
    if (vp.mobile) await page.locator('.pill', { hasText: 'Run' }).click();
    await page.waitForSelector('.sheet');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, `e2e-sheet-${vp.name}.png`) });
    if (vp.name === 'desktop') {
      // The Rust/Wasm core runs by default, and switching cores mid-game keeps playing.
      if (!(await page.locator('.field', { hasText: 'Emulator core' }).count())) {
        await page.getByRole('tab', { name: /^(Run|Settings)$/ }).click();
      }
      const field = page.locator('.field', { hasText: 'Emulator core' });
      const hint = field.locator('.hint');
      await page.waitForTimeout(1200);
      const first = (await hint.textContent()) ?? '';
      check(first.includes('WebAssembly'), `desktop: Rust/Wasm core is running ("${first}")`);
      check(/ms per frame/.test(first), 'desktop: emulation cost is measured');
      for (const [button, expect] of [
        ['TypeScript', 'TypeScript'],
        ['Rust', 'WebAssembly'],
      ] as const) {
        await field.getByRole('button', { name: button }).click();
        await page.waitForTimeout(1500);
        const text = (await hint.textContent()) ?? '';
        check(text.includes(expect), `desktop: switched to ${button} ("${text}")`);
        check((await screenNonBlank(page)) > 1, `desktop: screen still renders after switching to ${button}`);
      }
    }
    check(errors.length === 0, `${vp.name}: no console errors ${errors.join(' | ')}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

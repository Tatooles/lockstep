// Screenshots of the dev fixture for each panel tab: node tools/fixture-shots.ts
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(import.meta.dirname, 'out');
const PORT = 5198;
const exe = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise<void>((r) => server.stdout.on('data', (d: Buffer) => d.toString().includes('Local') && r()));
const browser = await chromium.launch({ executablePath: exe });
const errors: string[] = [];
try {
  for (const dark of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    for (const tab of dark ? ['battle'] : ['battle', 'route', 'team', 'log', 'graves']) {
      await page.goto(`http://localhost:${PORT}/?fixture&tab=${tab}`);
      await page.waitForSelector('.sheet-body');
      await page.waitForTimeout(350);
      await page.evaluate(() => {
        const s = document.querySelector('.sheet') as HTMLElement;
        s.style.height = 'auto';
        s.style.maxHeight = 'none';
        s.style.position = 'relative';
        (document.querySelector('.sheet-body') as HTMLElement).style.overflow = 'visible';
        (document.querySelector('.play') as HTMLElement).style.height = 'auto';
        (document.querySelector('.play') as HTMLElement).style.overflow = 'visible';
      });
      await page.screenshot({ path: join(OUT, `fixture-${tab}${dark ? '-dark' : ''}.png`), fullPage: true });
      console.log('shot', tab, dark ? 'dark' : '');
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no console errors');

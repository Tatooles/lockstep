// Runs a bench page (bench-gba.html, or the mGBA reference page from
// tools/serve-mgba-bench.ts) in Chrome (Playwright's "Chrome for Testing" if
// cached, or CHROME=/path/to/binary) and prints the result.
//   node tools/bench-gba-chromium.ts [url]
// Default url: http://localhost:5173/bench-gba.html?auto=1&label=chrome
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

function findChrome(): string | undefined {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
    const bin = join(cache, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

const url = process.argv[2] ?? 'http://localhost:5173/bench-gba.html?auto=1&label=chrome';
const browser = await chromium.launch({ headless: false, executablePath: findChrome() });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(url);
// Both pages print the user agent last.
await page.waitForFunction(() => document.getElementById('out')?.textContent?.includes('UA:'), null, {
  timeout: 15 * 60_000,
});
console.log(await page.locator('#out').textContent());
await browser.close();

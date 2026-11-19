// Bundles tools/bench-jsc.ts and runs it in macOS's JavaScriptCore shell.
//   node tools/bench-jsc-run.ts [rom]

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

// esbuild comes in through Vite; resolve it from there rather than adding a dependency.
const viteRequire = createRequire(createRequire(import.meta.url).resolve('vite'));
const { build } = viteRequire('esbuild') as typeof import('esbuild');

const root = join(import.meta.dirname, '..');
const out = join(import.meta.dirname, 'out', 'bench-jsc.js');
mkdirSync(join(import.meta.dirname, 'out'), { recursive: true });
await build({ entryPoints: [join(import.meta.dirname, 'bench-jsc.ts')], bundle: true, format: 'iife', outfile: out, logLevel: 'error' });
const jsc = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc';
const rom = resolve(process.argv[2] ?? join(root, 'roms/pokered.gb'));
const wasm = join(root, 'wasm-core/target/wasm32-unknown-unknown/release/lockstep_core.wasm');
execFileSync(jsc, [out, '--', rom, wasm], { stdio: 'inherit' });

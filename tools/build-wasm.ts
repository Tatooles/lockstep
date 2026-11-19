// Builds wasm-core/ (Rust) and copies the module to src/core/lockstep_core.wasm,
// which is committed so deploys don't need a Rust toolchain.
//   node tools/build-wasm.ts        (needs rustup with the wasm32-unknown-unknown target)

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const crate = join(root, 'wasm-core');
const local = join(homedir(), '.cargo', 'bin', 'cargo');
const cargo = existsSync(local) ? local : 'cargo';
execFileSync(cargo, ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: crate, stdio: 'inherit' });
const built = join(crate, 'target', 'wasm32-unknown-unknown', 'release', 'lockstep_core.wasm');
const dest = join(root, 'src', 'core', 'lockstep_core.wasm');
copyFileSync(built, dest);
console.log(`${dest} (${(statSync(dest).size / 1024).toFixed(0)} KB)`);

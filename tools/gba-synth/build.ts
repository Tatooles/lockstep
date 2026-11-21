// Builds the synthetic benchmark ROM (tools/gba-synth/main.c) with the host's
// clang (ARM/Thumb codegen) and the Rust toolchain's rust-lld.
//   node tools/gba-synth/build.ts   -> roms/synth.gba, roms/synth-busy.gba (busy-waits for VBlank),
//   roms/synth-psg.gba (also plays the four PSG channels), roms/ppu-scenes.gba (PPU feature scenes)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const here = import.meta.dirname;
const root = join(here, '..', '..');
const out = join(root, 'wasm-gba', 'target', 'gba-synth');
mkdirSync(out, { recursive: true });

function rustBin(name: string): string {
  const tc = join(homedir(), '.rustup', 'toolchains');
  for (const t of readdirSync(tc)) {
    const lib = join(tc, t, 'lib', 'rustlib');
    if (!existsSync(lib)) continue;
    for (const host of readdirSync(lib)) {
      const p = join(lib, host, 'bin', name);
      if (existsSync(p)) return p;
    }
  }
  throw new Error(`${name} not found in ~/.rustup`);
}

const cflags = ['--target=armv4t-none-eabi', '-mthumb', '-O2', '-ffreestanding', '-nostdlib', '-fno-exceptions', '-Wall'];
execFileSync('clang', ['--target=armv4t-none-eabi', '-c', join(here, 'crt0.s'), '-o', join(out, 'crt0.o')], { stdio: 'inherit' });
mkdirSync(join(root, 'roms'), { recursive: true });
for (const [name, src, defs] of [
  ['synth', 'main.c', []],
  ['synth-busy', 'main.c', ['-DBUSYWAIT']],
  ['synth-psg', 'main.c', ['-DPSG']],
  ['ppu-scenes', 'ppu.c', []],
] as const) {
  execFileSync('clang', [...cflags, ...defs, '-c', join(here, src), '-o', join(out, `${name}.o`)], { stdio: 'inherit' });
  const elf = join(out, `${name}.elf`);
  execFileSync(rustBin('rust-lld'), ['-flavor', 'gnu', '-T', join(here, 'gba.ld'), join(out, 'crt0.o'), join(out, `${name}.o`), '-o', elf], {
    stdio: 'inherit',
  });
  const rom = join(root, 'roms', `${name}.gba`);
  writeFileSync(rom, flatten(readFileSync(elf)));
  console.log(rom);
}

/** ELF32 -> ROM image: each PT_LOAD segment at its load address - 0x08000000. */
function flatten(elf: Buffer): Uint8Array {
  const phoff = elf.readUInt32LE(28);
  const phentsize = elf.readUInt16LE(42);
  const phnum = elf.readUInt16LE(44);
  const segs: { at: number; data: Buffer }[] = [];
  for (let i = 0; i < phnum; i++) {
    const h = phoff + i * phentsize;
    if (elf.readUInt32LE(h) !== 1) continue; // PT_LOAD
    const offset = elf.readUInt32LE(h + 4);
    const paddr = elf.readUInt32LE(h + 12);
    const filesz = elf.readUInt32LE(h + 16);
    if (filesz === 0 || paddr < 0x08000000) continue;
    segs.push({ at: paddr - 0x08000000, data: elf.subarray(offset, offset + filesz) });
  }
  const size = Math.max(...segs.map((s) => s.at + s.data.length));
  const img = new Uint8Array((size + 3) & ~3);
  for (const s of segs) img.set(s.data, s.at);
  return img;
}

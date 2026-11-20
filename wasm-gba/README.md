# Lockstep GBA core (spike)

A Game Boy Advance core in Rust, compiled to `wasm32-unknown-unknown` with the
same small C ABI style as `wasm-core/`. It was written to answer one question:
is our own core fast enough on a phone for Gen 3 Pokémon? It is not wired into
the app.

## What's here

| File | What |
| --- | --- |
| `src/cpu.rs` | ARM7TDMI interpreter, ARM and Thumb, with a two-stage pipeline model. Decode tables for both instruction sets; generic over a `Bus` trait. Idle-loop detection. |
| `src/sys.rs` | Memory map and waitstates (with a prefetch approximation), IO registers, DMA (immediate, VBlank, HBlank, sound FIFO), timers (lazy, scheduled overflow, cascade), interrupts, keypad, the event scheduler. |
| `src/ppu.rs` | Scanline renderer: modes 0–5, text and affine BGs, regular/affine/double-size sprites, windows (incl. OBJ window), alpha/brighten/darken, BG mosaic. |
| `src/apu.rs` | Two Direct Sound FIFOs (fed by DMA on timer overflow) and the four PSG channels, mixed to 32768 Hz stereo. |
| `src/bios.rs` | High-level emulation of the BIOS calls (no BIOS image needed or used): IntrWait/VBlankIntrWait, CpuSet/CpuFastSet, LZ77/RL/Huffman/Diff decompression, Div/Sqrt/ArcTan, Bg/ObjAffineSet, BitUnPack, RegisterRamReset, SoftReset, MidiKey2Freq. The IRQ dispatcher is a few words of real ARM code at the BIOS's own addresses, so BIOS open-bus reads match hardware. |
| `src/save.rs` | SRAM and Flash 64K/128K (Macronix/SST IDs, bank switching), detected from the SDK's ID string in the ROM. |
| `src/rtc.rs` | Seiko S-3511A real-time clock on the cartridge GPIO port (Ruby, Sapphire, Emerald). |
| `src/gba.rs` | Frame loop and CPU-address hooks. |
| `src/lib.rs` | The C ABI (wrapped by `src/gba/gba.ts`). |
| `src/bin/sst.rs` | SingleStepTests ARM7TDMI runner. |
| `src/bin/run.rs` | Native runner: test ROMs, screenshots, speed. |

## Host API

`init(rom)`, `run_frame()` (returns early at a hook address; call again to
finish the frame), `frame_ptr()` (RGBA), `set_keys(mask)`, `peek8/16/32`,
`poke8/16/32`, direct views of EWRAM/IWRAM/VRAM/palette/OAM and the save chip,
`reg(i)`, `hook_add(addr)`/`hook_clear()`/`hook_hit()`, `set_audio()` +
an audio ring buffer, `set_time()` for the RTC, `set_render()` (skip drawing,
e.g. for fast-forward frames nobody sees), and save states: the machine
struct holds no pointers but the ROM's, so `save_state()`/`load_state()` copy
its bytes (`state_size()` ≈ 620 KB; only loadable by the same build).

## Tests

Test material lives in `test-roms/gba/` (gitignored):

```sh
git clone --depth 1 https://github.com/SingleStepTests/ARM7TDMI test-roms/gba/sst
git clone --depth 1 https://github.com/jsmolka/gba-tests test-roms/gba/gba-tests
cd wasm-gba
cargo run --release --bin sst -- ../test-roms/gba/sst/v1          # per-instruction CPU tests
cargo run --release --bin run -- ../test-roms/gba/gba-tests/arm/arm.gba 300 --r12   # r12 = 0 means pass
```

- SingleStepTests ARM7TDMI: 2,247,268 / 2,250,000 (99.88%). Every remaining
  failure involves an invalid CPSR mode, which software never uses.
- jsmolka gba-tests: arm, thumb, memory, bios, nes, save/none, save/sram,
  save/flash64, save/flash128, unsafe all pass; ppu/hello, shades and stripes
  render correctly.
- PPU vs mGBA: `tools/gba-synth/ppu.c` scenes match mGBA within one 5-bit color
  step everywhere (mGBA does color effects at 8-bit precision).

## Benchmarks

```sh
node tools/gba-synth/build.ts                       # roms/synth*.gba, roms/ppu-scenes.gba
node tools/build-wasm-gba.ts                        # src/gba/lockstep_gba.wasm
node tools/bench-gba.ts roms/synth.gba none 3600    # Node (V8)
pnpm dev                                            # then open /bench-gba.html?rom=synth&auto=1
node tools/bench-gba-chromium.ts "http://localhost:5173/bench-gba.html?rom=synth&auto=1"
```

`roms/synth.gba` is a C workload built to look like a Pokémon overworld frame:
Thumb game logic in ROM, an 8-channel ARM mixer in IWRAM feeding Direct Sound
through timer + DMA (like m4a), map streaming, 96 objects, shadow OAM/BG
copies by DMA in VBlank, BG alpha blending. It keeps the CPU about 50% busy.
`synth-busy.gba` busy-waits for VBlank instead of halting.

For a real game, put a ROM in `roms/`, drive it to the overworld with
`tools/gba-play.ts ... --save roms/<name>.state` and bench with
`?rom=<name>`.

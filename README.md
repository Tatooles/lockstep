# Lockstep

A Game Boy emulator for your phone that keeps your Pokémon Nuzlocke honest. It reads the game's memory while you
play, so the bookkeeping happens on its own.

**Try it:** https://lockstep.tatooles.dev. It runs entirely in your browser; on a phone, add it to your home
screen to play full screen and offline.

## What it tracks


- **First encounter per area**: the route chip lights up when an area's encounter is still available, then shows
  what you caught or missed. Dupes clause, gift handling and per-floor vs grouped areas are configurable.
- **Catches, gifts, trades and your starter** are logged with where you met them.
- **Deaths**: a Pokémon that faints goes to the graveyard with what killed it and where. Sending it back into battle is flagged.
- **Level caps**: the next gym leader's (or Elite Four member's) strongest level, read from the ROM's trainer data.
- **Battle helper**: enemy types, base stats and moves; trainer teams; how each of your moves fares against it.
- **Route info**: every wild Pokémon on the current map (grass, surfing, Super Rod) with real encounter odds.
- **Rules**: force Set battle style, flag items used in battle, disable save states for hardcore runs.
- 1×/2×/4×/8× fast-forward, save states, `.sav` import/export, and offline install as a PWA.

## Auto-grind

Tap **Grind**, pick a target level (it defaults to the next level cap), and Lockstep plays the real game for you at
full speed (about 50–60× in a desktop browser). It paces in the tall grass where you're standing, battles wild
Pokémon with your lead using its best move, heals with Potions between battles, and runs from anything that could
knock your lead out, critical hits included. It's real EXP, real stat EXP and real RNG, not a Rare Candy.

It stops and hands control back for the parts worth playing: the area's first encounter (or, with no run going, a
species you haven't caught), trainers, a move to learn, an evolution and a faint. Faints count. Pressing any button
takes over. The bot reads the game's call stack to know which menu is up, so it never presses blindly.

Tracking works with English **Pokémon Red, Blue and Yellow**. Any other DMG game still plays.

**Game Boy Advance.** Lockstep also plays `.gba` games on its own GBA core, built for Gen 3 Pokémon (Ruby, Sapphire,
Emerald, FireRed, LeafGreen): sound, L and R, fast-forward, save states, `.sav` import/export and the cartridge
clock from your device's time. There's no Nuzlocke tracking for GBA games yet; they just play.

**Bring your own ROM.** Nothing copyrighted ships with the app. Species names, sprites, moves and encounter tables
are decoded at runtime from the ROM you load, which stays in your browser (IndexedDB) and is never uploaded.

## How it's built

| Path | What |
| --- | --- |
| `wasm-core/` | The emulator, in Rust: SM83 CPU (M-cycle accurate), PPU, APU, timer, MBC1/2/3/5. Compiled to WebAssembly; no dependencies. |
| `src/core/` | The built `lockstep_core.wasm`, its TypeScript wrapper (`gameboy.ts`) and loader, and the cartridge header parser. |
| `wasm-gba/` | The Game Boy Advance core, in Rust: ARM7TDMI, PPU, sound, DMA/timers, Flash/SRAM saves, RTC, HLE BIOS. See its README. |
| `src/gba/` | The built `lockstep_gba.wasm`, its wrapper, loader, play session and audio resampler. |
| `src/gen1/` | Gen 1 knowledge: RAM reader and event differ, ROM data reader, pic decompressor, map names. |
| `src/run/` | Nuzlocke rules engine. Pure functions from game events to run state, unit-tested. |
| `src/bot/` | Auto-grind: reads which screen the game is on from its call stack, picks battle moves, drives the buttons. |
| `src/platform/` | Frame loop, audio worklet output, IndexedDB storage. |
| `src/ui/` | React UI. |

RAM and ROM addresses come from the [pret](https://github.com/pret) disassemblies' symbol files
(`tools/gen-gen1-data.ts` generates `src/gen1/symbols.ts` and `src/gen1/maps.ts`).

## Develop

```sh
pnpm install
pnpm dev          # http://localhost:5173 (also on your LAN for phone testing)
pnpm test         # unit tests
pnpm build        # typecheck + production build
pnpm wasm         # rebuild src/core/lockstep_core.wasm from wasm-core/ (needs Rust)
node tools/build-wasm-gba.ts   # rebuild src/gba/lockstep_gba.wasm from wasm-gba/
```

The built `.wasm` is committed, so `pnpm dev`, `pnpm build` and deploys don't need Rust. To change the emulator,
install [rustup](https://rustup.rs), run `rustup target add wasm32-unknown-unknown`, then `pnpm wasm` after each
change and check it with the test ROMs below.

### Conformance and benchmarks

```sh
# test ROMs: https://github.com/c-sp/game-boy-test-roms (v7.0), unzipped into ./test-roms
node tools/run-test-roms.ts [filter]   # blargg, dmg-acid2, mooneye
node tools/bench.ts [rom]              # frames/sec, headless
node tools/pic-roundtrip.ts            # pic decoder vs pret's pkmncompress (needs vendor-data/pictest)
node tools/e2e.ts [rom]                # phone-viewport browser smoke test
node tools/play.ts <rom> -e "..."      # scripted headless play to test tracking and auto-grind (commands in its header)
```

Current results: blargg `cpu_instrs`, `instr_timing`, `mem_timing`, `mem_timing-2`, `halt_bug` and dmg-acid2 pass;
`dmg_sound` passes 9 of 12; 84 of 94 DMG-compatible mooneye tests pass. On an M-series Mac it runs at about 80×
real time in V8 (Chrome, Node) and 55–90× in JavaScriptCore (Safari), roughly twice the speed of the TypeScript
core it replaced (in git history before the Rust port, with identical output frame for frame).

## Controls

On a phone, use the on-screen pad. On a computer: arrows or WASD, **X**/K = A, **Z**/J = B, Enter = Start,
Shift = Select, Space = speed, P = pause. Standard gamepads work too (RB/RT changes speed).

## Legal

Lockstep is an unofficial fan project. It is not affiliated with, endorsed by or sponsored by Nintendo, Game Freak,
Creatures Inc. or The Pokémon Company. Pokémon and Game Boy are trademarks of their respective owners and are named
here only to describe compatibility.

This repository contains no game ROMs, BIOS files, graphics, music or other game assets, and none are downloaded by
the app. Everything game-specific is read at runtime from a ROM you supply. Only use games you own.

## License

[MIT](LICENSE). The license covers this project's own code only, not any game you run with it.

// Headless game driver for integration testing the tracker against a real ROM.
//   node tools/play.ts <rom.gb> <script.txt | -e "commands"> [--state in.state] [--save out.state]
//
// Script commands (one per line or ';'-separated):
//   wait N            run N frames
//   tap BUTTON [N]    press for 6 frames then release, N times (with 10-frame gaps)
//   hold BUTTON N     hold for N frames
//   walk DIR N        hold DIR for N*16 frames (N tiles)
//   shot NAME         write tools/out/play-NAME.png
//   snap              print a tracker snapshot summary
//   mash N [BUTTON]   tap A (or BUTTON) every 20 frames for N taps (skip dialogue)
//   until EXPR N      run until a JS expression over `s` (snapshot) is true, max N frames
//   stopif EXPR       when EXPR over `s` is true, skip ahead to the next `resume` line (or the end)
//   resume            marks where skipping from `stopif` ends
//   repel on|off      endless Repel, like the app setting
//   poke ADDR VAL     write a byte (test setup only, e.g. text speed); numbers may be 0x-prefixed
//   chain             print the game's call chain and what screen the bot thinks is up
//   grind LEVEL [N] [nopotions] [nohandback]  auto-grind the lead to LEVEL (max N frames), handing back on first encounters
//                     (set GRIND_TRACE=<frame> to log every screen change the bot sees from that frame on)
// Buttons: a b start select up down left right

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { Button } from '../src/core/constants.ts';
import type { SaveState } from '../src/core/gameboy.ts';
import { gameBoy } from './core.ts';
import { readMilestones, nextMilestone } from '../src/gen1/milestones.ts';
import { detectVersion, Gen1Data } from '../src/gen1/rom.ts';
import { SYMBOLS } from '../src/gen1/symbols.ts';
import { EventDiffer, Gen1Reader, type Snapshot } from '../src/gen1/watcher.ts';
import { MAPS } from '../src/gen1/maps.ts';
import { applyEvent, newRun, syncMons } from '../src/run/engine.ts';
import { Grinder } from '../src/bot/grinder.ts';
import { callChain, classify } from '../src/bot/screen.ts';

const OUT = join(import.meta.dirname, 'out');
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const romPath = args[0];
if (!romPath) throw new Error('usage: node tools/play.ts <rom> <script|-e cmds>');
let script = '';
let stateIn: string | null = null;
let stateOut: string | null = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '-e') script = args[++i];
  else if (args[i] === '--state') stateIn = args[++i];
  else if (args[i] === '--save') stateOut = args[++i];
  else script = readFileSync(args[i], 'utf8');
}

const rom = new Uint8Array(readFileSync(romPath));
const gb = gameBoy(rom);
gb.apu.outputEnabled = false;
const version = detectVersion(rom);
if (!version) throw new Error('not a supported Gen 1 ROM');
const data = new Gen1Data(rom, version);
const reader = new Gen1Reader(SYMBOLS[version]);
const REPEL_ADDR = SYMBOLS[version].wRepelRemainingSteps;
const differ = new EventDiffer();
const run = newRun({ name: 'Harness', romKey: 'harness', version });
const milestones = readMilestones(data);
const ram = { u8: (a: number) => gb.peek(a) };

function reviveState(o: unknown): unknown {
  if (o && typeof o === 'object') {
    const r = o as Record<string, unknown>;
    if (r.__u8) return Uint8Array.from(r.__u8 as number[]);
    for (const k of Object.keys(r)) r[k] = reviveState(r[k]);
  }
  return o;
}
if (stateIn) gb.loadState(reviveState(JSON.parse(readFileSync(stateIn, 'utf8'))) as SaveState);

let frame = 0;
let repel = false;
let last: Snapshot | null = null;
function step(n = 1): void {
  for (let i = 0; i < n; i++) {
    gb.runFrame();
    frame++;
    if (frame % 4 === 0) {
      const s = reader.read(ram);
      if (!s.valid) continue;
      if (repel) gb.bus.write(REPEL_ADDR, 0xff);
      last = s;
      for (const ev of differ.update(s)) {
        const notices = applyEvent(run, ev, { data, snap: s });
        const desc = ev.type === 'battle-start' ? `${ev.kind} ${data.speciesName(ev.enemy.species)} L${ev.enemy.level}` : ev.type === 'acquired' ? `${data.speciesName(ev.mon.species)} inBattle=${ev.duringBattle}` : ev.type === 'map' ? `${MAPS[ev.from]?.name} -> ${MAPS[ev.to]?.name}` : ev.type === 'fainted' || ev.type === 'sent-out' ? `${ev.mon.nickname}` : '';
        console.log(`[f${frame}] event ${ev.type} ${desc}`);
        for (const n2 of notices) console.log(`        notice(${n2.tone}): ${n2.title}${n2.body ? ' — ' + n2.body : ''}`);
      }
      syncMons(run, s, data);
    }
  }
}

const BTN: Record<string, number> = {
  a: Button.A, b: Button.B, start: Button.Start, select: Button.Select,
  up: Button.Up, down: Button.Down, left: Button.Left, right: Button.Right,
};
const SHADES = [0xff, 0xaa, 0x55, 0x00];

function shot(name: string): void {
  const png = new PNG({ width: 160, height: 144 });
  gb.ppu.frame.forEach((v, i) => {
    png.data.set([SHADES[v], SHADES[v], SHADES[v], 255], i * 4);
  });
  writeFileSync(join(OUT, `play-${name}.png`), PNG.sync.write(png));
  console.log(`[f${frame}] shot ${name}`);
}

function summary(): void {
  const s = last;
  if (!s) return console.log('no valid snapshot yet');
  const cap = nextMilestone(milestones, s.badges);
  console.log(
    `[f${frame}] ${s.playerName} map=${MAPS[s.mapId]?.name}(${s.mapId}) xy=${s.x},${s.y} battle=${s.inBattle} badges=${s.badges.toString(2)} cap=${cap?.name}:${cap?.ace}`,
  );
  for (const m of s.party) console.log(`        ${m.nickname} ${data.speciesName(m.species)} L${m.level} ${m.hp}/${m.maxHp} moves=${m.moves.filter(Boolean).map((x) => data.moves[x]?.name).join(',')}`);
  if (s.enemy) console.log(`        enemy ${data.speciesName(s.enemy.species)} L${s.enemy.level} ${s.enemy.hp}/${s.enemy.maxHp}`);
}

let skipping = false;
for (const raw of script.split(/[\n;]/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  if (line === 'resume') {
    skipping = false;
    continue;
  }
  if (skipping) continue;
  const [cmd, a1, a2] = line.split(/\s+/);
  const n = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));
  switch (cmd) {
    case 'wait':
      step(n(a1, 60));
      break;
    case 'tap':
      for (let i = 0; i < n(a2, 1); i++) {
        gb.setButton(BTN[a1], true);
        step(6);
        gb.setButton(BTN[a1], false);
        step(10);
      }
      break;
    case 'hold':
      gb.setButton(BTN[a1], true);
      step(n(a2, 30));
      gb.setButton(BTN[a1], false);
      step(2);
      break;
    case 'walk':
      gb.setButton(BTN[a1], true);
      step(n(a2, 1) * 16);
      gb.setButton(BTN[a1], false);
      step(4);
      break;
    case 'mash':
      for (let i = 0; i < n(a1, 10); i++) {
        gb.setButton(BTN[a2 ?? 'a'], true);
        step(4);
        gb.setButton(BTN[a2 ?? 'a'], false);
        step(16);
      }
      break;
    case 'move': {
      // Walk N tiles, confirming each by the player's coordinates (stops early when blocked).
      const sym = SYMBOLS[version];
      const pos = () => `${gb.peek(sym.wXCoord)},${gb.peek(sym.wYCoord)},${gb.peek(sym.wCurMap)}`;
      let moved = 0;
      gb.setButton(BTN[a1], true);
      for (let t = 0; t < n(a2, 1); t++) {
        const from = pos();
        let f = 0;
        while (pos() === from && f < 48) {
          step(1);
          f++;
        }
        if (pos() === from) break;
        moved++;
      }
      gb.setButton(BTN[a1], false);
      step(16);
      if (moved < n(a2, 1)) console.log(`[f${frame}] move ${a1}: blocked after ${moved}`);
      break;
    }
    case 'repel':
      // Same as the app's Endless Repel setting.
      repel = a1 === 'on';
      if (!repel) gb.bus.write(REPEL_ADDR, 0);
      break;
    case 'poke':
      // Test setup only (e.g. text speed); the tracker never writes memory.
      gb.bus.write(Number(a1), Number(a2));
      break;
    case 'grind': {
      const target = n(a1, 100);
      const problem = Grinder.problem(gb, data, target);
      if (problem) {
        console.log(`[f${frame}] grind: can't start: ${problem}`);
        break;
      }
      const bot = new Grinder(gb, data, {
        targetLevel: target,
        usePotions: !line.includes('nopotions'),
        handBack: () => {
          if (line.includes('nohandback')) return null;
          const enc = run.encounters.find((e) => e.id === run.activeEncounterId);
          return enc?.outcome === 'pending' ? `First encounter: ${data.speciesName(enc.species)}` : null;
        },
      });
      const max = n(a2, 200000);
      const t0 = performance.now();
      let end = null;
      let lastActivity = '';
      let traceLast = '';
      for (let i = 0; i < max && !end; i++) {
        step(1);
        end = bot.step();
        if (process.env.GRIND_TRACE && frame >= Number(process.env.GRIND_TRACE)) {
          const c = callChain(gb, data.sym);
          const t = `${classify(c)} ${c.join('<')} bank=${gb.cart.currentRomBank} pc=${gb.cpu.pc.toString(16)}`;
          if (t !== traceLast) console.log(`[f${frame}] ${t}`);
          traceLast = t;
        }
        const p = bot.getProgress();
        if (p.activity !== lastActivity) {
          lastActivity = p.activity;
          const s = last as Snapshot | null;
          const hp = s?.party[0] ? `${s.party[0].hp}/${s.party[0].maxHp}` : '';
          console.log(`[f${frame}] grind: ${p.activity} (L${p.level}, ${p.battles} battles, hp ${hp})`);
        }
      }
      bot.dispose();
      const p = bot.getProgress();
      const secs = (performance.now() - t0) / 1000;
      console.log(`[f${frame}] grind ${end ? end.kind + ': ' + end.message : 'TIMEOUT'} | L${p.startLevel}->L${p.level}, ${p.battles} battles, ran ${p.ran}, ${p.frames} frames (${(p.frames / 60 / 60).toFixed(1)} game min) in ${secs.toFixed(1)}s = ${(p.frames / 59.73 / secs).toFixed(0)}x`);
      break;
    }
    case 'chain': {
      const c = callChain(gb, data.sym);
      console.log(`[f${frame}] screen=${classify(c)} chain=${c.join(' < ')}`);
      break;
    }
    case 'shot':
      shot(a1 ?? String(frame));
      break;
    case 'snap':
      summary();
      break;
    case 'stopif': {
      const expr = line.slice(7);
      const fn = new Function('s', `return (${expr});`) as (s: Snapshot | null) => boolean;
      if (fn(last)) {
        console.log(`[f${frame}] stopif met: ${expr}`);
        skipping = true;
      }
      break;
    }
    case 'until': {
      const expr = line.slice(6).replace(/\s+\d+$/, '');
      const max = Number(/\s(\d+)$/.exec(line)?.[1] ?? 3600);
      const fn = new Function('s', `return (${expr});`) as (s: Snapshot | null) => boolean;
      let i = 0;
      while (i < max && !fn(last)) {
        step(4);
        i += 4;
      }
      console.log(`[f${frame}] until ${fn(last) ? 'met' : 'TIMEOUT'}: ${expr}`);
      break;
    }
    default:
      console.log(`unknown command: ${cmd}`);
  }
}

if (stateOut) {
  const replacer = (_k: string, v: unknown) => (v instanceof Uint8Array ? { __u8: Array.from(v) } : v);
  writeFileSync(stateOut, JSON.stringify(gb.saveState(), replacer));
  console.log(`saved state to ${stateOut}`);
}
console.log(`\nrun: ${run.encounters.length} encounters, ${Object.keys(run.mons).length} mons, ${run.timeline.length} timeline entries`);
for (const t of run.timeline) console.log(`  - ${t.kind}: ${t.text}`);

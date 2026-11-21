// Drive a Gen 3 game with scripted input while the Nuzlocke tracker watches,
// printing every event and notice (the GBA counterpart of tools/play.ts).
//   node tools/gen3-track.ts <rom> "<steps>" [--from in.state] [--save out.state] [--shot out.png]
//     [--run run.json] [--poke "addr=value,..."] [--balls N] [--stop-on <event type>]
// Steps are as in tools/gba-play.ts: "N" waits N frames, "N:A+Up" holds keys.
// --run keeps the run between invocations (created if missing). --poke writes
// bytes before starting; --balls N puts N Poké Balls in the bag (for tests).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Key } from '../src/gba/gba.ts';
import { detectGen3, Gen3Data } from '../src/gen3/rom.ts';
import { Gen3Reader, workRam } from '../src/gen3/reader.ts';
import { applyEvent, newRun, syncMons } from '../src/run/engine.ts';
import { EventDiffer, type Snapshot } from '../src/run/events.ts';
import type { Run } from '../src/run/types.ts';
import { gba, screenshot } from './gba.ts';

const [romPath, script = ''] = process.argv.slice(2);
const opt = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const rom = new Uint8Array(readFileSync(romPath));
const game = detectGen3(rom);
if (!game) throw new Error('Not a supported Gen 3 ROM');
const data = new Gen3Data(rom, game);
const g = gba(rom);
const from = opt('--from');
if (from) g.loadState(new Uint8Array(readFileSync(from)));
for (const p of (opt('--poke') ?? '').split(',').filter(Boolean)) {
  const [a, v] = p.split('=').map((x) => Number(x));
  g.x.poke8(a, v);
}
const mem = workRam(g.ewram, g.iwram);
const balls = opt('--balls');
if (balls) {
  // First Poké Ball pocket slot; quantities are XORed with the save's key on E and FR/LG.
  const r = data.ram;
  const sb1 = r.saveBlock1Ptr ? mem.u32(r.saveBlock1Ptr) : r.saveBlock1!;
  const sb2 = r.saveBlock2Ptr ? mem.u32(r.saveBlock2Ptr) : r.saveBlock2!;
  const [pocket, keyOff] = { rs: [0x600, -1], e: [0x650, 0xac], frlg: [0x430, 0xf20] }[data.gameFamily];
  const key = keyOff >= 0 ? mem.u32(sb2 + keyOff) & 0xffff : 0;
  g.x.poke16(sb1 + pocket, 4);
  g.x.poke16(sb1 + pocket + 2, (Number(balls) ^ key) & 0xffff);
}
const reader = new Gen3Reader(data);
const runPath = opt('--run');
const run: Run = runPath && existsSync(runPath) ? JSON.parse(readFileSync(runPath, 'utf8')) : newRun({ name: 'Test', romKey: 'k', version: game.version });
const differ = new EventDiffer({ wildStartDelay: 2, isBall: (i) => data.isBall(i) });
differ.seedKnown(Object.keys(run.mons));

const name = (s: number) => data.speciesName(s);
const describe = (s: Snapshot) =>
  `${data.mapName(s.mapId)} (${s.mapId >> 8}.${s.mapId & 0xff} @${s.x},${s.y}) ${s.playerName} badges=${s.badges.toString(2)} ` +
  `party=[${s.party.map((m) => `${name(m.species)} L${m.level} ${m.hp}/${m.maxHp}`).join(', ')}] pc=${s.box.length}` +
  `${s.inBattle ? ` battle=${s.inBattle} type=0x${s.battleType.toString(16)} enemy=${s.enemy ? `${name(s.enemy.species)} L${s.enemy.level} ${s.enemy.hp}/${s.enemy.maxHp}` : '-'}` : ''}`;

const stopOn = opt('--stop-on');
let stopped = false;
let frame = 0;
let last: Snapshot | null = null;
const sample = () => {
  const s = reader.read(mem);
  if (!s.valid) return;
  last = s;
  for (const ev of differ.update(s)) {
    const notices = applyEvent(run, ev, { data, snap: s });
    const desc =
      ev.type === 'battle-start' ? `${ev.kind} ${name(ev.enemy.species)} L${ev.enemy.level} type=0x${ev.battleType.toString(16)}`
      : ev.type === 'acquired' ? `${name(ev.mon.species)} "${ev.mon.nickname}" duringBattle=${ev.duringBattle} foreign=${ev.foreign}`
      : ev.type === 'map' ? `${data.mapName(ev.from)} -> ${data.mapName(ev.to)}`
      : ev.type === 'fainted' || ev.type === 'sent-out' ? ev.mon.nickname
      : ev.type === 'loaded' ? describe(ev.snap)
      : ev.type === 'badge' ? data.badgeName(ev.index)
      : '';
    console.log(`[f${frame}] ${ev.type} ${desc}`);
    if (ev.type === stopOn) stopped = true;
    for (const n of notices) console.log(`        ${n.tone}: ${n.title}${n.body ? ` — ${n.body}` : ''}`);
  }
  syncMons(run, s, data);
};

script
  .split(/\s+/)
  .filter(Boolean)
  .forEach((step) => {
    const [n, keys = ''] = step.split(':');
    const mask = keys
      .split('+')
      .filter(Boolean)
      .reduce((m, k) => m | Key[k as keyof typeof Key], 0);
    for (let f = 0; f < Number(n) && !stopped; f++) {
      g.setKeys(mask);
      g.runFrame();
      if (++frame % 4 === 0) sample();
    }
  });
g.setKeys(0);
sample();
if (last) console.log(`end f${frame}: ${describe(last)}`);
else console.log(`end f${frame}: no valid snapshot`);
const save = opt('--save');
if (save) writeFileSync(save, g.saveState());
const shot = opt('--shot');
if (shot) screenshot(g, shot);
if (runPath) writeFileSync(runPath, JSON.stringify(run, null, 1));

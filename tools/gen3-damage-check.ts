// Checks the battle tab's Gen 3 damage ranges against the game itself. From a
// save state at the battle menu, it pokes gBattleMons fields (stats, stages,
// ability, item, types, moves…), uses a move after waiting k frames (so each
// try gets a different random roll), and compares the HP each side loses with
// the predicted ranges.
//   node tools/gen3-damage-check.ts <rom> <state> <moveSlot 0-3> <tries> ["me.atk=120,foe.ability=47,weather=1,..."]
// Fields: species atk def spe spa spd move0-3 pp0-3 ivs satk sdef sspe sspa sspd (stages, 6 = neutral)
// ability type1 type2 hp maxhp level friendship item status; also weather, side0, side1 (gSideStatuses).
import { readFileSync } from 'node:fs';
import { Key } from '../src/gba/gba.ts';
import { detectGen3, Gen3Data } from '../src/gen3/rom.ts';
import { Gen3Reader, workRam } from '../src/gen3/reader.ts';
import { gba } from './gba.ts';

const [romPath, statePath, slotArg = '0', triesArg = '8', pokes = ''] = process.argv.slice(2);
const rom = new Uint8Array(readFileSync(romPath));
const data = new Gen3Data(rom, detectGen3(rom)!);
const state = new Uint8Array(readFileSync(statePath));
const slot = Number(slotArg);
// gBattleMons field offsets and sizes.
const FIELDS: Record<string, [number, number]> = {
  species: [0, 2], atk: [2, 2], def: [4, 2], spe: [6, 2], spa: [8, 2], spd: [10, 2],
  move0: [12, 2], move1: [14, 2], move2: [16, 2], move3: [18, 2], ivs: [0x14, 4],
  satk: [0x19, 1], sdef: [0x1a, 1], sspe: [0x1b, 1], sspa: [0x1c, 1], sspd: [0x1d, 1],
  ability: [0x20, 1], type1: [0x21, 1], type2: [0x22, 1], pp0: [0x24, 1], pp1: [0x25, 1], pp2: [0x26, 1], pp3: [0x27, 1],
  hp: [0x28, 2], level: [0x2a, 1], friendship: [0x2b, 1], maxhp: [0x2c, 2], item: [0x2e, 2], status: [0x4c, 4],
};
const extra: Record<string, number> = { weather: data.ram.battleWeather!, side0: data.ram.sideStatuses!, side1: data.ram.sideStatuses! + 2 };
let totalBad = 0;
for (let k = 0; k < Number(triesArg); k++) {
  const g = gba(rom);
  g.loadState(state);
  const mem = workRam(g.ewram, g.iwram);
  const reader = new Gen3Reader(data);
  const step = (n: number, keys = 0) => {
    for (let i = 0; i < n; i++) {
      g.setKeys(keys);
      g.runFrame();
    }
  };
  step(k * 7 + 1);
  for (const p of pokes.split(',').filter(Boolean)) {
    const [lhs, v] = p.split('=');
    const val = Number(v);
    if (extra[lhs] !== undefined) {
      g.x.poke16(extra[lhs], val);
      continue;
    }
    const [who, field] = lhs.split('.');
    const [off, size] = FIELDS[field];
    const a = data.ram.battleMons! + (who === 'foe' ? 0x58 : 0) + off;
    if (size === 1) g.x.poke8(a, val);
    else if (size === 2) g.x.poke16(a, val);
    else (g.x.poke16(a, val & 0xffff), g.x.poke16(a + 2, val >>> 16));
  }
  const before = reader.read(mem);
  const info = data.battle(before)!;
  step(4, Key.A);
  step(40);
  for (let i = 0; i < slot % 2; i++) (step(4, Key.Right), step(10));
  for (let i = 0; i < slot >> 1; i++) (step(4, Key.Down), step(10));
  step(4, Key.A);
  // Watch HP each frame and record each drop (a hit), until 900 frames pass.
  const foeHits: number[] = [];
  const myHits: number[] = [];
  let prev = before;
  for (let f = 0; f < 900; f++) {
    step(1);
    const s = reader.read(mem);
    if (!s.valid || !s.enemy || !s.battleMon) continue;
    if (s.enemy.hp < prev.enemy!.hp) foeHits.push(prev.enemy!.hp - s.enemy.hp);
    if (s.battleMon.hp < prev.battleMon!.hp) myHits.push(prev.battleMon!.hp - s.battleMon.hp);
    prev = s;
  }
  const mine = info.danger!.mine[slot];
  const r = mine.result;
  const ok = (n: number, x: { min: number; max: number; critMin: number; critMax: number }) =>
    n >= x.min && n <= x.max ? 'OK' : n >= x.critMin && n <= x.critMax ? 'OK(crit)' : 'MISMATCH';
  const mineVerdict = foeHits.map((n) => `${n} ${ok(n, r)}`).join(', ') || 'no hit';
  const theirs = info.danger!.theirs;
  const theirVerdict = myHits.map((n) => `${n} ${theirs.some((t) => ok(n, t.result) !== 'MISMATCH') ? 'OK' : 'MISMATCH'}`).join(', ') || 'no hit';
  if (mineVerdict.includes('MISMATCH') || theirVerdict.includes('MISMATCH')) totalBad++;
  console.log(
    `try ${k}: ${mine.name} [${r.kind} ${r.min}-${r.max} crit ${r.critMin}-${r.critMax}${r.reason ? ` ${r.reason}` : ''}] foe lost: ${mineVerdict}` +
      ` | theirs [${theirs.map((t) => `${t.name} ${t.result.kind} ${t.result.min}-${t.result.max}/${t.result.critMin}-${t.result.critMax}`).join('; ')}] I lost: ${theirVerdict}`,
  );
}
console.log(totalBad ? `${totalBad} tries with mismatches` : 'all consistent');

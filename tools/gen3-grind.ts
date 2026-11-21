// Run Gen 3 auto-grind headlessly from a save state and report what it did.
//   node tools/gen3-grind.ts <rom> <state> [--target N] [--no-potions] [--frames N]
//     [--poke "addr=value,..."] [--hp N] [--trace] [--shot out.png] [--save out.state]
//     [--handback new|none] [--repel] [--potions N]
//     [--exp N] [--level N]   (rewrite the lead's experience and level byte)
// --hp N sets the lead's current HP (party and nothing else) before starting, to
// exercise healing. --trace prints every screen change. --handback new hands back
// on species not caught yet (the no-run rule); none never hands back.
import { readFileSync, writeFileSync } from 'node:fs';
import { dexOwned, Grinder3, repelCounter } from '../src/bot/grinder3.ts';
import { probe3, classify3 } from '../src/bot/screen3.ts';
import { detectGen3, Gen3Data } from '../src/gen3/rom.ts';
import { Gen3Reader, workRam } from '../src/gen3/reader.ts';
import { gba, screenshot } from './gba.ts';

const [romPath, statePath] = process.argv.slice(2);
const opt = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(name);
const rom = new Uint8Array(readFileSync(romPath));
const game = detectGen3(rom);
if (!game) throw new Error('Not a supported Gen 3 ROM');
const data = new Gen3Data(rom, game);
const g = gba(rom);
g.loadState(new Uint8Array(readFileSync(statePath)));
for (const p of (opt('--poke') ?? '').split(',').filter(Boolean)) {
  const [a, v] = p.split('=').map((x) => Number(x));
  g.x.poke8(a, v);
}
const mem = workRam(g.ewram, g.iwram);
const reader = new Gen3Reader(data);
const potions = opt('--potions');
if (potions) {
  // Put Potions in the first free Items pocket slot; quantities are XORed with the save's key on E and FR/LG.
  const r = data.ram;
  const sb1 = r.saveBlock1Ptr ? mem.u32(r.saveBlock1Ptr) : r.saveBlock1!;
  const sb2 = r.saveBlock2Ptr ? mem.u32(r.saveBlock2Ptr) : r.saveBlock2!;
  const [pocket, keyOff] = { rs: [0x560, -1], e: [0x560, 0xac], frlg: [0x310, 0xf20] }[data.gameFamily];
  const key = keyOff >= 0 ? mem.u32(sb2 + keyOff) & 0xffff : 0;
  let slot = 0;
  while (mem.u16(sb1 + pocket + slot * 4) && mem.u16(sb1 + pocket + slot * 4) !== 13) slot++;
  g.x.poke16(sb1 + pocket + slot * 4, 13);
  g.x.poke16(sb1 + pocket + slot * 4 + 2, (Number(potions) ^ key) & 0xffff);
}
const exp = opt('--exp');
if (exp) {
  // Rewrite the lead's experience: decrypt its substructures, change Growth's exp, fix the checksum.
  const base = data.ram.playerParty!;
  const pid = mem.u32(base);
  const key = (pid ^ mem.u32(base + 4)) >>> 0;
  const words = Array.from({ length: 12 }, (_, i) => (mem.u32(base + 32 + i * 4) ^ key) >>> 0);
  const order = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG',
    'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'][pid % 24];
  words[order.indexOf('G') * 3 + 1] = Number(exp) >>> 0;
  let sum = 0;
  for (const w of words) sum += (w & 0xffff) + (w >>> 16);
  g.x.poke16(base + 28, sum & 0xffff);
  words.forEach((w, i) => {
    const v = (w ^ key) >>> 0;
    g.x.poke16(base + 32 + i * 4, v & 0xffff);
    g.x.poke16(base + 34 + i * 4, v >>> 16);
  });
}
const level = opt('--level');
if (level) g.x.poke8(data.ram.playerParty! + 84, Number(level));
const hp = opt('--hp');
if (hp) {
  const base = data.ram.playerParty!;
  g.x.poke16(base + 86, Number(hp));
}
const start = reader.read(mem);
const lead = start.party[0];
console.log(`start: ${data.mapName(start.mapId)} @${start.x},${start.y} lead=${lead ? `${data.speciesName(lead.species)} L${lead.level} ${lead.hp}/${lead.maxHp}` : '-'} bag potions=${start.bag[13] ?? 0}`);
const target = Number(opt('--target') ?? (lead ? lead.level + 1 : 5));
const problem = Grinder3.problem(mem, data, target);
if (problem) {
  console.log(`problem: ${problem}`);
  process.exit(1);
}
const handbackMode = opt('--handback') ?? 'none';
const grinder = new Grinder3(mem, data, (a, v) => g.x.poke8(a, v), {
  targetLevel: target,
  usePotions: !flag('--no-potions'),
  handBack: (snap) => {
    if (handbackMode !== 'new' || !snap.enemy) return null;
    const owned = dexOwned(mem, data, snap.enemy.species);
    return owned === false ? `Wild ${data.speciesName(snap.enemy.species)}: you haven't caught one yet.` : null;
  },
});
const limit = Number(opt('--frames') ?? 200000);
const trace = flag('--trace');
const repel = flag('--repel');
let last = '';
let end = null;
let f = 0;
const t0 = performance.now();
for (; f < limit; f++) {
  g.setKeys(grinder.keys);
  g.render = false;
  g.runFrame();
  if (repel) {
    const a = repelCounter(mem, data);
    if (a) g.x.poke16(a, 250);
  }
  end = grinder.step();
  if (trace) {
    const p = probe3(mem, data);
    const s = classify3(p);
    const line = `${s} main=${p.main} ctl=${p.controller} op=${p.scriptOp.toString(16)} text=${p.textWaiting} sm=${p.startMenu} bag=${p.bag} ctx=${p.itemContext} party=${p.party}`;
    if (line !== last) console.log(`[f${f}] ${line} keys=${grinder.keys.toString(2)} | ${grinder.getProgress().activity}`);
    last = line;
  }
  if (end) break;
}
const ms = performance.now() - t0;
const p = grinder.getProgress();
const snap = reader.read(mem);
const l = snap.party[0];
console.log(`end after ${f} frames (${(f / 60).toFixed(0)}s game, ${(ms / 1000).toFixed(1)}s wall, ${((f / 60) / (ms / 1000)).toFixed(0)}x): ${end ? `${end.kind}: ${end.message}` : 'frame limit'}`);
console.log(`progress: Lv ${p.startLevel} -> ${p.level}, ${p.battles} battles, ran ${p.ran}; lead now ${l ? `${data.speciesName(l.species)} L${l.level} ${l.hp}/${l.maxHp} pp=${l.pp.join(',')}` : '-'} potions=${snap.bag[13] ?? 0}`);
grinder.dispose();
const shot = opt('--shot');
if (shot) {
  g.render = true;
  g.setKeys(0);
  g.runFrame();
  screenshot(g, shot);
}
const save = opt('--save');
if (save) writeFileSync(save, g.saveState());

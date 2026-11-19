// Dev-only visual fixture (/?fixture&tab=battle) rendering the run panel with
// synthetic data, so layouts can be checked without a ROM.

import { useState } from 'react';
import type { Gen1Data, Move, Species } from '../gen1/rom.ts';
import { readMilestones } from '../gen1/milestones.ts';
import type { Snapshot } from '../gen1/watcher.ts';
import { newRun } from '../run/engine.ts';
import type { Session, SessionView } from '../platform/session.ts';
import { Sheet, type TabId } from './Sheet.tsx';

function sp(index: number, dex: number, name: string, types: [number, number], base: number[]): Species {
  const [hp, atk, def, spd, spc] = base;
  return {
    index, dex, name, types, base: { hp, atk, def, spd, spc }, catchRate: 45, baseExp: 64, growth: 3,
    evolutions: [], learnset: [], picPtr: 0, picBank: 0, picDims: 0x55, family: dex,
  };
}

const species = new Map<number, Species>([
  [0x99, sp(0x99, 1, 'Bulbasaur', [0x16, 0x03], [45, 49, 49, 45, 65])],
  [0x24, sp(0x24, 16, 'Pidgey', [0x00, 0x02], [40, 45, 40, 56, 35])],
  [0xa5, sp(0xa5, 19, 'Rattata', [0x00, 0x00], [30, 56, 35, 72, 25])],
  [0x22, sp(0x22, 95, 'Onix', [0x05, 0x04], [35, 45, 160, 70, 30])],
  [0xa9, sp(0xa9, 74, 'Geodude', [0x05, 0x04], [40, 80, 100, 20, 30])],
  [0x70, sp(0x70, 13, 'Weedle', [0x07, 0x03], [40, 35, 30, 50, 20])],
]);
const mv = (id: number, name: string, type: number, power: number, effect = 0): Move => ({ id, name, effect, power, type, accuracy: 100, pp: 35 });
const moves: Move[] = [];
moves[0] = mv(0, '—', 0, 0);
moves[0x21] = mv(0x21, 'Tackle', 0x00, 35);
moves[0x2d] = mv(0x2d, 'Growl', 0x00, 0, 0x12);
moves[0x16] = mv(0x16, 'Vine Whip', 0x16, 35);
moves[0x49] = mv(0x49, 'Leech Seed', 0x16, 0, 0x54);
moves[0x58] = mv(0x58, 'Rock Throw', 0x05, 50);
moves[0x14] = mv(0x14, 'Bind', 0x00, 15, 0x2a);
moves[0x67] = mv(0x67, 'Screech', 0x00, 0, 0x3b);
moves[0x75] = mv(0x75, 'Bide', 0x00, 0, 0x1a);

const chart: Record<string, number> = { '22-5': 2, '22-4': 2, '0-5': 0.5, '5-22': 0.5, '5-3': 1, '22-3': 0.5 };
const data = {
  version: 'red',
  rom: new Uint8Array(0x8000),
  species,
  byDex: new Map([...species.values()].map((s) => [s.dex, s])),
  moves,
  items: [],
  trainerClasses: Object.assign([], { 0x22: 'Brock' }),
  speciesName: (i: number) => species.get(i)?.name ?? `#${i}`,
  effectiveness: (a: number, d: [number, number]) => {
    let m = chart[`${a}-${d[0]}`] ?? 1;
    if (d[1] !== d[0]) m *= chart[`${a}-${d[1]}`] ?? 1;
    return m;
  },
  wild: (map: number) =>
    map === 12
      ? {
          grassRate: 25,
          grass: [
            { level: 3, species: 0x24, chance: 0.2 }, { level: 3, species: 0xa5, chance: 0.2 }, { level: 3, species: 0xa5, chance: 0.15 },
            { level: 2, species: 0xa5, chance: 0.1 }, { level: 2, species: 0x24, chance: 0.1 }, { level: 3, species: 0x24, chance: 0.1 },
            { level: 3, species: 0x24, chance: 0.05 }, { level: 4, species: 0xa5, chance: 0.05 }, { level: 4, species: 0x24, chance: 0.04 },
            { level: 5, species: 0x24, chance: 0.01 },
          ],
          waterRate: 0, water: [], superRod: [],
        }
      : null,
  trainerParties: (cls: number) => (cls === 0x22 ? [{ cls, no: 1, mons: [{ level: 12, species: 0xa9 }, { level: 14, species: 0x22 }] }] : []),
} as unknown as Gen1Data;

const party = [
  {
    species: 0x99, nickname: 'SPROUT', level: 13, hp: 31, maxHp: 37, status: 0, types: [0x16, 0x03] as [number, number],
    moves: [0x21, 0x2d, 0x49, 0x16], pp: [35, 40, 10, 10], otId: 1, otName: 'RED', exp: 1500, dvs: 0xabcd,
    stats: { atk: 20, def: 20, spd: 18, spc: 24 }, key: 'k1',
  },
  {
    species: 0x24, nickname: 'GUST', level: 11, hp: 0, maxHp: 30, status: 0, types: [0x00, 0x02] as [number, number],
    moves: [0x21, 0x2d, 0, 0], pp: [35, 40, 0, 0], otId: 1, otName: 'RED', exp: 900, dvs: 0x1111,
    stats: { atk: 16, def: 15, spd: 19, spc: 14 }, key: 'k2',
  },
];

const snap: Snapshot = {
  valid: true, mapId: 12, inBattle: 2, battleType: 0, badges: 0, playerName: 'RED', playerId: 12345, money: 3175,
  party, box: [], boxNum: 1,
  enemy: {
    species: 0x22, level: 14, hp: 30, maxHp: 37, dvs: 0x9999, trainerClass: 0x22, trainerNo: 1, ghost: false,
    types: [0x05, 0x04], moves: [0x21, 0x14, 0x75, 0x67], stats: { atk: 19, def: 44, spd: 23, spc: 14 },
  },
  activeSlot: 0, activeHp: 31,
  battleMon: { species: 0x99, level: 13, hp: 31, maxHp: 37, types: [0x16, 0x03], moves: [0x21, 0x2d, 0x49, 0x16], stats: { atk: 20, def: 20, spd: 18, spc: 24 } },
  playSeconds: 4520, bag: {}, x: 5, y: 7,
};

const run = newRun({ name: 'Red Nuzlocke', romKey: 'fixture', version: 'red' });
run.encounters.push(
  { id: 'a', area: 'Starter', mapId: 40, species: 0x99, level: 5, kind: 'starter', outcome: 'caught', monKey: 'k1', at: Date.now(), playSeconds: 300 },
  { id: 'b', area: 'Route 1', mapId: 12, species: 0x24, level: 3, kind: 'wild', outcome: 'caught', monKey: 'k2', at: Date.now(), playSeconds: 900 },
  { id: 'c', area: 'Route 22', mapId: 33, species: 0xa5, level: 4, kind: 'wild', outcome: 'failed', at: Date.now(), playSeconds: 1300 },
);
run.mons.k1 = { key: 'k1', nickname: 'SPROUT', species: 0x99, originalSpecies: 0x99, level: 13, metLevel: 5, area: 'Starter', mapId: 40, metAt: 0, origin: 'starter', status: 'alive', hp: 31, maxHp: 37, inParty: true };
run.mons.k2 = {
  key: 'k2', nickname: 'GUST', species: 0x24, originalSpecies: 0x24, level: 11, metLevel: 3, area: 'Route 1', mapId: 12, metAt: 0, origin: 'caught', status: 'dead', hp: 0, maxHp: 30, inParty: true,
  death: { at: Date.now(), playSeconds: 4400, level: 11, mapId: 54, area: 'Pewter City', cause: "Brock's Onix (Lv14)" },
};
run.timeline.push(
  { at: Date.now(), playSeconds: 300, kind: 'catch', text: 'Chose Bulbasaur as starter' },
  { at: Date.now(), playSeconds: 900, kind: 'catch', text: 'Route 1: caught Pidgey “GUST”' },
  { at: Date.now(), playSeconds: 1300, kind: 'miss', text: 'Route 22: Rattata got away' },
  { at: Date.now(), playSeconds: 4400, kind: 'death', text: "GUST (Pidgey Lv11) fell to Brock's Onix (Lv14) in Pewter City" },
);

const milestones = readMilestones(data);
const view: SessionView = {
  snap, run, paused: false, speed: 1, toasts: [], warnings: [], milestone: { ...milestones[0], name: 'Brock' }, fps: 60, muted: false, version: 'red', grind: null, grindEnd: null, core: 'wasm', emuMs: 0.21, rev: 1,
};
const session = {
  data, rom: { key: 'fixture', name: 'Fixture', title: 'POKEMON RED' }, updateRun: () => {}, canUseStates: () => true,
  setMuted: () => {}, getView: () => view,
} as unknown as Session;

export function Fixture() {
  const params = new URLSearchParams(location.search);
  const [tab, setTab] = useState<TabId>((params.get('tab') as TabId) ?? 'battle');
  return (
    <div className="play">
      <Sheet session={session} view={view} tab={tab} onTab={setTab} onClose={() => {}} onStartRun={() => {}} onExit={() => {}} docked={false} />
    </div>
  );
}

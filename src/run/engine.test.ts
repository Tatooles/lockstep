import { describe, expect, it } from 'vitest';
import type { Gen1Data, Species } from '../gen1/rom.ts';
import { SYMBOLS } from '../gen1/symbols.ts';
import { EventDiffer, Gen1Reader, type Ram } from '../gen1/watcher.ts';
import { applyEvent, newRun, syncMons, usedAreas } from './engine.ts';
import type { Notice } from './types.ts';

const S = SYMBOLS.red;
const BULBASAUR = 0x99;
const PIDGEY = 0x24;
const PIDGEOTTO = 0x96;
const RATTATA = 0xa5;
const WEEDLE = 0x70;
const OAKS_LAB = 40;
const ROUTE_1 = 12;
const ROUTE_2 = 13;
const ROUTE_22 = 33;

function enc(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    if (ch >= 'A' && ch <= 'Z') out.push(0x80 + ch.charCodeAt(0) - 65);
  }
  out.push(0x50);
  return out;
}

class FakeGame implements Ram {
  mem = new Uint8Array(0x10000);
  u8(a: number): number {
    return this.mem[a];
  }
  w(a: number, bytes: number[]): void {
    this.mem.set(bytes, a);
  }
  constructor() {
    this.w(S.wPlayerName, enc('RED'));
    this.w(S.wPlayerID, [0x12, 0x34]);
    this.w(S.wPartySpecies, [0xff]);
    this.w(S.wBoxSpecies, [0xff]);
    this.mem[S.wCurMap] = OAKS_LAB;
  }
  addParty(species: number, level: number, dvs: number, nick: string, otId = 0x1234): void {
    const n = this.mem[S.wPartyCount];
    this.mem[S.wPartySpecies + n] = species;
    this.mem[S.wPartySpecies + n + 1] = 0xff;
    const b = S.wPartyMons + n * 44;
    this.w(b, [species, 0, 20, level]);
    this.w(b + 12, [otId >> 8, otId & 0xff]);
    this.w(b + 27, [dvs >> 8, dvs & 0xff]);
    this.mem[b + 33] = level;
    this.w(b + 34, [0, 20]);
    this.w(S.wPartyMonOT + n * 11, enc('RED'));
    this.w(S.wPartyMonNicks + n * 11, enc(nick));
    this.mem[S.wPartyCount] = n + 1;
  }
  setHp(slot: number, hp: number): void {
    this.w(S.wPartyMons + slot * 44 + 1, [hp >> 8, hp & 0xff]);
  }
  startWild(species: number, level: number, dvs: number): void {
    this.mem[S.wIsInBattle] = 1;
    this.mem[S.wEnemyMonSpecies] = species;
    this.mem[S.wEnemyMonLevel] = level;
    this.w(S.wEnemyMonDVs, [dvs >> 8, dvs & 0xff]);
    this.w(S.wEnemyMonHP, [0, 15]);
    this.w(S.wEnemyMonNick, enc(species === PIDGEY ? 'PIDGEY' : 'WILD'));
  }
  endBattle(): void {
    this.mem[S.wIsInBattle] = 0;
  }
  giveBalls(n = 5): void {
    this.mem[S.wNumBagItems] = 1;
    this.w(S.wBagItems, [0x04, n, 0xff]);
  }
  /** Put party slot `slot` on the field (wPlayerMonNumber + wBattleMon). */
  sendOut(slot: number): void {
    const b = S.wPartyMons + slot * 44;
    this.mem[S.wPlayerMonNumber] = slot;
    this.mem[S.wBattleMon] = this.mem[b];
    this.w(S.wBattleMon + 1, [this.mem[b + 1], this.mem[b + 2]]);
    this.mem[S.wBattleMon + 14] = this.mem[b + 33];
  }
}

function sp(index: number, dex: number, name: string, family: number): Species {
  return {
    index, dex, name, family, types: [0, 0], base: { hp: 1, atk: 1, def: 1, spd: 1, spc: 1 }, catchRate: 0,
    baseExp: 0, growth: 0, evolutions: [], learnset: [], picPtr: 0, picBank: 0, picDims: 0,
  };
}

const species = new Map<number, Species>([
  [BULBASAUR, sp(BULBASAUR, 1, 'Bulbasaur', 1)],
  [PIDGEY, sp(PIDGEY, 16, 'Pidgey', 16)],
  [PIDGEOTTO, sp(PIDGEOTTO, 17, 'Pidgeotto', 16)],
  [RATTATA, sp(RATTATA, 19, 'Rattata', 19)],
  [WEEDLE, sp(WEEDLE, 13, 'Weedle', 13)],
]);
const data = {
  species,
  speciesName: (i: number) => species.get(i)?.name ?? `#${i}`,
  trainerClasses: [],
} as unknown as Gen1Data;

function harness() {
  const game = new FakeGame();
  const reader = new Gen1Reader(S);
  const differ = new EventDiffer({ wildStartDelay: 1 });
  const run = newRun({ name: 'Test', romKey: 'k', version: 'red' });
  const notices: Notice[] = [];
  const step = () => {
    const snap = reader.read(game);
    for (const ev of differ.update(snap)) notices.push(...applyEvent(run, ev, { data, snap }));
    syncMons(run, snap);
    return snap;
  };
  return { game, run, notices, step };
}

describe('nuzlocke engine', () => {
  it('tracks starter, first encounter, catch, dupes and deaths', () => {
    const { game, run, notices, step } = harness();
    step(); // loaded (no mons)
    game.addParty(BULBASAUR, 5, 0xabcd, 'BULBASAUR');
    step();
    expect(Object.values(run.mons)[0].origin).toBe('starter');

    // Route 1: first encounter Pidgey, caught.
    game.giveBalls();
    game.mem[S.wCurMap] = ROUTE_1;
    step();
    game.startWild(PIDGEY, 3, 0x1111);
    step(); // flag set -> pending start
    step(); // battle-start emitted
    expect(run.encounters.at(-1)).toMatchObject({ area: 'Route 1', species: PIDGEY, outcome: 'pending' });
    game.addParty(PIDGEY, 3, 0x1111, 'PIDGEY');
    step();
    game.endBattle();
    step();
    expect(run.encounters.at(-1)?.outcome).toBe('caught');
    expect(usedAreas(run).get('Route 1')?.species).toBe(PIDGEY);

    // Another Route 1 battle does not create an encounter.
    const before = run.encounters.length;
    game.startWild(RATTATA, 3, 0x2222);
    step();
    step();
    game.endBattle();
    step();
    expect(run.encounters.length).toBe(before);

    // Route 22: Pidgey family is a dupe, then Rattata counts and runs away.
    game.mem[S.wCurMap] = ROUTE_22;
    game.startWild(PIDGEOTTO, 9, 0x3333);
    step();
    step();
    expect(run.encounters.at(-1)?.outcome).toBe('dupe');
    game.endBattle();
    step();
    game.startWild(RATTATA, 4, 0x4444);
    step();
    step();
    game.endBattle();
    step();
    expect(run.encounters.at(-1)).toMatchObject({ species: RATTATA, outcome: 'failed', area: 'Route 22' });

    // Route 2: Bulbasaur faints to a wild Weedle.
    game.mem[S.wCurMap] = ROUTE_2;
    game.startWild(WEEDLE, 4, 0x5555);
    step();
    step();
    game.setHp(0, 0);
    step();
    const bulba = run.mons[Object.keys(run.mons)[0]];
    expect(bulba.status).toBe('dead');
    expect(bulba.death?.cause).toContain('Weedle');
    expect(notices.some((n) => n.title.includes('has fallen'))).toBe(true);

    // Healing a dead mon (e.g. at a Pokémon Center) is fine; sending it out is flagged.
    game.endBattle();
    step();
    game.setHp(0, 20);
    step();
    expect(bulba.violation).toBeUndefined();
    game.startWild(RATTATA, 4, 0x6666);
    step();
    step();
    game.sendOut(0);
    step();
    expect(bulba.violation).toBe('Used in battle after fainting');
    expect(notices.at(-1)?.title).toBe('Rule check: dead Pokémon used');
  });

  it('ignores wild battles until the player has had Poké Balls', () => {
    const { game, run, notices, step } = harness();
    step();
    game.addParty(BULBASAUR, 5, 0xabcd, 'BULBASAUR');
    step();
    game.mem[S.wCurMap] = ROUTE_1;
    game.startWild(PIDGEY, 3, 0x1111);
    step();
    step();
    game.endBattle();
    step();
    expect(run.encounters.filter((e) => e.kind === 'wild')).toHaveLength(0);
    expect(notices.at(-1)?.title).toBe('No Poké Balls yet');
    expect(usedAreas(run).has('Route 1')).toBe(false);

    // Balls in the bag: the next battle counts, and it keeps counting after they run out.
    game.giveBalls();
    step();
    expect(run.hadBalls).toBe(true);
    game.mem[S.wNumBagItems] = 0;
    game.w(S.wBagItems, [0xff]);
    game.startWild(RATTATA, 3, 0x2222);
    step();
    step();
    expect(run.encounters.at(-1)).toMatchObject({ area: 'Route 1', species: RATTATA, outcome: 'pending' });
  });

  it('defers wild battle start until enemy data is loaded', () => {
    const { game, run, step } = harness();
    step();
    game.addParty(BULBASAUR, 5, 0xabcd, 'BULBASAUR');
    step();
    game.giveBalls();
    game.mem[S.wCurMap] = ROUTE_1;
    step();
    // Stale enemy from a previous battle, flag set before data loads.
    game.mem[S.wIsInBattle] = 1;
    game.mem[S.wEnemyMonSpecies] = WEEDLE;
    step();
    game.startWild(PIDGEY, 3, 0x1111);
    step();
    expect(run.encounters.at(-1)?.species).toBe(PIDGEY);
  });

  it('withdraws an encounter that turns out to be an unidentified ghost', () => {
    const { game, run, step } = harness();
    step();
    game.addParty(BULBASAUR, 5, 0xabcd, 'BULBASAUR');
    step();
    game.giveBalls();
    game.mem[S.wCurMap] = 145; // Pokemon Tower 4F
    game.startWild(PIDGEY, 20, 0x7777);
    step();
    step();
    expect(run.encounters.at(-1)?.outcome).toBe('pending');
    // After the transition the game renames the foe GHOST.
    game.w(S.wEnemyMonNick, [0x86, 0x87, 0x8e, 0x92, 0x93, 0x50]);
    step();
    expect(run.encounters.length).toBe(1); // only the starter remains
    game.endBattle();
    step();
    expect(run.encounters.some((e) => e.area === 'Pokémon Tower')).toBe(false);
  });

  it('flags an extra catch in a used area', () => {
    const { game, run, step } = harness();
    step();
    game.addParty(BULBASAUR, 5, 0xabcd, 'BULBASAUR');
    step();
    game.mem[S.wCurMap] = ROUTE_1;
    game.startWild(PIDGEY, 3, 0x1111);
    step();
    step();
    game.endBattle();
    step(); // Pidgey fled -> Route 1 used
    game.startWild(RATTATA, 3, 0x2222);
    step();
    step();
    game.addParty(RATTATA, 3, 0x2222, 'RATTATA');
    step();
    const rat = Object.values(run.mons).find((m) => m.species === RATTATA);
    expect(rat?.violation).toContain('Extra catch');
  });
});

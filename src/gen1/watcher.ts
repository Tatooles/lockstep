// Turns Gen 1 RAM into structured snapshots (see run/events.ts for the differ).

import type { Gen1Symbols } from './symbols.ts';
import { decodeText } from './text.ts';
import { MAPS } from './maps.ts';
import type { BattleMonData, EnemyData, MonData, Ram, Snapshot } from '../run/events.ts';

export * from '../run/events.ts';

export const BATTLE_TYPE_OLD_MAN = 1;
export const BATTLE_TYPE_SAFARI = 2;

function bcd(v: number): number {
  return (v >> 4) * 10 + (v & 0xf);
}

export function monKey(otId: number, dvs: number, otName: string): string {
  return `${otId.toString(16).padStart(4, '0')}-${dvs.toString(16).padStart(4, '0')}-${otName}`;
}

export class Gen1Reader {
  private sym: Gen1Symbols;

  constructor(sym: Gen1Symbols) {
    this.sym = sym;
  }

  private u16be(ram: Ram, a: number): number {
    return (ram.u8(a) << 8) | ram.u8(a + 1);
  }

  private text(ram: Ram, a: number, max = 11): string {
    const bytes: number[] = [];
    for (let i = 0; i < max; i++) bytes.push(ram.u8(a + i));
    return decodeText(bytes, 0, max);
  }

  private readMon(ram: Ram, base: number, otAddr: number, nickAddr: number, full: boolean): MonData {
    const species = ram.u8(base);
    const otId = this.u16be(ram, base + 12);
    const dvs = this.u16be(ram, base + 27);
    const otName = this.text(ram, otAddr);
    const level = full ? ram.u8(base + 33) : ram.u8(base + 3);
    return {
      species,
      nickname: this.text(ram, nickAddr),
      level,
      hp: this.u16be(ram, base + 1),
      maxHp: full ? this.u16be(ram, base + 34) : 0,
      status: ram.u8(base + 4),
      types: [ram.u8(base + 5), ram.u8(base + 6)],
      moves: [ram.u8(base + 8), ram.u8(base + 9), ram.u8(base + 10), ram.u8(base + 11)],
      pp: [ram.u8(base + 29), ram.u8(base + 30), ram.u8(base + 31), ram.u8(base + 32)].map((p) => p & 0x3f),
      otId,
      otName,
      exp: (ram.u8(base + 14) << 16) | (ram.u8(base + 15) << 8) | ram.u8(base + 16),
      dvs,
      stats: full
        ? {
            atk: this.u16be(ram, base + 36),
            def: this.u16be(ram, base + 38),
            spd: this.u16be(ram, base + 40),
            spc: this.u16be(ram, base + 42),
          }
        : null,
      key: monKey(otId, dvs, otName),
    };
  }

  /** Attack/Defense/Speed/Special from a battle_struct (offsets 17..24). */
  private battleStats(ram: Ram, base: number) {
    return {
      atk: this.u16be(ram, base + 17),
      def: this.u16be(ram, base + 19),
      spd: this.u16be(ram, base + 21),
      spc: this.u16be(ram, base + 23),
    };
  }

  read(ram: Ram): Snapshot {
    const s = this.sym;
    const partyCount = ram.u8(s.wPartyCount);
    const boxCount = ram.u8(s.wBoxCount);
    const playerName = this.text(ram, s.wPlayerName, 8);
    const mapId = ram.u8(s.wCurMap);
    // Validity: counts in range, species lists terminated, player named.
    let valid =
      partyCount <= 6 &&
      boxCount <= 20 &&
      ram.u8(s.wPartySpecies + partyCount) === 0xff &&
      playerName.length > 0 &&
      mapId < MAPS.length;
    const party: MonData[] = [];
    if (valid) {
      for (let i = 0; i < partyCount; i++) {
        const m = this.readMon(ram, s.wPartyMons + i * 44, s.wPartyMonOT + i * 11, s.wPartyMonNicks + i * 11, true);
        if (m.species === 0 || m.level === 0 || m.level > 100) valid = false;
        party.push(m);
      }
    }
    const box: MonData[] = [];
    if (valid && ram.u8(s.wBoxSpecies + boxCount) === 0xff) {
      for (let i = 0; i < boxCount; i++) {
        box.push(this.readMon(ram, s.wBoxMons + i * 33, s.wBoxMonOT + i * 11, s.wBoxMonNicks + i * 11, false));
      }
    }
    const inBattle = ram.u8(s.wIsInBattle);
    let enemy: EnemyData | null = null;
    if (inBattle === 1 || inBattle === 2) {
      enemy = {
        species: ram.u8(s.wEnemyMonSpecies),
        level: ram.u8(s.wEnemyMonLevel),
        hp: this.u16be(ram, s.wEnemyMonHP),
        maxHp: this.u16be(ram, s.wEnemyMonMaxHP),
        dvs: this.u16be(ram, s.wEnemyMonDVs),
        trainerClass: inBattle === 2 ? ram.u8(s.wTrainerClass) : 0,
        trainerNo: inBattle === 2 ? ram.u8(s.wTrainerNo) : 0,
        ghost: inBattle === 1 && this.text(ram, s.wEnemyMonNick) === 'GHOST',
        types: [ram.u8(s.wEnemyMonSpecies + 5), ram.u8(s.wEnemyMonSpecies + 6)],
        moves: [8, 9, 10, 11].map((o) => ram.u8(s.wEnemyMonSpecies + o)),
        stats: this.battleStats(ram, s.wEnemyMonSpecies),
      };
    }
    let battleMon: BattleMonData | null = null;
    if (inBattle === 1 || inBattle === 2) {
      const b = s.wBattleMon;
      battleMon = {
        species: ram.u8(b),
        level: ram.u8(b + 14),
        hp: this.u16be(ram, b + 1),
        maxHp: this.u16be(ram, b + 15),
        types: [ram.u8(b + 5), ram.u8(b + 6)],
        moves: [8, 9, 10, 11].map((o) => ram.u8(b + o)),
        stats: this.battleStats(ram, b),
      };
    }
    const bag: Record<number, number> = {};
    const nBag = ram.u8(s.wNumBagItems);
    if (nBag <= 20) {
      for (let i = 0; i < nBag; i++) {
        const id = ram.u8(s.wBagItems + i * 2);
        if (id === 0xff) break;
        bag[id] = (bag[id] ?? 0) + ram.u8(s.wBagItems + i * 2 + 1);
      }
    }
    const money = bcd(ram.u8(s.wPlayerMoney)) * 10000 + bcd(ram.u8(s.wPlayerMoney + 1)) * 100 + bcd(ram.u8(s.wPlayerMoney + 2));
    return {
      valid,
      mapId,
      inBattle: inBattle === 0xff ? 0 : inBattle,
      battleType: ram.u8(s.wBattleType),
      badges: ram.u8(s.wObtainedBadges),
      playerName,
      playerId: this.u16be(ram, s.wPlayerID),
      money,
      party,
      box,
      boxNum: (ram.u8(s.wCurrentBoxNum) & 0x7f) + 1,
      enemy,
      activeSlot: ram.u8(s.wPlayerMonNumber),
      activeHp: inBattle === 1 || inBattle === 2 ? this.u16be(ram, s.wBattleMonHP) : null,
      battleMon,
      playSeconds: ram.u8(s.wPlayTimeHours) * 3600 + ram.u8(s.wPlayTimeMinutes) * 60 + ram.u8(s.wPlayTimeSeconds),
      bag,
      x: ram.u8(s.wXCoord),
      y: ram.u8(s.wYCoord),
    };
  }
}


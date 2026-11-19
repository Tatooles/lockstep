// Turns Gen 1 RAM into structured snapshots, and snapshot diffs into events.

import type { Gen1Symbols } from './symbols.ts';
import { decodeText } from './text.ts';
import { MAPS } from './maps.ts';

export interface Ram {
  u8(addr: number): number;
}

export interface MonData {
  species: number;
  nickname: string;
  level: number;
  hp: number;
  maxHp: number;
  status: number;
  types: [number, number];
  moves: number[];
  pp: number[];
  otId: number;
  otName: string;
  exp: number;
  dvs: number;
  stats: { atk: number; def: number; spd: number; spc: number } | null;
  /** Stable identity across party/box moves and evolutions. */
  key: string;
}

export interface EnemyData {
  species: number;
  level: number;
  hp: number;
  maxHp: number;
  dvs: number;
  trainerClass: number; // 0 for wild
  trainerNo: number;
  /** Unidentified Pokemon Tower ghost (no Silph Scope). */
  ghost: boolean;
  types: [number, number];
  moves: number[];
  stats: { atk: number; def: number; spd: number; spc: number };
}

/** The player's Pokemon currently in battle (wBattleMon), with in-battle stats. */
export interface BattleMonData {
  species: number;
  level: number;
  hp: number;
  maxHp: number;
  types: [number, number];
  moves: number[];
  stats: { atk: number; def: number; spd: number; spc: number };
}

export interface Snapshot {
  valid: boolean;
  mapId: number;
  inBattle: number; // 0 none, 1 wild, 2 trainer
  battleType: number;
  badges: number;
  playerName: string;
  playerId: number;
  money: number;
  party: MonData[];
  box: MonData[];
  boxNum: number;
  enemy: EnemyData | null;
  activeSlot: number;
  /** HP of the Pokemon currently out in battle (party HP lags until it switches or faints). */
  activeHp: number | null;
  battleMon: BattleMonData | null;
  playSeconds: number;
  /** Bag contents: item id -> quantity. */
  bag: Record<number, number>;
  x: number;
  y: number;
}

export const BATTLE_TYPE_OLD_MAN = 1;
export const BATTLE_TYPE_SAFARI = 2;
/** Scripted battles that never count as encounters (old man tutorial; Yellow's intro battles). */
export const SCRIPTED_BATTLE_TYPES = new Set([1, 3, 4]);

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

// ---- Events ----

export type GameEvent =
  | { type: 'loaded'; snap: Snapshot }
  | { type: 'battle-start'; kind: 'wild' | 'trainer'; enemy: EnemyData; mapId: number; battleType: number }
  | { type: 'battle-end'; kind: 'wild' | 'trainer'; enemy: EnemyData | null; mapId: number }
  | { type: 'enemy-switch'; enemy: EnemyData }
  /** The wild Pokemon turned out to be an unidentified ghost (set after the battle transition). */
  | { type: 'ghost-revealed'; enemy: EnemyData }
  | { type: 'acquired'; mon: MonData; mapId: number; duringBattle: boolean; lastEnemy: EnemyData | null; foreign: boolean }
  | { type: 'fainted'; mon: MonData; mapId: number; enemy: EnemyData | null; inBattle: boolean }
  | { type: 'revived'; mon: MonData }
  /** A party Pokemon was sent out in battle (fires once per send-out). */
  | { type: 'sent-out'; mon: MonData }
  | { type: 'badge'; index: number }
  | { type: 'map'; from: number; to: number }
  | { type: 'whiteout'; mapId: number }
  | { type: 'items-used'; kind: 'wild' | 'trainer'; items: { id: number; count: number }[] };

/** Poké Balls may always be thrown; anything else used in battle counts as an item. */
const BALLS = new Set([0x01, 0x02, 0x03, 0x04, 0x08]);

/**
 * Stateful differ. Call `update(snapshot)` regularly; it returns events
 * describing what changed since the last valid snapshot.
 */
export class EventDiffer {
  private prev: Snapshot | null = null;
  private knownKeys = new Set<string>();
  private lastEnemy: EnemyData | null = null;
  private battleEndedAt = -1;
  /** Samples seen since the battle flag went up, or -1 when no start is pending. */
  private pendingStart = -1;
  /** Wild battle starts are announced after the intro transition (samples). */
  private readonly wildStartDelay: number;

  constructor(opts: { wildStartDelay?: number } = {}) {
    this.wildStartDelay = opts.wildStartDelay ?? 12;
  }
  private bagAtStart: Record<number, number> | null = null;
  /** Key of the party Pokemon last seen out in the current battle. */
  private activeKey: string | null = null;
  private tick = 0;

  /** Keys considered pre-existing (e.g. from a run's registry). */
  seedKnown(keys: Iterable<string>): void {
    for (const k of keys) this.knownKeys.add(k);
  }

  reset(): void {
    this.prev = null;
    this.lastEnemy = null;
  }

  update(snap: Snapshot): GameEvent[] {
    this.tick++;
    if (!snap.valid) return [];
    const ev: GameEvent[] = [];
    const prev = this.prev;
    this.prev = snap;
    if (!prev) {
      // First valid snapshot: everything currently owned is the baseline.
      for (const m of snap.party) this.knownKeys.add(m.key);
      for (const m of snap.box) this.knownKeys.add(m.key);
      if (snap.enemy) this.lastEnemy = snap.enemy;
      ev.push({ type: 'loaded', snap });
      return ev;
    }

    // A wholesale change in identity (different save loaded) -> treat as reload.
    if (snap.playerId !== prev.playerId || snap.playerName !== prev.playerName) {
      for (const m of snap.party) this.knownKeys.add(m.key);
      for (const m of snap.box) this.knownKeys.add(m.key);
      ev.push({ type: 'loaded', snap });
      return ev;
    }

    if (snap.mapId !== prev.mapId) ev.push({ type: 'map', from: prev.mapId, to: snap.mapId });

    // Battle transitions. The battle flag is set before enemy data loads, and
    // wild starts are held until the intro transition has played.
    if (snap.inBattle && (!prev.inBattle || this.pendingStart >= 0)) {
      if (!prev.inBattle) {
        this.pendingStart = 0;
      } else if (++this.pendingStart >= (snap.inBattle === 1 ? this.wildStartDelay : 1) && snap.enemy && snap.enemy.species) {
        this.pendingStart = -1;
        this.bagAtStart = snap.bag;
        ev.push({
          type: 'battle-start',
          kind: snap.inBattle === 1 ? 'wild' : 'trainer',
          enemy: snap.enemy,
          mapId: snap.mapId,
          battleType: snap.battleType,
        });
      }
    } else if (prev.inBattle && snap.inBattle && snap.enemy && prev.enemy) {
      if (snap.enemy.species !== prev.enemy.species || snap.enemy.dvs !== prev.enemy.dvs) {
        ev.push({ type: 'enemy-switch', enemy: snap.enemy });
      } else if (snap.inBattle === 1 && snap.enemy.ghost && !prev.enemy.ghost) {
        ev.push({ type: 'ghost-revealed', enemy: snap.enemy });
      }
    } else if (prev.inBattle && !snap.inBattle) {
      this.pendingStart = -1;
      const kind = prev.inBattle === 1 ? 'wild' : 'trainer';
      if (this.bagAtStart) {
        const items: { id: number; count: number }[] = [];
        for (const [k, q] of Object.entries(this.bagAtStart)) {
          const id = Number(k);
          const now = snap.bag[id] ?? 0;
          if (!BALLS.has(id) && now < q) items.push({ id, count: q - now });
        }
        if (items.length) ev.push({ type: 'items-used', kind, items });
        this.bagAtStart = null;
      }
      ev.push({ type: 'battle-end', kind, enemy: prev.enemy, mapId: prev.mapId });
      this.battleEndedAt = this.tick;
      this.activeKey = null;
    }
    if (snap.inBattle && snap.enemy && snap.enemy.species) this.lastEnemy = snap.enemy;

    // Send-outs: the active slot's Pokemon is actually on the field (wBattleMon
    // agrees with it and is standing), so stale data from a previous battle is ignored.
    if (snap.inBattle && this.pendingStart < 0 && snap.battleMon && snap.battleMon.hp > 0) {
      const mon = snap.party[snap.activeSlot];
      if (mon && mon.species === snap.battleMon.species && mon.level === snap.battleMon.level && mon.key !== this.activeKey) {
        this.activeKey = mon.key;
        ev.push({ type: 'sent-out', mon });
      }
    }

    // Acquisitions: any never-seen key in party or box.
    for (const m of [...snap.party, ...snap.box]) {
      if (this.knownKeys.has(m.key)) continue;
      this.knownKeys.add(m.key);
      const recentBattle = snap.inBattle === 1 || (this.battleEndedAt >= 0 && this.tick - this.battleEndedAt < 120);
      const fromBattle =
        recentBattle && this.lastEnemy !== null && this.lastEnemy.dvs === m.dvs && this.lastEnemy.species === m.species;
      ev.push({
        type: 'acquired',
        mon: m,
        mapId: snap.mapId,
        duringBattle: fromBattle,
        lastEnemy: fromBattle ? this.lastEnemy : null,
        foreign: m.otId !== snap.playerId,
      });
    }

    // Faints / revives (party HP transitions, matched by key).
    const prevByKey = new Map(prev.party.map((m) => [m.key, m]));
    for (const m of snap.party) {
      const p = prevByKey.get(m.key);
      if (!p) continue;
      if (p.hp > 0 && m.hp === 0) {
        ev.push({ type: 'fainted', mon: m, mapId: snap.mapId, enemy: snap.inBattle ? snap.enemy : null, inBattle: snap.inBattle !== 0 });
      } else if (p.hp === 0 && m.hp > 0) {
        ev.push({ type: 'revived', mon: m });
      }
    }
    if (snap.party.length > 0 && snap.party.every((m) => m.hp === 0) && prev.party.some((m) => m.hp > 0)) {
      ev.push({ type: 'whiteout', mapId: snap.mapId });
    }

    // Badges
    const gained = snap.badges & ~prev.badges;
    for (let i = 0; i < 8; i++) if (gained & (1 << i)) ev.push({ type: 'badge', index: i });

    return ev;
  }
}

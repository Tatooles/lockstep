// Game-independent snapshots of the player's state, and the differ that turns
// successive snapshots into events for the run engine. Gen 1 and Gen 3 readers
// both produce these.

/** Attack, Defense, Speed and Special (Gen 1) or Special Attack (Gen 3), plus Gen 3's Special Defense. */
export interface Stats {
  atk: number;
  def: number;
  spd: number;
  spc: number;
  spdef?: number;
}

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
  /** Gen 1 DVs; Gen 3 personality value. Matches a caught Pokémon to the wild one. */
  dvs: number;
  stats: Stats | null;
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
  stats: Stats;
}

/** The player's Pokemon currently in battle (wBattleMon), with in-battle stats. */
export interface BattleMonData {
  species: number;
  level: number;
  hp: number;
  maxHp: number;
  types: [number, number];
  moves: number[];
  stats: Stats;
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

const GEN1_BALLS = new Set([0x01, 0x02, 0x03, 0x04, 0x08]);


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

  /** Poké Balls may always be thrown; anything else used in battle counts as an item. */
  private readonly isBall: (item: number) => boolean;

  constructor(opts: { wildStartDelay?: number; isBall?: (item: number) => boolean } = {}) {
    this.wildStartDelay = opts.wildStartDelay ?? 12;
    this.isBall = opts.isBall ?? ((id) => GEN1_BALLS.has(id));
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
    // Battle-end events go last: a catch is often first visible in the same sample
    // the battle ends (the party is unreadable while the new Pokemon is named).
    const endEvents: GameEvent[] = [];
    const battleJustEnded = prev.inBattle !== 0 && snap.inBattle === 0;

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
          if (!this.isBall(id) && now < q) items.push({ id, count: q - now });
        }
        if (items.length) endEvents.push({ type: 'items-used', kind, items });
        this.bagAtStart = null;
      }
      endEvents.push({ type: 'battle-end', kind, enemy: prev.enemy, mapId: prev.mapId });
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
        const enemy = snap.inBattle ? snap.enemy : battleJustEnded ? prev.enemy : null;
        ev.push({ type: 'fainted', mon: m, mapId: snap.mapId, enemy, inBattle: snap.inBattle !== 0 || battleJustEnded });
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

    ev.push(...endEvents);
    return ev;
  }
}

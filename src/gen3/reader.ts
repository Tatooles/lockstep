// Turns Gen 3 RAM into the same snapshots the Gen 1 tracker uses: the party
// and PC (decrypting each Pokémon's data), battle state, map, badges and bag.

import type { BattleMonData, EnemyData, MonData, Snapshot } from '../run/events.ts';
import { BATTLE_TYPE, type Gen3Data } from './rom.ts';
import { decodeText } from './text.ts';

/** Little-endian reads over the GBA's work RAM. */
export interface Mem {
  u8(a: number): number;
  u16(a: number): number;
  u32(a: number): number;
  /** `len` bytes at `a`, without copying where possible. */
  bytes(a: number, len: number): Uint8Array;
}

/** A Mem over the core's EWRAM (0x02…) and IWRAM (0x03…) arrays. */
export function workRam(ewram: Uint8Array, iwram: Uint8Array): Mem {
  const at = (a: number): [Uint8Array, number] => (a >>> 24 === 3 ? [iwram, a & 0x7fff] : [ewram, a & 0x3ffff]);
  return {
    u8(a) {
      const [m, o] = at(a);
      return m[o];
    },
    u16(a) {
      const [m, o] = at(a);
      return m[o] | (m[o + 1] << 8);
    },
    u32(a) {
      const [m, o] = at(a);
      return (m[o] | (m[o + 1] << 8) | (m[o + 2] << 16) | (m[o + 3] << 24)) >>> 0;
    },
    bytes(a, len) {
      const [m, o] = at(a);
      return m.subarray(o, o + len);
    },
  };
}

// Substructure order (Growth, Attacks, EVs, Misc) for personality % 24.
const ORDERS = [
  'GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG',
  'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG',
].map((o) => ({ G: o.indexOf('G') * 12, A: o.indexOf('A') * 12, M: o.indexOf('M') * 12 }));

// Per-family save block offsets (include/global.h).
const LAYOUT = {
  rs: { mainFlags: 0x43d, money: 0x490, items: [0x560, 20], balls: [0x600, 16], berries: [0x740, 46], flags: 0x1220, badge1: 0x807, key: -1 },
  e: { mainFlags: 0x439, money: 0x490, items: [0x560, 30], balls: [0x650, 16], berries: [0x790, 46], flags: 0x1270, badge1: 0x867, key: 0xac },
  frlg: { mainFlags: 0x439, money: 0x290, items: [0x310, 42], balls: [0x430, 13], berries: [0x54c, 43], flags: 0xee0, badge1: 0x820, key: 0xf20 },
} as const;

const BOXES = 14;
const BOX_SIZE = 30;

export function monKey(personality: number, otId: number): string {
  return `${personality.toString(16).padStart(8, '0')}-${otId.toString(16).padStart(8, '0')}`;
}

export class Gen3Reader {
  private readonly data: Gen3Data;
  private readonly layout: (typeof LAYOUT)[keyof typeof LAYOUT];
  private readonly buf = new Uint8Array(100);
  private readonly sub = new Uint8Array(48);
  /** Decoded PC Pokémon by slot, reused while the slot's bytes are unchanged. */
  private boxCache: { raw: Uint8Array; mon: MonData | null }[] = [];

  constructor(data: Gen3Data) {
    this.data = data;
    this.layout = LAYOUT[data.gameFamily];
  }

  private saveBlocks(mem: Mem): { sb1: number; sb2: number; storage: number } | null {
    const r = this.data.ram;
    const sb1 = r.saveBlock1Ptr ? mem.u32(r.saveBlock1Ptr) : r.saveBlock1!;
    const sb2 = r.saveBlock2Ptr ? mem.u32(r.saveBlock2Ptr) : r.saveBlock2!;
    const storage = r.storagePtr ? mem.u32(r.storagePtr) : r.storage!;
    const ok = (a: number) => a >>> 24 === 2 && (a & 0xffffff) < 0x40000;
    return ok(sb1) && ok(sb2) && ok(storage) ? { sb1, sb2, storage } : null;
  }

  /**
   * Decode one Pokémon (100 bytes in the party, 80 in the PC). Returns null for
   * empty slots and eggs, or 'bad' when the checksum fails (caught mid-write).
   */
  private decode(mem: Mem, base: number, party: boolean): MonData | null | 'bad' {
    this.buf.set(mem.bytes(base, party ? 100 : 80));
    return this.decodeBytes(this.buf, party);
  }

  private decodeBytes(b: Uint8Array, party: boolean): MonData | null | 'bad' {
    const u16 = (o: number) => b[o] | (b[o + 1] << 8);
    const u32 = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    const pid = u32(0);
    const otId = u32(4);
    const flags = b[19];
    if (!(flags & 2)) return null; // no species: empty slot
    if (flags & 5) return null; // egg or bad egg
    const key = (pid ^ otId) >>> 0;
    const s = this.sub;
    let sum = 0;
    for (let i = 0; i < 48; i += 4) {
      const v = (u32(32 + i) ^ key) >>> 0;
      s[i] = v & 0xff;
      s[i + 1] = (v >>> 8) & 0xff;
      s[i + 2] = (v >>> 16) & 0xff;
      s[i + 3] = v >>> 24;
      sum += (v & 0xffff) + (v >>> 16);
    }
    if ((sum & 0xffff) !== u16(28)) return 'bad';
    const o = ORDERS[pid % 24];
    const su16 = (x: number) => s[x] | (s[x + 1] << 8);
    const su32 = (x: number) => (s[x] | (s[x + 1] << 8) | (s[x + 2] << 16) | (s[x + 3] << 24)) >>> 0;
    const species = su16(o.G);
    const exp = su32(o.G + 4);
    const sp = this.data.species[species];
    if (!sp || species === 0) return 'bad';
    const level = party ? b[84] : this.data.levelFor(species, exp);
    return {
      species,
      nickname: decodeText(b, 8, 10),
      level,
      hp: party ? u16(86) : 0,
      maxHp: party ? u16(88) : 0,
      status: party ? u32(80) : 0,
      types: [...sp.types],
      moves: [0, 2, 4, 6].map((x) => su16(o.A + x)),
      pp: [8, 9, 10, 11].map((x) => s[o.A + x]),
      otId,
      otName: decodeText(b, 20, 7),
      exp,
      dvs: pid,
      stats: party ? { atk: u16(90), def: u16(92), spd: u16(94), spc: u16(96), spdef: u16(98) } : null,
      key: monKey(pid, otId),
    };
  }

  private readBox(mem: Mem, storage: number): MonData[] {
    const out: MonData[] = [];
    const n = BOXES * BOX_SIZE;
    for (let i = 0; i < n; i++) {
      const cur = mem.bytes(storage + 4 + i * 80, 80);
      let c = this.boxCache[i];
      // Only decode slots whose bytes changed.
      let same = !!c;
      if (c) {
        for (let j = 0; j < 80; j++) {
          if (c.raw[j] !== cur[j]) {
            same = false;
            break;
          }
        }
      }
      if (!same) {
        const raw = cur.slice();
        const m = this.decodeBytes(raw, false);
        c = { raw, mon: m === 'bad' ? null : m };
        this.boxCache[i] = c;
      }
      if (c!.mon) out.push(c!.mon);
    }
    return out;
  }

  private battleMon(mem: Mem, base: number) {
    return {
      species: mem.u16(base),
      level: mem.u8(base + 0x2a),
      hp: mem.u16(base + 0x28),
      maxHp: mem.u16(base + 0x2c),
      types: [mem.u8(base + 0x21), mem.u8(base + 0x22)] as [number, number],
      moves: [0, 2, 4, 6].map((x) => mem.u16(base + 0x0c + x)),
      stats: { atk: mem.u16(base + 2), def: mem.u16(base + 4), spd: mem.u16(base + 6), spc: mem.u16(base + 8), spdef: mem.u16(base + 10) },
    };
  }

  private bag(mem: Mem, sb1: number, sb2: number): Record<number, number> {
    const L = this.layout;
    const key = L.key >= 0 ? mem.u32(sb2 + L.key) & 0xffff : 0;
    const bag: Record<number, number> = {};
    for (const [off, count] of [L.items, L.balls, L.berries]) {
      for (let i = 0; i < count; i++) {
        const id = mem.u16(sb1 + off + i * 4);
        if (!id) continue;
        bag[id] = (bag[id] ?? 0) + ((mem.u16(sb1 + off + i * 4 + 2) ^ key) & 0xffff);
      }
    }
    return bag;
  }

  read(mem: Mem): Snapshot {
    const r = this.data.ram;
    const L = this.layout;
    const blocks = this.saveBlocks(mem);
    const empty: Snapshot = {
      valid: false, mapId: 0, inBattle: 0, battleType: 0, badges: 0, playerName: '', playerId: 0, money: 0,
      party: [], box: [], boxNum: 1, enemy: null, activeSlot: 0, activeHp: null, battleMon: null, playSeconds: 0, bag: {}, x: 0, y: 0,
    };
    if (!blocks) return empty;
    const { sb1, sb2, storage } = blocks;
    const playerName = decodeText(mem.bytes(sb2, 8), 0, 8);
    const count = mem.u8(r.playerPartyCount!);
    if (!playerName || count > 6) return empty;

    const party: MonData[] = [];
    for (let i = 0; i < count; i++) {
      const m = this.decode(mem, r.playerParty! + i * 100, true);
      if (m === 'bad') return empty;
      if (m) party.push(m);
    }

    const flagsByte = mem.u8(r.main! + L.mainFlags);
    const battleType = mem.u32(r.battleTypeFlags!);
    const inBattleFlag = (flagsByte & 2) !== 0;
    const inBattle = inBattleFlag ? (battleType & BATTLE_TYPE.TRAINER ? 2 : 1) : 0;

    let enemy: EnemyData | null = null;
    let battleMon: BattleMonData | null = null;
    let activeSlot = 0;
    if (inBattle) {
      // The enemy party is generated before the battle starts (gBattleMons fills in later).
      const idx = mem.u8(r.battlerPartyIndexes! + 2);
      const e = this.decode(mem, r.enemyParty! + (idx < 6 ? idx : 0) * 100, true);
      if (e && e !== 'bad') {
        const opp = inBattle === 2 ? mem.u16(r.trainerOpponent!) : 0;
        const t = opp ? this.data.trainer(opp) : null;
        const ghost = this.data.gameFamily === 'frlg' && !!(battleType & BATTLE_TYPE.GHOST) && !(battleType & BATTLE_TYPE.GHOST_UNVEILED);
        enemy = {
          species: e.species,
          level: e.level,
          hp: e.hp,
          maxHp: e.maxHp,
          dvs: e.dvs,
          trainerClass: t?.cls ?? 0,
          trainerNo: opp,
          ghost,
          types: e.types,
          moves: e.moves,
          stats: e.stats!,
        };
      }
      activeSlot = mem.u8(r.battlerPartyIndexes!);
      battleMon = this.battleMon(mem, r.battleMons!);
    }

    const key = L.key >= 0 ? mem.u32(sb2 + L.key) : 0;
    let badges = 0;
    for (let i = 0; i < 8; i++) {
      const f = L.badge1 + i;
      if (mem.u8(sb1 + L.flags + (f >> 3)) & (1 << (f & 7))) badges |= 1 << i;
    }
    const s16 = (v: number) => (v << 16) >> 16;
    return {
      valid: true,
      mapId: (mem.u8(sb1 + 4) << 8) | mem.u8(sb1 + 5),
      inBattle,
      battleType,
      badges,
      playerName,
      playerId: mem.u32(sb2 + 0x0a),
      money: (mem.u32(sb1 + L.money) ^ key) >>> 0,
      party,
      box: this.readBox(mem, storage),
      boxNum: (mem.u8(storage) % BOXES) + 1,
      enemy,
      activeSlot,
      activeHp: battleMon ? battleMon.hp : null,
      battleMon,
      playSeconds: mem.u16(sb2 + 0x0e) * 3600 + mem.u8(sb2 + 0x10) * 60 + mem.u8(sb2 + 0x11),
      bag: this.bag(mem, sb1, sb2),
      x: s16(mem.u16(sb1)),
      y: s16(mem.u16(sb1 + 2)),
    };
  }

  /** Battle style option: true is Set (no switch offer after a knockout). */
  setBattleStyle(mem: Mem, write: (addr: number, v: number) => void): void {
    const blocks = this.saveBlocks(mem);
    if (!blocks) return;
    const a = blocks.sb2 + 0x15;
    const v = mem.u8(a);
    if (!(v & 2)) write(a, v | 2);
  }
}

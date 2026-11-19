// Reads game data (species, moves, types, wild encounters, trainers) straight
// out of the player's own ROM using disassembly symbol offsets.

import { parseHeader } from '../core/header.ts';
import { SYMBOLS, type Gen1Symbols } from './symbols.ts';
import { decodeText, decodeTextLen, prettyName } from './text.ts';

export type Gen1Version = 'red' | 'blue' | 'yellow';

export interface Evolution {
  method: 'level' | 'item' | 'trade';
  level: number;
  item?: number;
  to: number; // internal species index
}

export interface Species {
  index: number; // internal index (what RAM stores)
  dex: number;
  name: string;
  types: [number, number];
  base: { hp: number; atk: number; def: number; spd: number; spc: number };
  catchRate: number;
  baseExp: number;
  growth: number;
  evolutions: Evolution[];
  learnset: { level: number; move: number }[];
  picPtr: number; // banked pointer within the pic bank
  picBank: number;
  picDims: number;
  family: number; // smallest dex number in the evolution family
}

export interface Move {
  id: number;
  name: string;
  effect: number;
  power: number;
  type: number;
  accuracy: number; // percent
  pp: number;
}

export interface WildSlot {
  level: number;
  species: number;
  chance: number; // 0..1
}

export interface WildTable {
  grassRate: number;
  grass: WildSlot[];
  waterRate: number;
  water: WildSlot[];
  superRod: { level: number; species: number }[];
}

export interface TrainerParty {
  cls: number;
  no: number; // 1-based party number within class
  mons: { level: number; species: number }[];
}

/** Gen 1 encounter slot odds (WildMonEncounterSlotChances). */
export const SLOT_CHANCES = [51, 51, 39, 25, 25, 25, 13, 13, 11, 3].map((n) => n / 256);

// Internal species constants used for pic bank selection.
const MEW = 0x15;
const FOSSIL_KABUTOPS = 0xb6;
const FOSSIL_AERODACTYL = 0xb7;
const MON_GHOST = 0xb8;

export function detectVersion(rom: Uint8Array): Gen1Version | null {
  const title = parseHeader(rom).title;
  let v: Gen1Version | null = null;
  if (title.startsWith('POKEMON RED')) v = 'red';
  else if (title.startsWith('POKEMON BLUE')) v = 'blue';
  else if (title.startsWith('POKEMON YELLOW')) v = 'yellow';
  if (!v) return null;
  // Sanity check: species #1 (internal) must decode as RHYDON in an English ROM.
  const sym = SYMBOLS[v];
  if (decodeText(rom, sym.MonsterNames, 10) !== 'RHYDON') return null;
  return v;
}

export class Gen1Data {
  readonly version: Gen1Version;
  readonly sym: Gen1Symbols;
  readonly rom: Uint8Array;
  readonly species = new Map<number, Species>(); // by internal index
  readonly byDex = new Map<number, Species>();
  readonly moves: Move[] = [];
  readonly items: string[] = [];
  readonly trainerClasses: string[] = [];
  /** attacker type -> defender type -> multiplier (only non-1 entries). */
  readonly typeChart = new Map<number, Map<number, number>>();
  private wildCache = new Map<number, WildTable | null>();

  constructor(rom: Uint8Array, version: Gen1Version) {
    this.rom = rom;
    this.version = version;
    this.sym = SYMBOLS[version];
    this.readSpecies();
    this.readMoves();
    this.readItems();
    this.readTypeChart();
    this.readTrainerClasses();
    this.computeFamilies();
  }

  private u8(off: number): number {
    return this.rom[off];
  }

  private u16(off: number): number {
    return this.rom[off] | (this.rom[off + 1] << 8);
  }

  /** Resolve a banked pointer stored in the same bank as `tableOffset`. */
  private sameBank(tableOffset: number, ptr: number): number {
    const bank = Math.floor(tableOffset / 0x4000);
    return bank === 0 ? ptr : bank * 0x4000 + (ptr - 0x4000);
  }

  private readSpecies(): void {
    const s = this.sym;
    for (let idx = 1; idx <= 190; idx++) {
      const dex = this.u8(s.PokedexOrder + idx - 1);
      if (dex === 0 || dex > 151) continue; // MissingNo slots
      const name = prettyName(decodeText(this.rom, s.MonsterNames + (idx - 1) * 10, 10));
      let bs: number;
      if (dex === 151 && s.MewBaseStats >= 0) bs = s.MewBaseStats;
      else bs = s.BaseStats + (dex - 1) * 28;
      const sp: Species = {
        index: idx,
        dex,
        name,
        types: [this.u8(bs + 6), this.u8(bs + 7)],
        base: { hp: this.u8(bs + 1), atk: this.u8(bs + 2), def: this.u8(bs + 3), spd: this.u8(bs + 4), spc: this.u8(bs + 5) },
        catchRate: this.u8(bs + 8),
        baseExp: this.u8(bs + 9),
        picDims: this.u8(bs + 10),
        picPtr: this.u16(bs + 11),
        picBank: this.picBank(idx),
        growth: this.u8(bs + 19),
        evolutions: [],
        learnset: [],
        family: dex,
      };
      this.readEvosMoves(sp);
      this.species.set(idx, sp);
      this.byDex.set(dex, sp);
    }
  }

  private picBank(idx: number): number {
    const s = this.sym;
    const b = s.picBanks;
    if (idx === MEW && s.MewBaseStats >= 0) return Math.floor(s.MewPicFront / 0x4000);
    if (idx === FOSSIL_KABUTOPS) return Math.floor(s.FossilKabutopsPic / 0x4000);
    if (idx < 0x1f) return b[0];
    if (idx < 0x4a) return b[1];
    if (idx < 0x74) return b[2];
    if (idx < 0x99) return b[3];
    return b[4];
  }

  /** Pointer to a pic for special battle sprites (fossils, ghost). */
  specialPic(kind: 'ghost' | 'fossilKabutops' | 'fossilAerodactyl'): number {
    const s = this.sym;
    return kind === 'ghost' ? s.GhostPic : kind === 'fossilKabutops' ? s.FossilKabutopsPic : s.FossilAerodactylPic;
  }

  private readEvosMoves(sp: Species): void {
    const table = this.sym.EvosMovesPointerTable;
    let p = this.sameBank(table, this.u16(table + (sp.index - 1) * 2));
    for (let guard = 0; guard < 16; guard++) {
      const method = this.u8(p++);
      if (method === 0) break;
      if (method === 1) {
        sp.evolutions.push({ method: 'level', level: this.u8(p), to: this.u8(p + 1) });
        p += 2;
      } else if (method === 2) {
        sp.evolutions.push({ method: 'item', item: this.u8(p), level: this.u8(p + 1), to: this.u8(p + 2) });
        p += 3;
      } else if (method === 3) {
        sp.evolutions.push({ method: 'trade', level: this.u8(p), to: this.u8(p + 1) });
        p += 2;
      } else break;
    }
    for (let guard = 0; guard < 40; guard++) {
      const level = this.u8(p++);
      if (level === 0) break;
      sp.learnset.push({ level, move: this.u8(p++) });
    }
  }

  private computeFamilies(): void {
    // Union-find over evolutions so dupes clause can compare families.
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      while (parent.get(x) !== undefined && parent.get(x) !== x) x = parent.get(x)!;
      return x;
    };
    for (const sp of this.species.values()) parent.set(sp.dex, sp.dex);
    for (const sp of this.species.values()) {
      for (const e of sp.evolutions) {
        const to = this.species.get(e.to);
        if (!to) continue;
        const a = find(sp.dex);
        const b = find(to.dex);
        if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
      }
    }
    for (const sp of this.species.values()) sp.family = find(sp.dex);
  }

  private readMoves(): void {
    const s = this.sym;
    let namePtr = s.MoveNames;
    this.moves.push({ id: 0, name: '—', effect: 0, power: 0, type: 0, accuracy: 0, pp: 0 });
    for (let id = 1; id <= 165; id++) {
      const [name, len] = decodeTextLen(this.rom, namePtr, 20);
      namePtr += len;
      const m = s.Moves + (id - 1) * 6;
      this.moves.push({
        id,
        name: prettyName(name),
        effect: this.u8(m + 1),
        power: this.u8(m + 2),
        type: this.u8(m + 3),
        accuracy: Math.round((this.u8(m + 4) * 100) / 255),
        pp: this.u8(m + 5),
      });
    }
  }

  private readItems(): void {
    let p = this.sym.ItemNames;
    this.items.push('');
    for (let id = 1; id <= 0x61; id++) {
      const [name, len] = decodeTextLen(this.rom, p, 20);
      p += len;
      this.items.push(prettyName(name));
    }
  }

  private readTypeChart(): void {
    let p = this.sym.TypeEffects;
    for (let guard = 0; guard < 200; guard++) {
      const atk = this.u8(p);
      if (atk === 0xff) break;
      const def = this.u8(p + 1);
      const mult = this.u8(p + 2) / 10;
      p += 3;
      if (!this.typeChart.has(atk)) this.typeChart.set(atk, new Map());
      this.typeChart.get(atk)!.set(def, mult);
    }
  }

  private readTrainerClasses(): void {
    let p = this.sym.TrainerNames;
    this.trainerClasses.push('');
    for (let i = 1; i <= 47; i++) {
      const [name, len] = decodeTextLen(this.rom, p, 20);
      p += len;
      this.trainerClasses.push(prettyName(name));
    }
  }

  /** Damage multiplier of an attack type against a (possibly dual-type) defender. */
  effectiveness(atk: number, def: [number, number]): number {
    const row = this.typeChart.get(atk);
    let m = row?.get(def[0]) ?? 1;
    if (def[1] !== def[0]) m *= row?.get(def[1]) ?? 1;
    return m;
  }

  speciesName(idx: number): string {
    return this.species.get(idx)?.name ?? (idx === MON_GHOST ? 'Ghost' : idx === FOSSIL_AERODACTYL ? 'Fossil' : `#${idx}`);
  }

  /** Wild encounter table for a map (null if the map has no encounters). */
  wild(mapId: number): WildTable | null {
    if (this.wildCache.has(mapId)) return this.wildCache.get(mapId)!;
    const s = this.sym;
    let t: WildTable | null = null;
    const ptr = this.u16(s.WildDataPointers + mapId * 2);
    if (ptr !== 0xffff && ptr >= 0x4000 && ptr < 0x8000) {
      let p = this.sameBank(s.WildDataPointers, ptr);
      const grassRate = this.u8(p++);
      const grass: WildSlot[] = [];
      if (grassRate) {
        for (let i = 0; i < 10; i++, p += 2) grass.push({ level: this.u8(p), species: this.u8(p + 1), chance: SLOT_CHANCES[i] });
      }
      const waterRate = this.u8(p++);
      const water: WildSlot[] = [];
      if (waterRate) {
        for (let i = 0; i < 10; i++, p += 2) water.push({ level: this.u8(p), species: this.u8(p + 1), chance: SLOT_CHANCES[i] });
      }
      t = { grassRate, grass, waterRate, water, superRod: this.superRod(mapId) };
      if (!grassRate && !waterRate && t.superRod.length === 0) t = null;
    } else {
      const sr = this.superRod(mapId);
      if (sr.length) t = { grassRate: 0, grass: [], waterRate: 0, water: [], superRod: sr };
    }
    this.wildCache.set(mapId, t);
    return t;
  }

  private superRod(mapId: number): { level: number; species: number }[] {
    const s = this.sym;
    if (s.SuperRodData < 0) return [];
    let p = s.SuperRodData;
    for (let guard = 0; guard < 64; guard++) {
      const m = this.u8(p);
      if (m === 0xff) return [];
      if (m === mapId) {
        let g = this.sameBank(s.SuperRodData, this.u16(p + 1));
        const n = this.u8(g++);
        const out: { level: number; species: number }[] = [];
        for (let i = 0; i < n && i < 8; i++, g += 2) out.push({ level: this.u8(g), species: this.u8(g + 1) });
        return out;
      }
      p += 3;
    }
    return [];
  }

  /** Good rod mons (the same everywhere). */
  goodRod(): { level: number; species: number }[] {
    const p = this.sym.GoodRodMons;
    if (p < 0) return [];
    return [
      { level: this.u8(p), species: this.u8(p + 1) },
      { level: this.u8(p + 2), species: this.u8(p + 3) },
    ];
  }

  /** All parties for a trainer class. */
  trainerParties(cls: number): TrainerParty[] {
    const s = this.sym;
    const start = this.sameBank(s.TrainerDataPointers, this.u16(s.TrainerDataPointers + (cls - 1) * 2));
    const nextPtr = cls < 47 ? this.sameBank(s.TrainerDataPointers, this.u16(s.TrainerDataPointers + cls * 2)) : start + 0x200;
    const end = nextPtr > start ? nextPtr : start + 0x200;
    const parties: TrainerParty[] = [];
    let p = start;
    while (p < end && parties.length < 64) {
      const first = this.u8(p++);
      const mons: { level: number; species: number }[] = [];
      if (first === 0xff) {
        for (let guard = 0; guard < 6; guard++) {
          const level = this.u8(p++);
          if (level === 0) break;
          mons.push({ level, species: this.u8(p++) });
        }
        if (mons.length === 6 && this.u8(p) === 0) p++;
      } else {
        for (let guard = 0; guard < 6; guard++) {
          const sp = this.u8(p++);
          if (sp === 0) break;
          mons.push({ level: first, species: sp });
        }
        if (mons.length === 6 && this.u8(p) === 0) p++;
      }
      parties.push({ cls, no: parties.length + 1, mons });
    }
    return parties;
  }
}

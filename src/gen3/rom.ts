// Reads Gen 3 game data (species, moves, trainers, map names, wild areas,
// sprites) straight out of the player's own ROM, at the decompilations'
// symbol addresses for that game and revision.

import type { BattleInfo, WildSection, WildSlot } from '../run/battle.ts';
import type { Dex, DexMove } from '../run/dex.ts';
import type { Snapshot } from '../run/events.ts';
import type { Milestone } from '../run/milestones.ts';
import type { Rules, Run } from '../run/types.ts';
import { lz77, palette, tiles4bpp } from './gfx.ts';
import { gen3Battle } from './battle.ts';
import type { TypeTable } from './damage.ts';
import { RAM_SYMBOLS, ROM_SYMBOLS, type Gen3Family, type Gen3RamSymbols, type Gen3RomSymbols } from './symbols.ts';
import { decodeText, prettyName } from './text.ts';

export type Gen3Version = 'ruby' | 'sapphire' | 'emerald' | 'firered' | 'leafgreen';

const GAMES: Record<string, { version: Gen3Version; family: Gen3Family }> = {
  AXVE: { version: 'ruby', family: 'rs' },
  AXPE: { version: 'sapphire', family: 'rs' },
  BPEE: { version: 'emerald', family: 'e' },
  BPRE: { version: 'firered', family: 'frlg' },
  BPGE: { version: 'leafgreen', family: 'frlg' },
};

export interface Gen3Game {
  version: Gen3Version;
  family: Gen3Family;
  /** Game code + revision, the key into ROM_SYMBOLS. */
  variant: string;
}

/** The English Gen 3 Pokémon game this ROM is, or null. */
export function detectGen3(rom: Uint8Array): Gen3Game | null {
  if (rom.length < 0x100000) return null;
  const code = String.fromCharCode(rom[0xac], rom[0xad], rom[0xae], rom[0xaf]);
  const g = GAMES[code];
  const variant = `${code}${rom[0xbc]}`;
  if (!g || !ROM_SYMBOLS[variant]) return null;
  return { ...g, variant };
}

export const TYPE_NAMES = [
  'Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', '???',
  'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark',
];
const TYPE_COLORS = [
  '#a8a77a', '#c22e28', '#a98ff3', '#a33ea1', '#e2bf65', '#b6a136', '#a6b91a', '#735797', '#b7b7ce', '#68a090',
  '#ee8130', '#6390f0', '#7ac74c', '#f7d02c', '#f95587', '#96d9d6', '#6f35fc', '#705746',
];

const BADGES: Record<Gen3Family, string[]> = {
  rs: ['Stone', 'Knuckle', 'Dynamo', 'Heat', 'Balance', 'Feather', 'Mind', 'Rain'],
  e: ['Stone', 'Knuckle', 'Dynamo', 'Heat', 'Balance', 'Feather', 'Mind', 'Rain'],
  frlg: ['Boulder', 'Cascade', 'Thunder', 'Rainbow', 'Soul', 'Marsh', 'Volcano', 'Earth'],
};

// gBattleTypeFlags bits (include/constants/battle.h).
export const BATTLE_TYPE = {
  LINK: 1 << 1,
  TRAINER: 1 << 3,
  FIRST_BATTLE: 1 << 4,
  SAFARI: 1 << 7,
  /** Wally's catching tutorial (R/S/E), the old man's (FR/LG). */
  TUTORIAL: 1 << 9,
  /** FR/LG: Pokémon Tower ghosts before the Silph Scope. */
  GHOST_UNVEILED: 1 << 13,
  GHOST: 1 << 15,
  POKEDUDE: 1 << 16,
} as const;

/** Poké Ball item ids 1–12 (Master … Premier); the Safari Ball (5) only works in the Safari Zone. */
const SAFARI_BALL = 5;

export interface Gen3Move extends DexMove {
  id: number;
  effect: number;
  power: number;
  accuracy: number;
}

/** One kind of wild encounter in an area: slots with their odds and level ranges. */
export interface WildGroup {
  kind: 'land' | 'water' | 'rock' | 'old' | 'good' | 'super';
  /** Encounter rate (the chance a step or cast finds anything), or rates when maps differ. */
  rate: [number, number];
  slots: WildSlot[];
}

// Slot odds (src/data/wild_encounters.json, the same in every Gen 3 game).
const LAND_CHANCES = [20, 20, 10, 10, 10, 10, 5, 5, 4, 4, 1, 1];
const WATER_CHANCES = [60, 30, 5, 4, 1];
const WILD_TITLES: Record<WildGroup['kind'], string> = {
  land: 'Grass and caves',
  water: 'Surfing',
  rock: 'Rock Smash',
  old: 'Old Rod',
  good: 'Good Rod',
  super: 'Super Rod',
};
const FISHING: { kind: 'old' | 'good' | 'super'; slots: number[]; chances: number[] }[] = [
  { kind: 'old', slots: [0, 1], chances: [70, 30] },
  { kind: 'good', slots: [2, 3, 4], chances: [60, 20, 20] },
  { kind: 'super', slots: [5, 6, 7, 8, 9], chances: [40, 40, 15, 4, 1] },
];

export interface Species {
  index: number;
  dex: number;
  name: string;
  types: [number, number];
  base: { hp: number; atk: number; def: number; spe: number; spa: number; spd: number };
  growth: number;
  catchRate: number;
  abilities: [number, number];
  family: number;
}

interface MilestoneDef {
  cls: string;
  name: string;
  label: string;
  badgeBit: number | null;
}

const LEADERS_HOENN = (eighth: string): MilestoneDef[] => [
  { cls: 'LEADER', name: 'ROXANNE', label: 'Roxanne', badgeBit: 0 },
  { cls: 'LEADER', name: 'BRAWLY', label: 'Brawly', badgeBit: 1 },
  { cls: 'LEADER', name: 'WATTSON', label: 'Wattson', badgeBit: 2 },
  { cls: 'LEADER', name: 'FLANNERY', label: 'Flannery', badgeBit: 3 },
  { cls: 'LEADER', name: 'NORMAN', label: 'Norman', badgeBit: 4 },
  { cls: 'LEADER', name: 'WINONA', label: 'Winona', badgeBit: 5 },
  { cls: 'LEADER', name: 'TATE&LIZA', label: 'Tate & Liza', badgeBit: 6 },
  { cls: 'LEADER', name: eighth, label: prettyName(eighth), badgeBit: 7 },
  { cls: 'ELITE FOUR', name: 'SIDNEY', label: 'Sidney', badgeBit: null },
  { cls: 'ELITE FOUR', name: 'PHOEBE', label: 'Phoebe', badgeBit: null },
  { cls: 'ELITE FOUR', name: 'GLACIA', label: 'Glacia', badgeBit: null },
  { cls: 'ELITE FOUR', name: 'DRAKE', label: 'Drake', badgeBit: null },
];
const MILESTONES: Record<Gen3Family, MilestoneDef[]> = {
  rs: [...LEADERS_HOENN('WALLACE'), { cls: 'CHAMPION', name: 'STEVEN', label: 'Steven', badgeBit: null }],
  e: [...LEADERS_HOENN('JUAN'), { cls: 'CHAMPION', name: 'WALLACE', label: 'Wallace', badgeBit: null }],
  frlg: [
    { cls: 'LEADER', name: 'BROCK', label: 'Brock', badgeBit: 0 },
    { cls: 'LEADER', name: 'MISTY', label: 'Misty', badgeBit: 1 },
    { cls: 'LEADER', name: 'LT. SURGE', label: 'Lt. Surge', badgeBit: 2 },
    { cls: 'LEADER', name: 'ERIKA', label: 'Erika', badgeBit: 3 },
    { cls: 'LEADER', name: 'KOGA', label: 'Koga', badgeBit: 4 },
    { cls: 'LEADER', name: 'SABRINA', label: 'Sabrina', badgeBit: 5 },
    { cls: 'LEADER', name: 'BLAINE', label: 'Blaine', badgeBit: 6 },
    { cls: 'LEADER', name: 'GIOVANNI', label: 'Giovanni', badgeBit: 7 },
    { cls: 'ELITE FOUR', name: 'LORELEI', label: 'Lorelei', badgeBit: null },
    { cls: 'ELITE FOUR', name: 'BRUNO', label: 'Bruno', badgeBit: null },
    { cls: 'ELITE FOUR', name: 'AGATHA', label: 'Agatha', badgeBit: null },
    { cls: 'ELITE FOUR', name: 'LANCE', label: 'Lance', badgeBit: null },
    // The champion is your rival, with one team per starter: the cap is the strongest.
    { cls: 'CHAMPION', name: '', label: 'Champion', badgeBit: null },
  ],
};

// Table sizes (entries).
const SPECIES_COUNT = 412;
const TRAINER_COUNT: Record<Gen3Family, number> = { rs: 694, e: 855, frlg: 743 };
const MOVE_COUNT = 355;
/** FR/LG keep Kanto's map names from this region map section on. */
const KANTO_MAPSEC_START = 0x58;

export class Gen3Data implements Dex {
  readonly gen = 3 as const;
  readonly version: Gen3Version;
  readonly gameFamily: Gen3Family;
  readonly rom: Uint8Array;
  readonly sym: Gen3RomSymbols;
  readonly ram: Gen3RamSymbols;
  readonly species: Species[] = [];
  readonly moves: Gen3Move[] = [];
  /** gTypeEffectiveness in table order. */
  readonly typeTable: TypeTable = { rows: [], foresight: 0 };
  readonly trainerClasses: string[] = [];
  private readonly mapsecNames = new Map<number, string>();
  private readonly mapsecOfMap = new Map<number, number>();
  /** Maps with wild Pokémon, and their gWildMonHeaders entry. */
  private readonly wildMaps = new Map<number, number>();
  private readonly wildCache = new Map<string, WildGroup[]>();
  private dexStride = -1;
  private readonly itemNames = new Map<number, string>();
  private readonly sprites = new Map<number, string>();
  private wildAreasCache: { grouping: string; areas: Set<string> } | null = null;

  constructor(rom: Uint8Array, game: Gen3Game) {
    this.rom = rom;
    this.version = game.version;
    this.gameFamily = game.family;
    this.sym = ROM_SYMBOLS[game.variant];
    this.ram = RAM_SYMBOLS[game.family];
    this.readSpecies();
    this.readMoves();
    this.readTypeTable();
    this.readTrainerClasses();
    this.readMaps();
  }

  // ---- ROM access ----
  u8(a: number): number {
    return this.rom[a - 0x08000000] ?? 0;
  }

  u16(a: number): number {
    const o = a - 0x08000000;
    return this.rom[o] | (this.rom[o + 1] << 8);
  }

  u32(a: number): number {
    const o = a - 0x08000000;
    return (this.rom[o] | (this.rom[o + 1] << 8) | (this.rom[o + 2] << 16) | (this.rom[o + 3] << 24)) >>> 0;
  }

  private isRomPtr(p: number): boolean {
    return p >= 0x08000000 && p < 0x08000000 + this.rom.length;
  }

  text(a: number, max: number): string {
    return decodeText(this.rom, a - 0x08000000, max);
  }

  // ---- tables ----
  private readSpecies(): void {
    const s = this.sym;
    const evolvesFrom = new Map<number, number>();
    for (let i = 1; i < SPECIES_COUNT; i++) {
      for (let e = 0; e < 5; e++) {
        const p = s.evolutions + i * 40 + e * 8;
        const method = this.u16(p);
        const to = this.u16(p + 4);
        if (method && to && to < SPECIES_COUNT && !evolvesFrom.has(to)) evolvesFrom.set(to, i);
      }
    }
    for (let i = 0; i < SPECIES_COUNT; i++) {
      const b = s.baseStats + i * 28;
      let root = i;
      for (let guard = 0; guard < 4 && evolvesFrom.has(root); guard++) root = evolvesFrom.get(root)!;
      this.species.push({
        index: i,
        dex: i > 0 ? this.u16(s.dexNums + (i - 1) * 2) : 0,
        name: prettyName(this.text(s.speciesNames + i * 11, 11)),
        types: [this.u8(b + 6), this.u8(b + 7)],
        base: { hp: this.u8(b), atk: this.u8(b + 1), def: this.u8(b + 2), spe: this.u8(b + 3), spa: this.u8(b + 4), spd: this.u8(b + 5) },
        catchRate: this.u8(b + 8),
        growth: this.u8(b + 19),
        abilities: [this.u8(b + 22), this.u8(b + 23)],
        family: root,
      });
    }
  }

  private readMoves(): void {
    const s = this.sym;
    for (let i = 0; i < MOVE_COUNT; i++) {
      const p = s.moves + i * 12;
      this.moves.push({
        id: i,
        name: prettyName(this.text(s.moveNames + i * 13, 13)),
        effect: this.u8(p),
        power: this.u8(p + 1),
        type: this.u8(p + 2),
        accuracy: this.u8(p + 3),
        pp: this.u8(p + 4),
      });
    }
  }

  private readTypeTable(): void {
    const t = this.sym.typeEffectiveness;
    const rows = this.typeTable.rows;
    for (let i = 0; i < 256; i++) {
      const a = this.u8(t + i * 3);
      if (a === 0xff) break;
      if (a === 0xfe) {
        this.typeTable.foresight = rows.length;
        continue;
      }
      rows.push([a, this.u8(t + i * 3 + 1), this.u8(t + i * 3 + 2)]);
    }
    if (!this.typeTable.foresight) this.typeTable.foresight = rows.length;
  }

  private readTrainerClasses(): void {
    const s = this.sym;
    for (let i = 0; i < 128; i++) {
      const a = s.trainerClassNames + i * 13;
      if (a >= s.trainers && s.trainers > s.trainerClassNames) break;
      const name = this.text(a, 13);
      if (!name && i > 0) break;
      this.trainerClasses.push(name);
    }
  }

  private readMaps(): void {
    const s = this.sym;
    // Region map section names.
    if (s.regionMapEntries) {
      const count = this.gameFamily === 'e' ? 213 : 88;
      for (let i = 0; i < count; i++) {
        const p = this.u32(s.regionMapEntries + i * 8 + 4);
        if (this.isRomPtr(p)) this.mapsecNames.set(i, prettyName(this.text(p, 24)));
      }
    } else if (s.kantoMapName0) {
      // FR/LG: find the table of name pointers by its first entry.
      const want = s.kantoMapName0;
      let table = -1;
      for (let o = 0; o + 8 <= this.rom.length; o += 4) {
        if (this.u32(0x08000000 + o) === want && this.isRomPtr(this.u32(0x08000004 + o))) {
          table = 0x08000000 + o;
          break;
        }
      }
      for (let i = 0; table >= 0 && i < 109; i++) {
        const p = this.u32(table + i * 4);
        if (!this.isRomPtr(p)) break;
        this.mapsecNames.set(KANTO_MAPSEC_START + i, prettyName(this.text(p, 24)));
      }
    }
    // Map headers: group/num -> region map section.
    for (let g = 0; g < 64; g++) {
      const gp = this.u32(s.mapGroups + g * 4);
      if (!this.isRomPtr(gp)) break;
      const next = this.u32(s.mapGroups + (g + 1) * 4);
      for (let n = 0; n < 128; n++) {
        const a = gp + n * 4;
        if (this.isRomPtr(next) && a >= next) break;
        if (a === s.mapGroups) break;
        const hp = this.u32(a);
        if (!this.isRomPtr(hp)) break;
        this.mapsecOfMap.set((g << 8) | n, this.u8(hp + 0x14));
      }
    }
    // Maps with wild Pokémon.
    for (let i = 0; i < 512; i++) {
      const p = s.wildHeaders + i * 20;
      const group = this.u8(p);
      if (group === 0xff) break;
      const id = (group << 8) | this.u8(p + 1);
      // Emerald's Altering Cave has several headers; the first is the one in play.
      if (!this.wildMaps.has(id) && (this.u32(p + 4) || this.u32(p + 8) || this.u32(p + 16))) this.wildMaps.set(id, p);
    }
  }

  /** Region map section of a map (group << 8 | number). */
  mapsec(mapId: number): number | undefined {
    return this.mapsecOfMap.get(mapId);
  }

  /** Experience needed for a level at a growth rate. */
  expFor(growth: number, level: number): number {
    return this.u32(this.sym.expTables + (growth * 101 + Math.max(0, Math.min(100, level))) * 4);
  }

  /** Level for an amount of experience (box Pokémon don't store their level). */
  levelFor(species: number, exp: number): number {
    const growth = this.species[species]?.growth ?? 0;
    let lv = 1;
    while (lv < 100 && this.expFor(growth, lv + 1) <= exp) lv++;
    return lv;
  }

  /** A trainer's class, name and party (species and levels). */
  trainer(id: number): { cls: number; name: string; party: { level: number; species: number }[] } | null {
    const s = this.sym;
    if (id <= 0 || id > 1000) return null;
    const p = s.trainers + id * 40;
    const flags = this.u8(p);
    const size = this.u8(p + 32);
    const partyPtr = this.u32(p + 36);
    const party: { level: number; species: number }[] = [];
    if (this.isRomPtr(partyPtr) && size <= 6) {
      const stride = flags & 1 ? 16 : 8;
      for (let i = 0; i < size; i++) party.push({ level: this.u16(partyPtr + i * stride + 2), species: this.u16(partyPtr + i * stride + 4) });
    }
    return { cls: this.u8(p + 1), name: this.text(p + 4, 12), party };
  }

  /** Gym leaders, the Elite Four and the champion, with their aces (for level caps). */
  readMilestones(): Milestone[] {
    const defs = MILESTONES[this.gameFamily];
    const teams = new Map<MilestoneDef, { level: number; species: number }[][]>();
    for (let id = 1; id < TRAINER_COUNT[this.gameFamily]; id++) {
      const t = this.trainer(id);
      if (!t) break;
      const cls = this.trainerClasses[t.cls];
      for (const d of defs) {
        if (cls !== d.cls || (d.name && t.name !== d.name)) continue;
        // The first match is the original fight (rematches come later). The FR/LG
        // champion has a team per starter, so keep the first three.
        const list = teams.get(d) ?? [];
        if (list.length < (d.name ? 1 : 3)) teams.set(d, [...list, t.party]);
      }
    }
    const ace = (team: { level: number }[]) => team.reduce((m, t) => Math.max(m, t.level), 0);
    return defs.map((d) => {
      const team = (teams.get(d) ?? []).reduce<{ level: number; species: number }[]>((best, t) => (ace(t) > ace(best) ? t : best), []);
      return { id: d.label.toLowerCase().replace(/\W+/g, '-'), name: d.label, badgeBit: d.badgeBit, team, ace: ace(team) };
    });
  }

  /** A held item's hold effect and parameter (gItems). */
  holdEffect(item: number): { effect: number; param: number } {
    if (item <= 0 || item >= 400) return { effect: 0, param: 0 };
    const p = this.sym.items + item * 44;
    return { effect: this.u8(p + 18), param: this.u8(p + 19) };
  }

  abilityName(id: number): string {
    return id > 0 && id < 78 ? prettyName(this.text(this.sym.abilityNames + id * 13, 13)) : '';
  }

  /** Weight in hectograms (Pokédex data), or 0 if unknown. */
  weight(species: number): number {
    const dex = this.species[species]?.dex ?? 0;
    const p = this.sym.pokedexEntries;
    if (this.dexStride < 0) {
      // Emerald's entries are 32 bytes; R/S and FR/LG keep a second description pointer (36).
      this.dexStride = [32, 36].find((n) => this.u16(p + n + 12) === 7 && this.u16(p + n + 14) === 69) ?? 0;
    }
    return dex > 0 && this.dexStride ? this.u16(p + dex * this.dexStride + 14) : 0;
  }

  /** The wild Pokémon on one map, by encounter kind. */
  private mapWild(mapId: number): WildGroup[] {
    const h = this.wildMaps.get(mapId);
    if (h === undefined) return [];
    const out: WildGroup[] = [];
    const info = (ptr: number, n: number) => {
      if (!this.isRomPtr(ptr)) return null;
      const list = this.u32(ptr + 4);
      if (!this.isRomPtr(list)) return null;
      const mons = Array.from({ length: n }, (_, i) => {
        const lo = this.u8(list + i * 4);
        const hi = this.u8(list + i * 4 + 1);
        return { species: this.u16(list + i * 4 + 2), min: Math.min(lo, hi), max: Math.max(lo, hi) };
      });
      return { rate: this.u8(ptr), mons };
    };
    const simple = (kind: 'land' | 'water' | 'rock', ptr: number, chances: number[]) => {
      const t = info(ptr, chances.length);
      if (t) out.push({ kind, rate: [t.rate, t.rate], slots: t.mons.map((m, i) => ({ ...m, chance: chances[i] / 100 })) });
    };
    simple('land', this.u32(h + 4), LAND_CHANCES);
    simple('water', this.u32(h + 8), WATER_CHANCES);
    simple('rock', this.u32(h + 12), WATER_CHANCES);
    const fish = info(this.u32(h + 16), 10);
    if (fish) {
      for (const rod of FISHING) {
        out.push({ kind: rod.kind, rate: [fish.rate, fish.rate], slots: rod.slots.map((s, i) => ({ ...fish.mons[s], chance: rod.chances[i] / 100 })) });
      }
    }
    return out;
  }

  /**
   * Wild Pokémon across every map of an area, merged per encounter kind. A
   * species' chance is its average over the maps that have that kind.
   */
  wildArea(area: string): WildGroup[] {
    const hit = this.wildCache.get(area);
    if (hit) return hit;
    const maps = [...this.wildMaps.keys()].filter((m) => this.areaOf(m) === area);
    const byKind = new Map<WildGroup['kind'], WildGroup[]>();
    for (const m of maps) for (const g of this.mapWild(m)) byKind.set(g.kind, [...(byKind.get(g.kind) ?? []), g]);
    const out: WildGroup[] = [];
    for (const kind of ['land', 'water', 'rock', 'old', 'good', 'super'] as const) {
      const groups = byKind.get(kind);
      if (!groups) continue;
      const slots = new Map<number, WildSlot>();
      for (const g of groups) {
        for (const s of g.slots) {
          const e = slots.get(s.species) ?? { species: s.species, min: s.min, max: s.max, chance: 0 };
          e.min = Math.min(e.min, s.min);
          e.max = Math.max(e.max, s.max);
          e.chance += s.chance / groups.length;
          slots.set(s.species, e);
        }
      }
      const rates = groups.map((g) => g.rate[0]);
      out.push({ kind, rate: [Math.min(...rates), Math.max(...rates)], slots: [...slots.values()] });
    }
    this.wildCache.set(area, out);
    return out;
  }

  // ---- Dex ----
  speciesName(species: number): string {
    return this.species[species]?.name || `#${species}`;
  }

  family(species: number): number | undefined {
    return species > 0 ? this.species[species]?.family : undefined;
  }

  xpProgress(species: number, level: number, exp: number) {
    const sp = this.species[species];
    if (!sp || species === 0) return undefined;
    if (level >= 100) return null;
    const lo = this.expFor(sp.growth, level);
    const hi = this.expFor(sp.growth, level + 1);
    const span = Math.max(1, hi - lo);
    return { into: Math.min(span, Math.max(0, exp - lo)), span, toNext: Math.max(0, hi - exp) };
  }

  typeName(type: number): string {
    return TYPE_NAMES[type] ?? `Type ${type}`;
  }

  typeColor(type: number): string | undefined {
    return TYPE_COLORS[type];
  }

  move(id: number): DexMove | undefined {
    return id > 0 ? this.moves[id] : undefined;
  }

  trainerClassName(cls: number): string | undefined {
    const n = this.trainerClasses[cls];
    return n ? prettyName(n) : undefined;
  }

  itemName(id: number): string | undefined {
    if (!this.itemNames.has(id)) {
      const n = id > 0 && id < 400 ? prettyName(this.text(this.sym.items + id * 44, 14)) : '';
      this.itemNames.set(id, n);
    }
    return this.itemNames.get(id) || undefined;
  }

  areaOf(mapId: number): string {
    return this.mapName(mapId);
  }

  mapName(mapId: number): string {
    const sec = this.mapsecOfMap.get(mapId);
    return (sec !== undefined && this.mapsecNames.get(sec)) || `Map ${mapId >> 8}.${mapId & 0xff}`;
  }

  areaHasWild(area: string, rules: Rules): boolean {
    if (!this.wildAreasCache || this.wildAreasCache.grouping !== rules.areaGrouping) {
      this.wildAreasCache = { grouping: rules.areaGrouping, areas: new Set([...this.wildMaps.keys()].map((m) => this.areaOf(m))) };
    }
    return this.wildAreasCache.areas.has(area);
  }

  isStarter(_mapId: number, run: Run): boolean {
    // The first Pokémon a fresh run sees is the starter (R/S/E: Birch's bag; FR/LG: Oak's lab).
    return Object.keys(run.mons).length === 0;
  }

  badgeName(index: number): string {
    return BADGES[this.gameFamily][index] ?? `Badge ${index + 1}`;
  }

  hasPokeBalls(bag: Record<number, number>): boolean {
    for (let id = 1; id <= 12; id++) if (id !== SAFARI_BALL && (bag[id] ?? 0) > 0) return true;
    return false;
  }

  isBall(item: number): boolean {
    return item >= 1 && item <= 12;
  }

  scriptedBattle(battleType: number): boolean {
    if (battleType & (BATTLE_TYPE.LINK | BATTLE_TYPE.FIRST_BATTLE | BATTLE_TYPE.TUTORIAL)) return true;
    return this.gameFamily === 'frlg' && !!(battleType & BATTLE_TYPE.POKEDUDE);
  }

  spriteUrl(species: number): string | null {
    const hit = this.sprites.get(species);
    if (hit !== undefined) return hit || null;
    if (typeof document === 'undefined' || species <= 0 || species >= SPECIES_COUNT) return null;
    let url = '';
    try {
      const pic = lz77(this.rom, this.u32(this.sym.frontPics + species * 8) - 0x08000000);
      const pal = palette(lz77(this.rom, this.u32(this.sym.palettes + species * 8) - 0x08000000));
      const px = tiles4bpp(pic, 64, 64);
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      const img = ctx.createImageData(64, 64);
      for (let i = 0; i < px.length; i++) {
        if (px[i] === 0) continue;
        const [r, g, b] = pal[px[i]];
        img.data.set([r, g, b, 255], i * 4);
      }
      ctx.putImageData(img, 0, 0);
      url = canvas.toDataURL('image/png');
    } catch (err) {
      console.warn('sprite decode failed', species, err);
    }
    this.sprites.set(species, url);
    return url || null;
  }

  wildSections(mapId: number): WildSection[] {
    const groups = this.wildArea(this.areaOf(mapId));
    if (!groups.length) return [];
    const rate = ([lo, hi]: [number, number]) => (lo === hi ? `rate ${lo}` : `rate ${lo}–${hi}`);
    return [{ title: null, groups: groups.map((g) => ({ title: `${WILD_TITLES[g.kind]} (${rate(g.rate)})`, slots: g.slots })) }];
  }

  battle(snap: Snapshot): BattleInfo | null {
    return gen3Battle(this, snap);
  }
}

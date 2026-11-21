// What the run engine and the tracker UI need to know about a game, whichever
// generation it is. Gen1Data and Gen3Data implement it.

import type { BattleInfo, WildSection } from './battle.ts';
import type { Snapshot } from './events.ts';
import type { Rules, Run } from './types.ts';

export interface DexMove {
  name: string;
  type: number;
  pp: number;
}

export interface Dex {
  readonly gen: 1 | 3;
  /** Lowercase version id, e.g. 'red' or 'emerald'. */
  readonly version: string;
  speciesName(species: number): string;
  /** Evolution family id, or undefined for an unknown species. */
  family(species: number): number | undefined;
  /** Progress through the current level; null at level 100, undefined for an unknown species. */
  xpProgress(species: number, level: number, exp: number): { into: number; span: number; toNext: number } | null | undefined;
  typeName(type: number): string;
  typeColor(type: number): string | undefined;
  move(id: number): DexMove | undefined;
  trainerClassName(cls: number): string | undefined;
  itemName(id: number): string | undefined;
  /** The Nuzlocke area a map belongs to. */
  areaOf(mapId: number, rules: Rules): string;
  mapName(mapId: number): string;
  /** Whether any map in this area has wild Pokémon. */
  areaHasWild(area: string, rules: Rules): boolean;
  /** Whether a Pokémon received outside battle on this map is the run's starter. */
  isStarter(mapId: number, run: Run): boolean;
  badgeName(index: number): string;
  hasPokeBalls(bag: Record<number, number>): boolean;
  isBall(item: number): boolean;
  /** Battles that never count as encounters (tutorials, the first scripted battle). */
  scriptedBattle(battleType: number): boolean;
  /** A data URL for the species' sprite, or null (also outside the browser). */
  spriteUrl(species: number): string | null;
  /** Wild Pokémon for the route tab: the area's maps, or only this map when there's no run. */
  wildSections(mapId: number, rules: Rules | null): WildSection[];
  /** The battle tab's contents, or null outside battle. */
  battle(snap: Snapshot): BattleInfo | null;
}

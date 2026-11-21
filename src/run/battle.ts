// What the battle tab and the route tab's wild tables show, worked out by each
// generation (src/gen1/battle.ts, src/gen3/battle.ts) so the UI stays generic.

import type { DamageResult } from './damage.ts';

export interface DamageRow {
  move: number;
  name: string;
  /** The move's type as it will hit (Hidden Power and Weather Ball resolved). */
  type: number;
  result: DamageResult;
}

export interface BattleInfo {
  /** The foe's base stats, labelled. */
  baseStats: { label: string; value: number }[];
  /** "Youngster Joey's Pokémon", or null in the wild. */
  owner: string | null;
  /** The trainer's whole team. */
  team: { level: number; species: number }[];
  /** Short facts about the foe and the field: ability, held item, stat changes, weather. */
  facts: string[];
  /** Damage both ways between your Pokémon on the field and the foe. */
  danger: {
    myName: string;
    foeName: string;
    myHp: number;
    myMaxHp: number;
    theirs: DamageRow[];
    mine: DamageRow[];
    note: string;
  } | null;
  /** Your other standing Pokémon: how each of their moves would fare against the foe. */
  bench: { key: string; species: number; nickname: string; moves: { name: string; type: number; eff: number | null }[] }[];
}

export interface WildSlot {
  species: number;
  min: number;
  max: number;
  /** 0…1 */
  chance: number;
}

/** Wild tables for one map (Gen 1) or a whole area (Gen 3). */
export interface WildSection {
  /** Shown when an area has several sections. */
  title: string | null;
  groups: { title: string; slots: WildSlot[] }[];
}

/** Effectiveness of a damage result for a switch-in label: null for moves that do no damage. */
export function effOf(r: DamageResult): number | null {
  if (r.kind === 'status' || r.kind === 'varies') return null;
  return r.kind === 'immune' ? 0 : r.effectiveness;
}

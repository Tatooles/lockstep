// The battle tab and wild tables for Gen 1: damage both ways with the Gen 1
// formula, the trainer's team, and each map's grass, water and Super Rod slots.

import { type BattleInfo, type DamageRow, type WildSection } from '../run/battle.ts';
import type { Snapshot } from '../run/events.ts';
import type { Rules } from '../run/types.ts';
import { calcDamage, type Combatant } from './damage.ts';
import { MAPS } from './maps.ts';
import type { Gen1Data } from './rom.ts';

function toCombatant(x: { level: number; hp: number; maxHp: number; types: [number, number]; stats: { atk: number; def: number; spd: number; spc: number } }): Combatant {
  return { level: x.level, hp: x.hp, maxHp: x.maxHp, types: x.types, atk: x.stats.atk, def: x.stats.def, spd: x.stats.spd, spc: x.stats.spc };
}

export function gen1Battle(data: Gen1Data, snap: Snapshot): BattleInfo | null {
  const enemy = snap.enemy;
  if (!enemy) return null;
  const sp = data.species.get(enemy.species);
  const chart = (a: number, d: [number, number]) => data.effectiveness(a, d);
  const rows = (moves: number[], att: Combatant, def: Combatant): DamageRow[] =>
    moves
      .filter((id) => id > 0)
      .map((id) => {
        const mv = data.moves[id];
        return { move: id, name: mv?.name ?? `#${id}`, type: mv?.type ?? 0, result: calcDamage(mv, att, def, chart) };
      });

  let danger: BattleInfo['danger'] = null;
  const me = snap.battleMon;
  if (!enemy.ghost && me && me.species > 0) {
    const mine = toCombatant(me);
    const theirs = toCombatant(enemy);
    const myName = snap.party[snap.activeSlot]?.nickname ?? data.speciesName(me.species);
    const foeName = data.speciesName(enemy.species);
    danger = {
      myName,
      foeName,
      myHp: me.hp,
      myMaxHp: me.maxHp,
      theirs: rows(enemy.moves, theirs, mine),
      mine: rows(me.moves, mine, theirs),
      note:
        "Ranges use current in-battle stats; Reflect and Light Screen aren't counted. " +
        (mine.spd > theirs.spd ? `${myName} moves first.` : mine.spd < theirs.spd ? `${foeName} moves first.` : 'Speed tie.'),
    };
  }

  return {
    baseStats: sp && !enemy.ghost
      ? [
          { label: 'HP', value: sp.base.hp },
          { label: 'Atk', value: sp.base.atk },
          { label: 'Def', value: sp.base.def },
          { label: 'Spe', value: sp.base.spd },
          { label: 'Spc', value: sp.base.spc },
        ]
      : [],
    owner: enemy.trainerClass ? `${data.trainerClasses[enemy.trainerClass]}'s Pokémon` : null,
    team: enemy.trainerClass && enemy.trainerNo ? (data.trainerParties(enemy.trainerClass)[enemy.trainerNo - 1]?.mons ?? []) : [],
    facts: [],
    danger,
    bench: enemy.ghost
      ? []
      : snap.party
          .filter((m, i) => i !== snap.activeSlot && m.hp > 0)
          .map((m) => ({
            key: m.key,
            species: m.species,
            nickname: m.nickname,
            moves: m.moves
              .filter((x) => x > 0)
              .map((id) => {
                const mv = data.moves[id];
                const eff = mv && mv.power > 0 ? data.effectiveness(mv.type, enemy.types) : null;
                return { name: mv?.name ?? `#${id}`, type: mv?.type ?? 0, eff };
              }),
          })),
  };
}

export function gen1Wild(data: Gen1Data, mapId: number, rules: Rules | null): WildSection[] {
  const area = rules ? data.areaOf(mapId, rules) : null;
  const ids = rules ? MAPS.filter((m) => data.areaOf(m.id, rules) === area).map((m) => m.id) : [mapId];
  // Current map first.
  ids.sort((a, b) => (a === mapId ? -1 : b === mapId ? 1 : a - b));
  const sections: WildSection[] = [];
  for (const id of ids) {
    const t = data.wild(id);
    if (!t) continue;
    const slots = (list: { level: number; species: number; chance: number }[]) => list.map((s) => ({ species: s.species, min: s.level, max: s.level, chance: s.chance }));
    const groups: WildSection['groups'] = [];
    if (t.grass.length) groups.push({ title: `Grass and caves (rate ${t.grassRate})`, slots: slots(t.grass) });
    if (t.water.length) groups.push({ title: `Surfing (rate ${t.waterRate})`, slots: slots(t.water) });
    if (t.superRod.length) groups.push({ title: 'Super Rod', slots: slots(t.superRod.map((s) => ({ ...s, chance: 1 / t.superRod.length }))) });
    sections.push({ title: MAPS[id].name, groups });
  }
  if (sections.length === 1) sections[0].title = null;
  return sections;
}

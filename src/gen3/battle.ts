// The battle tab for Gen 3: damage both ways with the Gen 3 formula (abilities,
// held items, stat stages, weather, Reflect and Light Screen), the trainer's
// team, and how your other Pokémon's moves would fare.

import { effOf, type BattleInfo, type DamageRow } from '../run/battle.ts';
import type { BattleExtras, Snapshot, Stats } from '../run/events.ts';
import { battleSpeed, calcDamage3, resolveMove, SIDE, STAGE, WEATHER, type BattleField, type Battler } from './damage.ts';
import { BATTLE_TYPE, type Gen3Data } from './rom.ts';
import { prettyName } from './text.ts';

const STAGE_LABELS: [number, string][] = [
  [STAGE.ATK, 'Atk'], [STAGE.DEF, 'Def'], [STAGE.SPA, 'SpA'], [STAGE.SPD, 'SpD'], [STAGE.SPE, 'Spe'], [STAGE.ACC, 'accuracy'], [STAGE.EVA, 'evasion'],
];

const NO_STAGES = [0, 0, 0, 0, 0, 0, 0, 0];

interface MonLike {
  species: number;
  level: number;
  hp: number;
  maxHp: number;
  types: [number, number];
  stats: Stats | null;
}

export function toBattler(data: Gen3Data, m: MonLike, extra: BattleExtras, player: boolean): Battler {
  const hold = data.holdEffect(extra.item);
  const s = m.stats ?? { atk: 0, def: 0, spd: 0, spc: 0, spdef: 0 };
  return {
    species: m.species,
    level: m.level,
    hp: m.hp,
    maxHp: m.maxHp,
    types: m.types,
    atk: s.atk,
    def: s.def,
    spe: s.spd,
    spa: s.spc,
    spd: s.spdef ?? s.spc,
    stages: extra.stages,
    ability: extra.ability,
    holdEffect: hold.effect,
    holdParam: hold.param,
    status: extra.status,
    status2: extra.status2,
    ivs: extra.ivs,
    friendship: extra.friendship,
    weight: data.weight(m.species),
    player,
  };
}

const sign = (n: number) => (n > 0 ? `+${n}` : `−${-n}`);

function stageText(stages: number[]): string {
  return STAGE_LABELS.filter(([i]) => stages[i])
    .map(([i, l]) => `${l} ${sign(stages[i])}`)
    .join(', ');
}

function weatherName(w: number): string | null {
  if (w & WEATHER.RAIN) return 'Rain';
  if (w & WEATHER.SUN) return 'Harsh sunlight';
  if (w & WEATHER.SANDSTORM) return 'Sandstorm';
  if (w & WEATHER.HAIL) return 'Hail';
  return null;
}

export function gen3Battle(data: Gen3Data, snap: Snapshot): BattleInfo | null {
  const enemy = snap.enemy;
  if (!enemy) return null;
  const sp = data.species[enemy.species];
  const f = snap.field ?? { weather: 0, sides: [0, 0] as [number, number], double: false };
  const link = !!(snap.battleType & BATTLE_TYPE.LINK);
  const fieldFor = (defenderIsPlayer: boolean): BattleField => ({
    weather: f.weather,
    badges: snap.badges,
    link,
    defenderSide: f.sides[defenderIsPlayer ? 0 : 1],
  });
  const foeExtra = enemy.extra ?? { ability: 0, item: 0, stages: NO_STAGES, status: 0, status2: 0, ivs: 0, friendship: 0 };
  const foe = toBattler(data, enemy, foeExtra, false);
  const rows = (moves: number[], att: Battler, def: Battler): DamageRow[] =>
    moves
      .filter((id) => id > 0 && data.moves[id])
      .map((id) => {
        const mv = data.moves[id];
        const type = resolveMove(mv, att, f.weather)?.type ?? mv.type;
        return { move: id, name: mv.name, type, result: calcDamage3(mv, att, def, data.typeTable, fieldFor(def.player)) };
      });

  const facts: string[] = [];
  if (!enemy.ghost) {
    if (foeExtra.ability) facts.push(`Ability: ${data.abilityName(foeExtra.ability)}`);
    if (foeExtra.item) facts.push(`Holding ${data.itemName(foeExtra.item) ?? `item ${foeExtra.item}`}`);
    const st = stageText(foeExtra.stages);
    if (st) facts.push(st);
  }
  const w = weatherName(f.weather);
  if (w) facts.push(w);
  if (f.sides[1] & SIDE.REFLECT) facts.push('Their Reflect');
  if (f.sides[1] & SIDE.LIGHT_SCREEN) facts.push('Their Light Screen');
  if (f.sides[0] & SIDE.REFLECT) facts.push('Your Reflect');
  if (f.sides[0] & SIDE.LIGHT_SCREEN) facts.push('Your Light Screen');

  let danger: BattleInfo['danger'] = null;
  const bm = snap.battleMon;
  if (!enemy.ghost && bm?.extra) {
    const me = toBattler(data, bm, bm.extra, true);
    const myName = snap.party[snap.activeSlot]?.nickname ?? data.speciesName(bm.species);
    const foeName = data.speciesName(enemy.species);
    const mySpeed = battleSpeed(me, foe, fieldFor(false));
    const foeSpeed = battleSpeed(foe, me, fieldFor(true));
    const myStages = stageText(bm.extra.stages);
    danger = {
      myName,
      foeName,
      myHp: bm.hp,
      myMaxHp: bm.maxHp,
      theirs: rows(enemy.moves, foe, me),
      mine: rows(bm.moves, me, foe),
      note:
        'Ranges count stat changes, abilities, held items, badges, weather, Reflect and Light Screen. ' +
        (myStages ? `${myName}: ${myStages}. ` : '') +
        (mySpeed > foeSpeed ? `${myName} moves first.` : mySpeed < foeSpeed ? `${foeName} moves first.` : 'Speed tie.') +
        (f.double ? ' Double battle: only the first foe is shown.' : ''),
    };
  }

  const t = enemy.trainerNo ? data.trainer(enemy.trainerNo) : null;
  return {
    baseStats:
      sp && !enemy.ghost
        ? [
            { label: 'HP', value: sp.base.hp },
            { label: 'Atk', value: sp.base.atk },
            { label: 'Def', value: sp.base.def },
            { label: 'SpA', value: sp.base.spa },
            { label: 'SpD', value: sp.base.spd },
            { label: 'Spe', value: sp.base.spe },
          ]
        : [],
    owner: t ? `${[data.trainerClassName(t.cls), prettyName(enemy.trainerName ?? t.name)].filter(Boolean).join(' ')}'s Pokémon` : null,
    team: t?.party ?? [],
    facts,
    danger,
    bench: enemy.ghost
      ? []
      : snap.party
          .map((m, i) => ({ m, i }))
          .filter(({ m, i }) => i !== snap.activeSlot && m.hp > 0)
          .map(({ m }) => {
            const extra: BattleExtras = { ability: m.ability ?? 0, item: m.item ?? 0, stages: NO_STAGES, status: m.status, status2: 0, ivs: m.ivs ?? 0, friendship: m.friendship ?? 0 };
            const b = toBattler(data, m, extra, true);
            return {
              key: m.key,
              species: m.species,
              nickname: m.nickname,
              moves: rows(m.moves, b, foe).map((r) => ({ name: r.name, type: r.type, eff: effOf(r.result) })),
            };
          }),
  };
}

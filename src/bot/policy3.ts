// Gen 3 battle decisions for auto-grind: the shared policy (policy.ts) fed by
// the Gen 3 damage formula, with abilities, held items, stat stages, weather
// and screens, plus move priority and accuracy stages.

import { battleSpeed, calcDamage3, EFFECT, STAGE, type BattleField, type Battler, type Move3, type TypeTable } from '../gen3/damage.ts';
import { canKo, decide, rankMoves, type BattleAction, type MoveOption, type RankedMove } from './policy.ts';

export interface Move3Info extends Move3 {
  priority: number;
}

export interface Duel3 {
  me: Battler;
  foe: Battler;
  myMoves: number[];
  /** In-battle PP per slot. */
  myPp: number[];
  foeMoves: number[];
  /** Move table indexed by id. */
  moves: Move3Info[];
  chart: TypeTable;
  /** The field when the foe is hit, and when we are (each side's screens differ). */
  vsFoe: BattleField;
  vsMe: BattleField;
  /** Slots the game refused this turn (Disable, Taunt, Torment, a Choice Band lock…). */
  exclude?: ReadonlySet<number>;
}

const E = {
  ...EFFECT,
  DREAM_EATER: 8, ALWAYS_HIT: 17, RAMPAGE: 27, RAZOR_WIND: 39, RECOIL: 48, SKY_ATTACK: 75, RECHARGE: 80, RAGE: 81,
  SNORE: 92, FALSE_SWIPE: 101, ROLLOUT: 117, SKULL_BASH: 145, FUTURE_SIGHT: 148, SOLAR_BEAM: 151, SEMI_INVULNERABLE: 155,
  FAKE_OUT: 158, UPROAR: 159, MEMENTO: 168, FOCUS_PUNCH: 170, DOUBLE_EDGE: 198,
} as const;

/**
 * Moves the bot never picks: they faint the user, lock it in, only work in
 * special cases, can't knock out (False Swipe) or are too unreliable (OHKO).
 */
const BANNED = new Set<number>([
  E.EXPLOSION, E.DREAM_EATER, E.BIDE, E.RAMPAGE, E.RAGE, E.COUNTER, E.MIRROR_COAT, E.SNORE, E.FALSE_SWIPE, E.ROLLOUT,
  E.FUTURE_SIGHT, E.FAKE_OUT, E.UPROAR, E.SPIT_UP, E.MEMENTO, E.FOCUS_PUNCH, E.ENDEAVOR, E.OHKO,
]);
const CHARGE = new Set<number>([E.RAZOR_WIND, E.SKY_ATTACK, E.SKULL_BASH, E.SOLAR_BEAM, E.SEMI_INVULNERABLE]);

// sAccuracyStageRatios: accuracy stage minus evasion stage, −6…+6.
const ACC_RATIOS: [number, number][] = [
  [33, 100], [36, 100], [43, 100], [50, 100], [60, 100], [75, 100], [1, 1], [133, 100], [166, 100], [2, 1], [233, 100], [133, 50], [3, 1],
];

/** Whether the bot would use this move at all. */
function usable(m: Move3Info | undefined): m is Move3Info {
  return !!m && m.power > 0 && !BANNED.has(m.effect);
}

/** Whether any move the bot would use still has PP. */
export function hasUsableMove3(ids: number[], pp: number[], moves: Move3Info[]): boolean {
  return ids.some((id, i) => !!id && pp[i] > 0 && usable(moves[id]));
}

function hitChance(m: Move3Info, me: Battler, foe: Battler): number {
  if (m.accuracy === 0 || m.effect === E.ALWAYS_HIT) return 1;
  const stage = Math.max(-6, Math.min(6, (me.stages[STAGE.ACC] ?? 0) - (foe.stages[STAGE.EVA] ?? 0)));
  const [n, d] = ACC_RATIOS[stage + 6];
  return Math.min(1, (m.accuracy * n) / d / 100);
}

/** Usable damaging moves, best first. */
export function scoreMoves3(d: Duel3): RankedMove[] {
  const opts: MoveOption[] = [];
  d.myMoves.forEach((id, slot) => {
    const m = d.moves[id];
    if (!id || !usable(m) || d.myPp[slot] === 0 || d.exclude?.has(slot)) return;
    opts.push({
      slot,
      hitChance: hitChance(m, d.me, d.foe),
      result: calcDamage3(m, d.me, d.foe, d.chart, d.vsFoe),
      priority: m.priority,
      tempo: CHARGE.has(m.effect) ? 'charge' : m.effect === E.RECHARGE ? 'recharge' : 'normal',
      recoil: m.effect === E.RECOIL ? 0.25 : m.effect === E.DOUBLE_EDGE ? 1 / 3 : 0,
    });
  });
  return rankMoves(opts, d.me.hp, d.foe.hp);
}

/** Priorities of the foe's moves that could knock us out this turn (a critical hit counts). */
export function foeThreats3(d: Duel3): number[] {
  const out: number[] = [];
  for (const id of d.foeMoves) {
    const m = d.moves[id];
    if (!id || !m) continue;
    if (canKo(calcDamage3(m, d.foe, d.me, d.chart, d.vsMe), d.me.hp)) out.push(m.priority);
  }
  return out;
}

export function chooseAction3(d: Duel3): BattleAction {
  const faster = battleSpeed(d.me, d.foe, d.vsFoe) > battleSpeed(d.foe, d.me, d.vsMe);
  return decide(scoreMoves3(d), foeThreats3(d), faster);
}

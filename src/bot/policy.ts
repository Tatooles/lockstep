// Battle decisions for auto-grind. Pure functions over the damage calculator.
//
// The bot plays scared: in a Nuzlocke a lost Pokémon is gone, so it runs from
// anything that could knock out its lead this turn, critical hits included,
// unless it moves first and is sure to win the turn.

import { calcDamage, threatOf, type Combatant, type TypeChart } from '../gen1/damage.ts';
import type { Move } from '../gen1/rom.ts';

export interface Fighter extends Combatant {
  moves: number[];
  /** PP per move slot (the active Pokémon's in-battle PP). */
  pp?: number[];
}

export type BattleAction = { kind: 'fight'; slot: number; why: string } | { kind: 'run'; why: string };

// Move effects (pret constants/move_effect_constants.asm).
const EXPLODE = 0x07;
const DREAM_EATER = 0x08;
const BIDE = 0x1a;
const THRASH = 0x1b;
const CHARGE = 0x27;
const FLY = 0x2b;
const RECOIL = 0x30;
const HYPER_BEAM = 0x50;
const RAGE = 0x51;
const COUNTER = 0x44; // move id; its effect is handled in code

/** Moves the bot never picks: they faint the user, lock it in, or need setup it won't do. */
function banned(m: Move): boolean {
  return m.id === COUNTER || [EXPLODE, DREAM_EATER, BIDE, THRASH, RAGE].includes(m.effect);
}

/** Whether any move the bot would use still has PP. */
export function hasUsableMove(ids: number[], pp: number[], moves: Move[]): boolean {
  return ids.some((id, i) => {
    const m = moves[id];
    return !!id && !!m && pp[i] > 0 && !banned(m) && (m.power > 0 || m.effect === 0x29 || m.effect === 0x28);
  });
}

export interface MoveScore {
  slot: number;
  move: Move;
  /** Expected damage this turn, after accuracy. */
  expected: number;
  /** Knocks the foe out on the lowest roll if it hits. */
  sureKo: boolean;
}

/** Usable damaging moves, best first. */
export function scoreMoves(me: Fighter, foe: Combatant, moves: Move[], chart: TypeChart): MoveScore[] {
  const out: MoveScore[] = [];
  me.moves.forEach((id, slot) => {
    const move = moves[id];
    if (!id || !move || banned(move)) return;
    if (me.pp && me.pp[slot] === 0) return;
    const r = calcDamage(move, me, foe, chart);
    if (r.kind === 'status' || r.kind === 'immune') return;
    const hitsAvg = (r.hits[0] + r.hits[1]) / 2;
    const acc = Math.min(move.accuracy, 100) / 100;
    let expected = ((r.min + r.max) / 2) * hitsAvg * acc;
    const sureKo = r.min * r.hits[0] >= foe.hp;
    // Two-turn and recharge moves give the foe a free turn.
    if (move.effect === CHARGE || move.effect === FLY) expected /= 2;
    if (move.effect === HYPER_BEAM && !sureKo) expected /= 2;
    // Recoil hurts us by a quarter of the damage dealt.
    if (move.effect === RECOIL && (Math.min(r.max, foe.hp) / 4 >= me.hp * 0.5)) return;
    out.push({ slot, move, expected: Math.min(expected, foe.hp), sureKo });
  });
  return out.sort((a, b) => {
    if (a.sureKo !== b.sureKo) return a.sureKo ? -1 : 1;
    if (a.sureKo) return b.move.accuracy - a.move.accuracy || b.expected - a.expected;
    return b.expected - a.expected;
  });
}

/** Whether the foe has a move that could knock `me` out this turn (a critical hit counts). */
export function foeCanKo(me: Fighter, foe: Fighter, moves: Move[], chart: TypeChart): boolean {
  return foe.moves.some((id) => {
    const move = moves[id];
    if (!id || !move) return false;
    const t = threatOf(calcDamage(move, foe, me, chart), me.hp);
    return t === 'ko' || t === 'crit-ko';
  });
}

export function chooseAction(me: Fighter, foe: Fighter, moves: Move[], chart: TypeChart): BattleAction {
  const scored = scoreMoves(me, foe, moves, chart);
  const best = scored[0];
  if (!best) return { kind: 'run', why: 'no usable moves' };
  if (foeCanKo(me, foe, moves, chart)) {
    // Moving first with a sure KO ends the battle before the foe acts.
    if (me.spd > foe.spd && best.sureKo && best.move.accuracy >= 100) return { kind: 'fight', slot: best.slot, why: 'finish it first' };
    return { kind: 'run', why: 'too dangerous' };
  }
  return { kind: 'fight', slot: best.slot, why: best.sureKo ? 'knock out' : 'best damage' };
}

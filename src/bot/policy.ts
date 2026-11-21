// Battle decisions for auto-grind. Pure functions over the damage calculators.
//
// The bot plays scared: in a Nuzlocke a lost Pokémon is gone, so it runs from
// anything that could knock out its lead this turn, critical hits included,
// unless it moves first and is sure to win the turn.
//
// The ranking and the run-or-fight call are shared; each generation turns its
// moves into MoveOptions with its own damage formula (Gen 1 below, Gen 3 in
// policy3.ts).

import { calcDamage, threatOf, type Combatant, type TypeChart } from '../gen1/damage.ts';
import type { Move } from '../gen1/rom.ts';
import type { DamageResult } from '../run/damage.ts';

export type BattleAction = { kind: 'fight'; slot: number; why: string } | { kind: 'run'; why: string };

/** One of our moves, already run through a generation's damage formula. */
export interface MoveOption {
  slot: number;
  /** Chance to hit, 0…1. */
  hitChance: number;
  result: DamageResult;
  priority: number;
  /** Two-turn moves give the foe a free turn; so do moves that need a recharge (unless they win). */
  tempo: 'normal' | 'charge' | 'recharge';
  /** Share of the damage dealt that comes back as recoil (0 for none). */
  recoil: number;
}

export interface RankedMove {
  slot: number;
  hitChance: number;
  priority: number;
  /** Expected damage this turn, after accuracy. */
  expected: number;
  /** Knocks the foe out on the lowest roll if it hits. */
  sureKo: boolean;
}

/** Damaging options, best first: sure knockouts (most accurate first), then expected damage. */
export function rankMoves(options: MoveOption[], myHp: number, foeHp: number): RankedMove[] {
  const out: RankedMove[] = [];
  for (const o of options) {
    const r = o.result;
    if (r.kind === 'status' || r.kind === 'immune' || r.kind === 'varies' || r.kind === 'ohko') continue;
    const hitsAvg = (r.hits[0] + r.hits[1]) / 2;
    let expected = ((r.min + r.max) / 2) * hitsAvg * o.hitChance;
    const sureKo = r.min * r.hits[0] >= foeHp;
    if (o.tempo === 'charge') expected /= 2;
    if (o.tempo === 'recharge' && !sureKo) expected /= 2;
    // Don't trade half our HP in recoil for a hit.
    if (o.recoil > 0 && Math.min(r.max * r.hits[1], foeHp) * o.recoil >= myHp * 0.5) continue;
    out.push({ slot: o.slot, hitChance: o.hitChance, priority: o.priority, expected: Math.min(expected, foeHp), sureKo });
  }
  return out.sort((a, b) => {
    if (a.sureKo !== b.sureKo) return a.sureKo ? -1 : 1;
    if (a.sureKo) return b.hitChance - a.hitChance || b.expected - a.expected;
    return b.expected - a.expected;
  });
}

/** Whether a foe's move result could knock out a defender at this HP, a critical hit included. */
export function canKo(r: DamageResult, hp: number): boolean {
  const t = threatOf(r, hp);
  return t === 'ko' || t === 'crit-ko';
}

/**
 * Fight with the best move, or run. `threats` are the priorities of the foe's
 * moves that could knock us out this turn; `faster` is whether we win a speed tie-break.
 */
export function decide(ranked: RankedMove[], threats: number[], faster: boolean): BattleAction {
  const best = ranked[0];
  if (!best) return { kind: 'run', why: 'no usable moves' };
  if (threats.length) {
    // Moving first with a sure KO ends the battle before the foe acts.
    const first = threats.every((p) => best.priority > p || (best.priority === p && faster));
    if (first && best.sureKo && best.hitChance >= 1) return { kind: 'fight', slot: best.slot, why: 'finish it first' };
    return { kind: 'run', why: 'too dangerous' };
  }
  return { kind: 'fight', slot: best.slot, why: best.sureKo ? 'knock out' : 'best damage' };
}

// ---- Gen 1 ----

export interface Fighter extends Combatant {
  moves: number[];
  /** PP per move slot (the active Pokémon's in-battle PP). */
  pp?: number[];
}

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

export interface MoveScore extends RankedMove {
  move: Move;
}

function options(me: Fighter, foe: Combatant, moves: Move[], chart: TypeChart): MoveOption[] {
  const out: MoveOption[] = [];
  me.moves.forEach((id, slot) => {
    const move = moves[id];
    if (!id || !move || banned(move)) return;
    if (me.pp && me.pp[slot] === 0) return;
    out.push({
      slot,
      hitChance: Math.min(move.accuracy, 100) / 100,
      result: calcDamage(move, me, foe, chart),
      priority: 0,
      tempo: move.effect === CHARGE || move.effect === FLY ? 'charge' : move.effect === HYPER_BEAM ? 'recharge' : 'normal',
      recoil: move.effect === RECOIL ? 0.25 : 0,
    });
  });
  return out;
}

/** Usable damaging moves, best first. */
export function scoreMoves(me: Fighter, foe: Combatant, moves: Move[], chart: TypeChart): MoveScore[] {
  return rankMoves(options(me, foe, moves, chart), me.hp, foe.hp).map((r) => ({ ...r, move: moves[me.moves[r.slot]] }));
}

/** Whether the foe has a move that could knock `me` out this turn (a critical hit counts). */
export function foeCanKo(me: Fighter, foe: Fighter, moves: Move[], chart: TypeChart): boolean {
  return foe.moves.some((id) => {
    const move = moves[id];
    return !!id && !!move && canKo(calcDamage(move, foe, me, chart), me.hp);
  });
}

export function chooseAction(me: Fighter, foe: Fighter, moves: Move[], chart: TypeChart): BattleAction {
  const ranked = rankMoves(options(me, foe, moves, chart), me.hp, foe.hp);
  return decide(ranked, foeCanKo(me, foe, moves, chart) ? [0] : [], me.spd > foe.spd);
}

// Gen 1 damage calculation (port of pret engine/battle/core.asm CalculateDamage,
// AdjustDamageForMoveType and RandomizeDamage).

import type { DamageResult } from '../run/damage.ts';
import type { Move } from './rom.ts';

export interface Combatant {
  level: number;
  hp: number;
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
  spc: number;
  types: [number, number];
}

export { threatOf, type DamageResult, type Threat } from '../run/damage.ts';

const EXPLODE_EFFECT = 0x07;
const TWO_TO_FIVE_ATTACKS_EFFECT = 0x1d;
const OHKO_EFFECT = 0x26;
const SUPER_FANG_EFFECT = 0x28;
const SPECIAL_DAMAGE_EFFECT = 0x29;
const ATTACK_TWICE_EFFECT = 0x2c;
const TWINEEDLE_EFFECT = 0x4d;

const SEISMIC_TOSS = 0x45;
const NIGHT_SHADE = 0x65;
const SONICBOOM = 0x31;
const DRAGON_RAGE = 0x52;
const PSYWAVE = 0x95;

/** Types below FIRE ($14) are physical in Gen 1. */
export function isPhysical(type: number): boolean {
  return type < 0x14;
}

export type TypeChart = (atk: number, def: [number, number]) => number;

/** Base damage before STAB, type, and the random roll. */
export function baseDamage(level: number, attack: number, defense: number, power: number): number {
  let a = attack;
  let d = defense;
  if (a > 255 || d > 255) {
    a = Math.floor(a / 4) & 0xff;
    d = Math.floor(d / 4) & 0xff;
  }
  if (d === 0) d = 1;
  let t = Math.floor((2 * level) / 5) + 2;
  t = Math.floor((t * power * a) / d);
  t = Math.floor(t / 50);
  return Math.min(t, 997) + 2;
}

function finish(dmg: number, move: Move, attacker: Combatant, mults: number[]): number {
  if (attacker.types[0] === move.type || attacker.types[1] === move.type) dmg += Math.floor(dmg / 2);
  for (const m of mults) dmg = Math.floor((dmg * m * 10) / 10);
  return dmg;
}

function roll(dmg: number): [number, number] {
  if (dmg <= 1) return [dmg, dmg];
  return [Math.floor((dmg * 217) / 255), dmg];
}

export function calcDamage(move: Move, attacker: Combatant, defender: Combatant, chart: TypeChart): DamageResult {
  const none: DamageResult = { kind: 'status', min: 0, max: 0, critMin: 0, critMax: 0, hits: [1, 1], effectiveness: 1 };
  if (!move || move.id === 0) return none;

  // Fixed damage moves ignore types and stats.
  if (move.effect === SPECIAL_DAMAGE_EFFECT) {
    let lo: number;
    let hi: number;
    if (move.id === SEISMIC_TOSS || move.id === NIGHT_SHADE) lo = hi = attacker.level;
    else if (move.id === SONICBOOM) lo = hi = 20;
    else if (move.id === DRAGON_RAGE) lo = hi = 40;
    else if (move.id === PSYWAVE) {
      lo = 1;
      hi = Math.max(1, Math.floor((attacker.level * 3) / 2) - 1);
    } else lo = hi = attacker.level;
    return { ...none, kind: 'fixed', min: lo, max: hi, critMin: lo, critMax: hi };
  }
  if (move.effect === SUPER_FANG_EFFECT) {
    const d = Math.max(1, Math.floor(defender.hp / 2));
    return { ...none, kind: 'fixed', min: d, max: d, critMin: d, critMax: d };
  }
  if (move.effect === OHKO_EFFECT) {
    const works = attacker.spd >= defender.spd;
    return { ...none, kind: works ? 'ohko' : 'immune', min: works ? defender.hp : 0, max: works ? defender.hp : 0, critMin: 0, critMax: 0 };
  }
  if (move.power === 0) return none;

  const eff = chart(move.type, defender.types);
  if (eff === 0) return { ...none, kind: 'immune', effectiveness: 0 };
  const mults: number[] = [];
  const t0 = chart(move.type, [defender.types[0], defender.types[0]]);
  if (t0 !== 1) mults.push(t0);
  if (defender.types[1] !== defender.types[0]) {
    const t1 = chart(move.type, [defender.types[1], defender.types[1]]);
    if (t1 !== 1) mults.push(t1);
  }

  const phys = isPhysical(move.type);
  const a = phys ? attacker.atk : attacker.spc;
  let d = phys ? defender.def : defender.spc;
  if (move.effect === EXPLODE_EFFECT) d = Math.max(1, d >> 1);
  const normal = finish(baseDamage(attacker.level, a, d, move.power), move, attacker, mults);
  const crit = finish(baseDamage(attacker.level * 2, a, d, move.power), move, attacker, mults);
  const [min, max] = roll(normal);
  const [critMin, critMax] = roll(crit);
  let hits: [number, number] = [1, 1];
  if (move.effect === TWO_TO_FIVE_ATTACKS_EFFECT) hits = [2, 5];
  else if (move.effect === ATTACK_TWICE_EFFECT || move.effect === TWINEEDLE_EFFECT) hits = [2, 2];
  return { kind: 'damage', min, max, critMin, critMax, hits, effectiveness: eff };
}

// Gen 3 damage calculation: a port of the decompilations' CalculateBaseDamage
// (src/pokemon.c), the damagecalc, typecalc and adjustnormaldamage battle
// script commands, and the moves whose power or type is worked out in battle
// (Hidden Power, Return, Flail, Eruption, Low Kick, Facade, Weather Ball…).
// Identical in Ruby/Sapphire, Emerald and FireRed/LeafGreen.

import { NO_DAMAGE, type DamageResult } from '../run/damage.ts';

export const TYPE = {
  NORMAL: 0, FIGHTING: 1, FLYING: 2, POISON: 3, GROUND: 4, ROCK: 5, BUG: 6, GHOST: 7, STEEL: 8, MYSTERY: 9,
  FIRE: 10, WATER: 11, GRASS: 12, ELECTRIC: 13, PSYCHIC: 14, ICE: 15, DRAGON: 16, DARK: 17,
} as const;

export const ABILITY = {
  STURDY: 5, DAMP: 6, VOLT_ABSORB: 10, WATER_ABSORB: 11, CLOUD_NINE: 13, FLASH_FIRE: 18, INTIMIDATE: 22,
  WONDER_GUARD: 25, LEVITATE: 26, SWIFT_SWIM: 33, CHLOROPHYLL: 34, HUGE_POWER: 37, SOUNDPROOF: 43, THICK_FAT: 47,
  HUSTLE: 55, GUTS: 62, MARVEL_SCALE: 63, OVERGROW: 65, BLAZE: 66, TORRENT: 67, SWARM: 68, PURE_POWER: 74, AIR_LOCK: 77,
} as const;

export const HOLD = {
  MACHO_BRACE: 24, CHOICE_BAND: 29, BUG_POWER: 31, SOUL_DEW: 34, DEEP_SEA_TOOTH: 35, DEEP_SEA_SCALE: 36, STEEL_POWER: 42,
  LIGHT_BALL: 45, GROUND_POWER: 46, ROCK_POWER: 47, GRASS_POWER: 48, DARK_POWER: 49, FIGHTING_POWER: 50,
  ELECTRIC_POWER: 51, WATER_POWER: 52, FLYING_POWER: 53, POISON_POWER: 54, ICE_POWER: 55, GHOST_POWER: 56,
  PSYCHIC_POWER: 57, FIRE_POWER: 58, DRAGON_POWER: 59, NORMAL_POWER: 60, METAL_POWDER: 64, THICK_CLUB: 65,
} as const;

/** Type-boosting held items (sHoldEffectToType). */
const HOLD_TYPE = new Map<number, number>([
  [HOLD.BUG_POWER, TYPE.BUG], [HOLD.STEEL_POWER, TYPE.STEEL], [HOLD.GROUND_POWER, TYPE.GROUND], [HOLD.ROCK_POWER, TYPE.ROCK],
  [HOLD.GRASS_POWER, TYPE.GRASS], [HOLD.DARK_POWER, TYPE.DARK], [HOLD.FIGHTING_POWER, TYPE.FIGHTING],
  [HOLD.ELECTRIC_POWER, TYPE.ELECTRIC], [HOLD.WATER_POWER, TYPE.WATER], [HOLD.FLYING_POWER, TYPE.FLYING],
  [HOLD.POISON_POWER, TYPE.POISON], [HOLD.ICE_POWER, TYPE.ICE], [HOLD.GHOST_POWER, TYPE.GHOST],
  [HOLD.PSYCHIC_POWER, TYPE.PSYCHIC], [HOLD.FIRE_POWER, TYPE.FIRE], [HOLD.DRAGON_POWER, TYPE.DRAGON],
  [HOLD.NORMAL_POWER, TYPE.NORMAL],
]);

// Move effects (include/constants/battle_move_effects.h).
export const EFFECT = {
  EXPLOSION: 7, BIDE: 26, MULTI_HIT: 29, OHKO: 38, SUPER_FANG: 40, DRAGON_RAGE: 41, DOUBLE_HIT: 44, TWINEEDLE: 77,
  LEVEL_DAMAGE: 87, PSYWAVE: 88, COUNTER: 89, FLAIL: 99, TRIPLE_KICK: 104, RETURN: 121, PRESENT: 122, FRUSTRATION: 123,
  MAGNITUDE: 126, SONICBOOM: 130, HIDDEN_POWER: 135, MIRROR_COAT: 144, BEAT_UP: 154, SPIT_UP: 161, FACADE: 169,
  ENDEAVOR: 189, ERUPTION: 190, LOW_KICK: 196, WEATHER_BALL: 203,
} as const;

/** Damage that depends on the last hit taken, a random roll or stockpiles. */
const VARIES = new Set<number>([EFFECT.BIDE, EFFECT.COUNTER, EFFECT.MIRROR_COAT, EFFECT.MAGNITUDE, EFFECT.PRESENT, EFFECT.SPIT_UP, EFFECT.BEAT_UP]);

const MOVE_SOLAR_BEAM = 76;
const MOVE_STRUGGLE = 165;
/** Damaging sound moves, which Soundproof blocks (Snore, Uproar, Hyper Voice). */
const SOUND_MOVES = new Set([173, 253, 304]);

const SPECIES = { PIKACHU: 25, CUBONE: 104, MAROWAK: 105, DITTO: 132, CLAMPERL: 373, LATIAS: 407, LATIOS: 408 };

export const STATUS = { SLEEP: 7, POISON: 1 << 3, BURN: 1 << 4, FREEZE: 1 << 5, PARALYSIS: 1 << 6, TOXIC: 1 << 7 } as const;
const STATUS2_FORESIGHT = 1 << 29;
export const SIDE = { REFLECT: 1 << 0, LIGHT_SCREEN: 1 << 1 } as const;
export const WEATHER = { RAIN: 0x07, SANDSTORM: 0x18, SUN: 0x60, HAIL: 0x80 } as const;
const WEATHER_ANY = WEATHER.RAIN | WEATHER.SANDSTORM | WEATHER.SUN | WEATHER.HAIL;

/** Stat stage indexes in gBattleMons.statStages (stored there as 0…12, here as −6…+6). */
export const STAGE = { ATK: 1, DEF: 2, SPE: 3, SPA: 4, SPD: 5, ACC: 6, EVA: 7 } as const;
const STAGE_RATIOS = [[10, 40], [10, 35], [10, 30], [10, 25], [10, 20], [10, 15], [10, 10], [15, 10], [20, 10], [25, 10], [30, 10], [35, 10], [40, 10]];

const FLAIL_POWER: [number, number][] = [[1, 200], [4, 150], [9, 100], [16, 80], [32, 40], [48, 20]];
const LOW_KICK_POWER: [number, number][] = [[100, 20], [250, 40], [500, 60], [1000, 80], [2000, 100]];

/** A Pokémon in battle, as gBattleMons holds it. */
export interface Battler {
  species: number;
  level: number;
  hp: number;
  maxHp: number;
  types: [number, number];
  /** Unmodified stats; stages are applied in the formula. */
  atk: number;
  def: number;
  spe: number;
  spa: number;
  spd: number;
  /** Stat stages −6…+6, indexed as STAGE (index 0, HP, is unused). */
  stages: number[];
  ability: number;
  /** The held item's hold effect and its parameter (0 for none). */
  holdEffect: number;
  holdParam: number;
  /** status1 (sleep, poison, burn…) and status2 (Foresight…). */
  status: number;
  status2: number;
  /** Packed IVs (5 bits each: HP, Atk, Def, Spe, SpA, SpD), for Hidden Power. */
  ivs: number;
  friendship: number;
  /** Weight in hectograms, for Low Kick; 0 when unknown. */
  weight: number;
  /** On the player's side, where badge boosts apply. */
  player: boolean;
}

export interface Move3 {
  id: number;
  effect: number;
  power: number;
  type: number;
  accuracy: number;
}

/** gTypeEffectiveness rows [attacking type, defending type, multiplier × 10] in table order. */
export interface TypeTable {
  rows: [number, number, number][];
  /** Rows from here on (Normal and Fighting against Ghost) are skipped under Foresight. */
  foresight: number;
}

export interface BattleField {
  /** gBattleWeather. */
  weather: number;
  /** The player's badges (bit 0 is the first): the first, fifth and seventh boost stats. */
  badges: number;
  /** Link battles get no badge boosts. */
  link: boolean;
  /** gSideStatuses of the defender's side (Reflect, Light Screen). */
  defenderSide: number;
}

const has = (b: Battler, t: number) => b.types[0] === t || b.types[1] === t;
const stage = (v: number, s: number) => {
  const [n, d] = STAGE_RATIOS[Math.max(-6, Math.min(6, s)) + 6];
  return Math.floor((v * n) / d);
};

/** Hidden Power's type and power from a Pokémon's IVs. */
export function hiddenPower(ivs: number): { type: number; power: number } {
  let powerBits = 0;
  let typeBits = 0;
  for (let i = 0; i < 6; i++) {
    const iv = (ivs >>> (i * 5)) & 31;
    powerBits |= ((iv >> 1) & 1) << i;
    typeBits |= (iv & 1) << i;
  }
  let type = Math.floor((15 * typeBits) / 63) + 1;
  if (type >= TYPE.MYSTERY) type++;
  return { type, power: Math.floor((40 * powerBits) / 63) + 30 };
}

/** Cloud Nine and Air Lock cancel weather. */
function weatherOn(a: Battler, b: Battler): boolean {
  return ![a.ability, b.ability].some((x) => x === ABILITY.CLOUD_NINE || x === ABILITY.AIR_LOCK);
}

/** A move's type and power as the battle works them out, and any extra multiplier (Facade, Weather Ball). */
export function resolveMove(move: Move3, att: Battler, weather: number): { type: number; power: number; mult: number } | null {
  let { type, power } = move;
  let mult = 1;
  switch (move.effect) {
    case EFFECT.HIDDEN_POWER:
      ({ type, power } = hiddenPower(att.ivs));
      break;
    case EFFECT.RETURN:
      power = Math.floor((10 * att.friendship) / 25) || move.power;
      break;
    case EFFECT.FRUSTRATION:
      power = Math.floor((10 * (255 - att.friendship)) / 25) || move.power;
      break;
    case EFFECT.FLAIL: {
      let frac = Math.floor((att.hp * 48) / Math.max(1, att.maxHp));
      if (frac === 0 && att.hp > 0) frac = 1;
      power = (FLAIL_POWER.find(([f]) => frac <= f) ?? FLAIL_POWER[FLAIL_POWER.length - 1])[1];
      break;
    }
    case EFFECT.ERUPTION:
      power = Math.max(1, Math.floor((att.hp * move.power) / Math.max(1, att.maxHp)));
      break;
    case EFFECT.LOW_KICK:
      return null; // needs the target's weight; handled by the caller
    case EFFECT.FACADE:
      if (att.status & (STATUS.POISON | STATUS.BURN | STATUS.PARALYSIS | STATUS.TOXIC)) mult = 2;
      break;
    case EFFECT.WEATHER_BALL:
      if (weather & WEATHER_ANY) {
        mult = 2;
        type = weather & WEATHER.RAIN ? TYPE.WATER : weather & WEATHER.SANDSTORM ? TYPE.ROCK : weather & WEATHER.SUN ? TYPE.FIRE : TYPE.ICE;
      }
      break;
  }
  return { type, power, mult };
}

/** CalculateBaseDamage: the damage before the critical multiplier, STAB, type and the random roll (includes the +2). */
export function baseDamage(att: Battler, def: Battler, move: Move3, type: number, power: number, crit: boolean, field: BattleField): number {
  let a = att.atk;
  let d = def.def;
  let sa = att.spa;
  let sd = def.spd;
  const boost = (badge: number, b: Battler) => b.player && !field.link && !!(field.badges & (1 << badge));

  if (att.ability === ABILITY.HUGE_POWER || att.ability === ABILITY.PURE_POWER) a *= 2;
  if (boost(0, att)) a = Math.floor((110 * a) / 100);
  if (boost(4, def)) d = Math.floor((110 * d) / 100);
  if (boost(6, att)) sa = Math.floor((110 * sa) / 100);
  if (boost(6, def)) sd = Math.floor((110 * sd) / 100);

  if (HOLD_TYPE.get(att.holdEffect) === type) {
    if (type < TYPE.MYSTERY) a = Math.floor((a * (att.holdParam + 100)) / 100);
    else sa = Math.floor((sa * (att.holdParam + 100)) / 100);
  }
  if (att.holdEffect === HOLD.CHOICE_BAND) a = Math.floor((150 * a) / 100);
  const latis = (b: Battler) => b.species === SPECIES.LATIAS || b.species === SPECIES.LATIOS;
  if (att.holdEffect === HOLD.SOUL_DEW && latis(att)) sa = Math.floor((150 * sa) / 100);
  if (def.holdEffect === HOLD.SOUL_DEW && latis(def)) sd = Math.floor((150 * sd) / 100);
  if (att.holdEffect === HOLD.DEEP_SEA_TOOTH && att.species === SPECIES.CLAMPERL) sa *= 2;
  if (def.holdEffect === HOLD.DEEP_SEA_SCALE && def.species === SPECIES.CLAMPERL) sd *= 2;
  if (att.holdEffect === HOLD.LIGHT_BALL && att.species === SPECIES.PIKACHU) sa *= 2;
  if (def.holdEffect === HOLD.METAL_POWDER && def.species === SPECIES.DITTO) d *= 2;
  if (att.holdEffect === HOLD.THICK_CLUB && (att.species === SPECIES.CUBONE || att.species === SPECIES.MAROWAK)) a *= 2;

  if (def.ability === ABILITY.THICK_FAT && (type === TYPE.FIRE || type === TYPE.ICE)) sa = Math.floor(sa / 2);
  if (att.ability === ABILITY.HUSTLE) a = Math.floor((150 * a) / 100);
  if (att.ability === ABILITY.GUTS && att.status) a = Math.floor((150 * a) / 100);
  if (def.ability === ABILITY.MARVEL_SCALE && def.status) d = Math.floor((150 * d) / 100);
  const pinch = att.hp <= Math.floor(att.maxHp / 3);
  if (
    pinch &&
    ((type === TYPE.GRASS && att.ability === ABILITY.OVERGROW) ||
      (type === TYPE.FIRE && att.ability === ABILITY.BLAZE) ||
      (type === TYPE.WATER && att.ability === ABILITY.TORRENT) ||
      (type === TYPE.BUG && att.ability === ABILITY.SWARM))
  )
    power = Math.floor((150 * power) / 100);
  if (move.effect === EFFECT.EXPLOSION) d = Math.floor(d / 2);

  const levelTerm = Math.floor((2 * att.level) / 5) + 2;
  let dmg = 0;
  if (type < TYPE.MYSTERY) {
    const s = att.stages[STAGE.ATK];
    dmg = crit && s <= 0 ? a : stage(a, s);
    dmg = dmg * power * levelTerm;
    const t = def.stages[STAGE.DEF];
    const helper = crit && t >= 0 ? d : stage(d, t);
    dmg = Math.floor(Math.floor(dmg / Math.max(1, helper)) / 50);
    if (att.status & STATUS.BURN && att.ability !== ABILITY.GUTS) dmg = Math.floor(dmg / 2);
    if (field.defenderSide & SIDE.REFLECT && !crit) dmg = Math.floor(dmg / 2);
    if (dmg === 0) dmg = 1;
  } else if (type > TYPE.MYSTERY) {
    const s = att.stages[STAGE.SPA];
    dmg = crit && s <= 0 ? sa : stage(sa, s);
    dmg = dmg * power * levelTerm;
    const t = def.stages[STAGE.SPD];
    const helper = crit && t >= 0 ? sd : stage(sd, t);
    dmg = Math.floor(Math.floor(dmg / Math.max(1, helper)) / 50);
    if (field.defenderSide & SIDE.LIGHT_SCREEN && !crit) dmg = Math.floor(dmg / 2);
    if (weatherOn(att, def)) {
      const w = field.weather;
      if (w & WEATHER.RAIN) {
        if (type === TYPE.FIRE) dmg = Math.floor(dmg / 2);
        else if (type === TYPE.WATER) dmg = Math.floor((15 * dmg) / 10);
      }
      if (w & (WEATHER.RAIN | WEATHER.SANDSTORM | WEATHER.HAIL) && move.id === MOVE_SOLAR_BEAM) dmg = Math.floor(dmg / 2);
      if (w & WEATHER.SUN) {
        if (type === TYPE.FIRE) dmg = Math.floor((15 * dmg) / 10);
        else if (type === TYPE.WATER) dmg = Math.floor(dmg / 2);
      }
    }
  }
  return dmg + 2;
}

/** The type chart rows that apply to this attack, in the order typecalc applies them. */
function typeRows(chart: TypeTable, type: number, def: Battler): number[] {
  const out: number[] = [];
  const end = def.status2 & STATUS2_FORESIGHT ? chart.foresight : chart.rows.length;
  for (let i = 0; i < end; i++) {
    const [at, dt, m] = chart.rows[i];
    if (at !== type) continue;
    if (dt === def.types[0]) out.push(m);
    if (dt === def.types[1] && def.types[0] !== def.types[1]) out.push(m);
  }
  return out;
}

/** Overall type multiplier of an attack type against a defender (1 = neutral). */
export function typeMultiplier(chart: TypeTable, type: number, def: Battler): number {
  return typeRows(chart, type, def).reduce((p, m) => p * (m / 10), 1);
}

/** Why the move can't touch the defender (beyond the type chart), or null. */
function blockedBy(move: Move3, type: number, power: number, att: Battler, def: Battler, eff: number): string | null {
  const ab = def.ability;
  if (move.effect === EFFECT.EXPLOSION && (ab === ABILITY.DAMP || att.ability === ABILITY.DAMP)) return 'Damp stops it';
  if (ab === ABILITY.VOLT_ABSORB && type === TYPE.ELECTRIC && power) return 'Volt Absorb heals it instead';
  if (ab === ABILITY.WATER_ABSORB && type === TYPE.WATER && power) return 'Water Absorb heals it instead';
  if (ab === ABILITY.FLASH_FIRE && type === TYPE.FIRE && !(def.status & STATUS.FREEZE)) return 'Flash Fire absorbs it';
  if (ab === ABILITY.SOUNDPROOF && SOUND_MOVES.has(move.id)) return 'Soundproof blocks it';
  if (ab === ABILITY.LEVITATE && type === TYPE.GROUND) return 'Levitate dodges it';
  if (eff === 0) return null;
  if (ab === ABILITY.WONDER_GUARD && power && !(eff > 1)) return 'Wonder Guard blocks it';
  return null;
}

const fixed = (lo: number, hi: number, eff: number): DamageResult => ({ ...NO_DAMAGE, kind: 'fixed', min: lo, max: hi, critMin: lo, critMax: hi, effectiveness: eff });
const immune = (eff: number, reason?: string): DamageResult => ({ ...NO_DAMAGE, kind: 'immune', effectiveness: eff, reason });

/** Damage range of one move, per hit, with the defender's current HP for HP-based moves. */
export function calcDamage3(move: Move3, att: Battler, def: Battler, chart: TypeTable, field: BattleField): DamageResult {
  if (!move || move.id === 0) return NO_DAMAGE;
  const weather = weatherOn(att, def) ? field.weather : 0;
  if (VARIES.has(move.effect)) return { ...NO_DAMAGE, kind: 'varies' };
  let resolved = resolveMove(move, att, weather);
  if (!resolved) {
    // Low Kick: power from the target's weight.
    if (!def.weight) return { ...NO_DAMAGE, kind: 'varies' };
    const row = LOW_KICK_POWER.find(([w]) => w > def.weight);
    resolved = { type: move.type, power: row ? row[1] : 120, mult: 1 };
  }
  const { type, power, mult } = resolved;
  const struggle = move.id === MOVE_STRUGGLE;
  const eff = struggle ? 1 : typeMultiplier(chart, type, def);
  const blocked = struggle ? null : blockedBy(move, type, move.power, att, def, eff);
  if (blocked) return immune(eff, blocked);

  // Moves with set damage still check the type chart.
  const fixedDamage = (): [number, number] | 'fails' | null => {
    switch (move.effect) {
      case EFFECT.LEVEL_DAMAGE:
        return [att.level, att.level];
      case EFFECT.DRAGON_RAGE:
        return [40, 40];
      case EFFECT.SONICBOOM:
        return [20, 20];
      case EFFECT.PSYWAVE:
        return [Math.floor((att.level * 50) / 100), Math.floor((att.level * 150) / 100)];
      case EFFECT.SUPER_FANG: {
        const d = Math.max(1, Math.floor(def.hp / 2));
        return [d, d];
      }
      case EFFECT.ENDEAVOR:
        return def.hp > att.hp ? [def.hp - att.hp, def.hp - att.hp] : 'fails';
    }
    return null;
  };
  const f = fixedDamage();
  if (f === 'fails') return immune(eff, `Fails: ${att.hp >= def.hp ? 'its HP is not lower' : 'no effect'}`);
  if (f) return eff === 0 ? immune(0) : fixed(f[0], f[1], eff);

  if (move.effect === EFFECT.OHKO) {
    if (eff === 0) return immune(0);
    if (def.ability === ABILITY.STURDY) return immune(eff, 'Sturdy blocks one-hit KOs');
    if (att.level < def.level) return immune(eff, 'Fails against a higher level');
    return { ...NO_DAMAGE, kind: 'ohko', min: def.hp, max: def.hp, effectiveness: eff };
  }
  if (power === 0) return NO_DAMAGE;
  if (eff === 0) return immune(0);

  const hit = (crit: boolean, pow: number): [number, number] => {
    let dmg = baseDamage(att, def, move, type, pow, crit, field) * (crit ? 2 : 1) * mult;
    if (!struggle) {
      if (has(att, type)) dmg = Math.floor((dmg * 15) / 10);
      for (const m of typeRows(chart, type, def)) {
        dmg = Math.floor((dmg * m) / 10);
        if (dmg === 0 && m !== 0) dmg = 1;
      }
    }
    return [dmg === 0 ? 0 : Math.max(1, Math.floor((dmg * 85) / 100)), dmg];
  };

  if (move.effect === EFFECT.TRIPLE_KICK) {
    // Up to three kicks of 10, 20 and 30 power.
    const kicks = [10, 20, 30].map((p) => [hit(false, p), hit(true, p)]);
    const sum = (crit: number) => kicks.reduce((s, k) => s + k[crit][1], 0);
    return { kind: 'damage', min: kicks[0][0][0], max: sum(0), critMin: kicks[0][1][0], critMax: sum(1), hits: [1, 1], effectiveness: eff };
  }
  const [min, max] = hit(false, power);
  const [critMin, critMax] = hit(true, power);
  let hits: [number, number] = [1, 1];
  if (move.effect === EFFECT.MULTI_HIT) hits = [2, 5];
  else if (move.effect === EFFECT.DOUBLE_HIT || move.effect === EFFECT.TWINEEDLE) hits = [2, 2];
  return { kind: 'damage', min, max, critMin, critMax, hits, effectiveness: eff };
}

/** Speed as the battle compares it to decide who moves first (priority aside). */
export function battleSpeed(b: Battler, other: Battler, field: BattleField): number {
  const w = weatherOn(b, other) ? field.weather : 0;
  const m = (b.ability === ABILITY.SWIFT_SWIM && w & WEATHER.RAIN) || (b.ability === ABILITY.CHLOROPHYLL && w & WEATHER.SUN) ? 2 : 1;
  let s = stage(b.spe * m, b.stages[STAGE.SPE]);
  if (b.player && !field.link && field.badges & (1 << 2)) s = Math.floor((s * 110) / 100);
  if (b.holdEffect === HOLD.MACHO_BRACE) s = Math.floor(s / 2);
  if (b.status & STATUS.PARALYSIS) s = Math.floor(s / 4);
  return s;
}

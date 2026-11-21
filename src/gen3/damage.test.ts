import { describe, expect, it } from 'vitest';
import { threatOf } from '../run/damage.ts';
import { ABILITY, battleSpeed, calcDamage3, hiddenPower, SIDE, STAGE, STATUS, TYPE, WEATHER, type BattleField, type Battler, type Move3, type TypeTable } from './damage.ts';

// The rows of gTypeEffectiveness these tests touch, in table order.
const CHART: TypeTable = {
  rows: [
    [TYPE.FIRE, TYPE.GRASS, 20],
    [TYPE.WATER, TYPE.FIRE, 20],
    [TYPE.WATER, TYPE.GROUND, 20],
    [TYPE.GRASS, TYPE.WATER, 20],
    [TYPE.GRASS, TYPE.GROUND, 20],
    [TYPE.GRASS, TYPE.FIRE, 5],
    [TYPE.GRASS, TYPE.FLYING, 5],
    [TYPE.GROUND, TYPE.FLYING, 0],
    [TYPE.FIGHTING, TYPE.NORMAL, 20],
    [TYPE.NORMAL, TYPE.GHOST, 0],
    [TYPE.FIGHTING, TYPE.GHOST, 0],
  ],
  foresight: 9,
};

const move = (id: number, effect: number, power: number, type: number): Move3 => ({ id, effect, power, type, accuracy: 100 });
const TACKLE = move(33, 0, 35, TYPE.NORMAL);
const VINE_WHIP = move(22, 0, 35, TYPE.GRASS);
const EMBER = move(52, 4, 40, TYPE.FIRE);
const WATER_GUN = move(55, 0, 40, TYPE.WATER);
const EARTHQUAKE = move(89, 147, 100, TYPE.GROUND);
const HIDDEN_POWER = move(237, 135, 1, TYPE.NORMAL);
const SEISMIC_TOSS = move(69, 87, 1, TYPE.FIGHTING);
const DOUBLE_KICK = move(24, 44, 30, TYPE.FIGHTING);

const stages = (patch: Partial<Record<keyof typeof STAGE, number>> = {}) => {
  const s = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const [k, v] of Object.entries(patch)) s[STAGE[k as keyof typeof STAGE]] = v;
  return s;
};

// The FireRed test battle (a level 6 Bulbasaur against a wild Pidgey) with
// gBattleMons poked to these values; every range below matches the HP the
// game took off over several turns with different random rolls.
const me = (p: Partial<Battler> = {}): Battler => ({
  species: 1, level: 50, hp: 300, maxHp: 300, types: [TYPE.GRASS, TYPE.POISON], atk: 120, def: 11, spe: 11, spa: 100, spd: 14,
  stages: stages(), ability: 65, holdEffect: 0, holdParam: 0, status: 0, status2: 0, ivs: 0, friendship: 70, weight: 69, player: true, ...p,
});
const foe = (p: Partial<Battler> = {}): Battler => ({
  species: 16, level: 50, hp: 400, maxHp: 400, types: [TYPE.NORMAL, TYPE.FLYING], atk: 7, def: 80, spe: 8, spa: 7, spd: 70,
  stages: stages(), ability: 51, holdEffect: 0, holdParam: 0, status: 0, status2: 0, ivs: 0, friendship: 70, weight: 18, player: false, ...p,
});
const field = (p: Partial<BattleField> = {}): BattleField => ({ weather: 0, badges: 0, link: false, defenderSide: 0, ...p });
const range = (r: { min: number; max: number; critMin: number; critMax: number }) => [r.min, r.max, r.critMin, r.critMax];

describe('gen 3 damage, checked against FireRed', () => {
  it('physical base case and the foe hitting back', () => {
    expect(range(calcDamage3(TACKLE, me(), foe(), CHART, field()))).toEqual([21, 25, 42, 50]);
    // Pidgey's Tackle on Bulbasaur (its real Atk 7 against Def 11, at level 50).
    expect(range(calcDamage3(TACKLE, foe(), me(), CHART, field()))).toEqual([13, 16, 28, 33]);
  });

  it('Choice Band, Huge Power, Guts and burn', () => {
    expect(range(calcDamage3(TACKLE, me({ holdEffect: 29 }), foe(), CHART, field())).slice(0, 2)).toEqual([30, 36]);
    expect(range(calcDamage3(TACKLE, me({ ability: ABILITY.HUGE_POWER }), foe(), CHART, field())).slice(0, 2)).toEqual([40, 48]);
    expect(range(calcDamage3(TACKLE, me({ status: STATUS.BURN }), foe(), CHART, field()))).toEqual([11, 13, 22, 26]);
    expect(range(calcDamage3(TACKLE, me({ status: STATUS.BURN, ability: ABILITY.GUTS }), foe(), CHART, field())).slice(0, 2)).toEqual([30, 36]);
  });

  it('stat stages (Intimidate), which critical hits ignore when they hurt the attacker', () => {
    expect(range(calcDamage3(TACKLE, me({ stages: stages({ ATK: -1 }) }), foe(), CHART, field()))).toEqual([14, 17, 42, 50]);
    expect(range(calcDamage3(EMBER, me({ stages: stages({ SPA: 2 }) }), foe(), CHART, field({ weather: WEATHER.SUN }))).slice(0, 2)).toEqual([65, 77]);
  });

  it('STAB, double weaknesses and resistances, type items', () => {
    expect(range(calcDamage3(VINE_WHIP, me(), foe({ types: [TYPE.WATER, TYPE.GROUND] }), CHART, field()))).toEqual([122, 144, 244, 288]);
    const r = calcDamage3(VINE_WHIP, me({ holdEffect: 48, holdParam: 10 }), foe({ types: [TYPE.FIRE, TYPE.FLYING] }), CHART, field());
    expect(range(r)).toEqual([7, 9, 16, 19]);
    expect(r.effectiveness).toBe(0.25);
  });

  it('Thick Fat, weather, Reflect and Light Screen', () => {
    expect(range(calcDamage3(EMBER, me(), foe({ ability: ABILITY.THICK_FAT }), CHART, field())).slice(0, 2)).toEqual([11, 14]);
    expect(range(calcDamage3(WATER_GUN, me(), foe(), CHART, field({ weather: WEATHER.RAIN }))).slice(0, 2)).toEqual([33, 39]);
    expect(range(calcDamage3(TACKLE, me(), foe(), CHART, field({ defenderSide: SIDE.REFLECT })))).toEqual([11, 13, 42, 50]);
    expect(range(calcDamage3(WATER_GUN, me({ holdEffect: 52, holdParam: 10 }), foe(), CHART, field({ defenderSide: SIDE.LIGHT_SCREEN })))).toEqual([12, 15, 49, 58]);
  });

  it('Hidden Power, set damage and immunities', () => {
    expect(hiddenPower(0x3fffffff)).toEqual({ type: TYPE.DARK, power: 70 });
    expect(hiddenPower(0)).toEqual({ type: TYPE.FIGHTING, power: 30 });
    expect(range(calcDamage3(HIDDEN_POWER, me({ ivs: 0x3fffffff }), foe(), CHART, field())).slice(0, 2)).toEqual([39, 46]);
    expect(calcDamage3(SEISMIC_TOSS, me(), foe(), CHART, field())).toMatchObject({ kind: 'fixed', min: 50, max: 50 });
    expect(calcDamage3(EARTHQUAKE, me(), foe({ types: [TYPE.ROCK, TYPE.ROCK], ability: ABILITY.LEVITATE }), CHART, field())).toMatchObject({ kind: 'immune', reason: 'Levitate dodges it' });
    expect(calcDamage3(DOUBLE_KICK, me(), foe({ types: [TYPE.GHOST, TYPE.GHOST] }), CHART, field())).toMatchObject({ kind: 'immune', effectiveness: 0 });
    // Foresight lets Fighting moves hit Ghosts.
    expect(calcDamage3(DOUBLE_KICK, me(), foe({ types: [TYPE.GHOST, TYPE.GHOST], status2: 1 << 29 }), CHART, field())).toMatchObject({ kind: 'damage', hits: [2, 2] });
  });
});

describe('gen 3 damage, from the formula', () => {
  it('applies badge boosts on the player side only', () => {
    const plain = calcDamage3(TACKLE, me(), foe(), CHART, field());
    const boosted = calcDamage3(TACKLE, me(), foe(), CHART, field({ badges: 1 }));
    expect(boosted.max).toBeGreaterThan(plain.max);
    expect(calcDamage3(TACKLE, me(), foe(), CHART, field({ badges: 1, link: true })).max).toBe(plain.max);
    expect(calcDamage3(TACKLE, foe(), me(), CHART, field({ badges: 1 })).max).toBe(calcDamage3(TACKLE, foe(), me(), CHART, field()).max);
  });

  it('pinch abilities, Wonder Guard, Sturdy and the OHKO level check', () => {
    const full = calcDamage3(VINE_WHIP, me({ ability: ABILITY.OVERGROW }), foe(), CHART, field());
    const pinch = calcDamage3(VINE_WHIP, me({ ability: ABILITY.OVERGROW, hp: 100 }), foe(), CHART, field());
    expect(pinch.max).toBeGreaterThan(full.max);
    expect(calcDamage3(TACKLE, me(), foe({ ability: ABILITY.WONDER_GUARD }), CHART, field())).toMatchObject({ kind: 'immune', reason: 'Wonder Guard blocks it' });
    expect(calcDamage3(VINE_WHIP, me(), foe({ types: [TYPE.WATER, TYPE.WATER], ability: ABILITY.WONDER_GUARD }), CHART, field()).kind).toBe('damage');
    const fissure = move(90, 38, 1, TYPE.GROUND);
    expect(calcDamage3(fissure, me(), foe({ types: [TYPE.ROCK, TYPE.ROCK] }), CHART, field()).kind).toBe('ohko');
    expect(calcDamage3(fissure, me(), foe({ types: [TYPE.ROCK, TYPE.ROCK], level: 51 }), CHART, field()).kind).toBe('immune');
    expect(calcDamage3(fissure, me(), foe({ types: [TYPE.ROCK, TYPE.ROCK], ability: ABILITY.STURDY }), CHART, field()).reason).toMatch(/Sturdy/);
  });

  it('power from HP, friendship and weight', () => {
    const flail = move(175, 99, 1, TYPE.NORMAL);
    expect(calcDamage3(flail, me({ hp: 1 }), foe(), CHART, field()).max).toBeGreaterThan(calcDamage3(flail, me(), foe(), CHART, field()).max);
    const ret = move(216, 121, 1, TYPE.NORMAL);
    expect(calcDamage3(ret, me({ friendship: 255 }), foe(), CHART, field()).max).toBe(calcDamage3(move(1, 0, 102, TYPE.NORMAL), me(), foe(), CHART, field()).max);
    const lowKick = move(67, 196, 1, TYPE.FIGHTING);
    // Pidgey weighs 1.8 kg: 20 power, doubled by the Fighting-on-Normal weakness.
    expect(calcDamage3(lowKick, me(), foe({ types: [TYPE.NORMAL, TYPE.NORMAL] }), CHART, field()).max).toBe(
      calcDamage3(move(2, 0, 20, TYPE.FIGHTING), me(), foe({ types: [TYPE.NORMAL, TYPE.NORMAL] }), CHART, field()).max,
    );
    expect(calcDamage3(lowKick, me(), foe({ weight: 0 }), CHART, field()).kind).toBe('varies');
  });

  it('speed order and threats', () => {
    expect(battleSpeed(me(), foe(), field())).toBe(11);
    expect(battleSpeed(me({ status: STATUS.PARALYSIS }), foe(), field())).toBe(2);
    expect(battleSpeed(me({ stages: stages({ SPE: 2 }) }), foe(), field({ badges: 4 }))).toBe(24);
    const r = calcDamage3(VINE_WHIP, me(), foe({ types: [TYPE.WATER, TYPE.GROUND] }), CHART, field());
    expect(threatOf(r, 100)).toBe('ko');
    expect(threatOf(r, 200)).toBe('crit-ko');
  });
});

import { describe, expect, it } from 'vitest';
import { baseDamage, calcDamage, threatOf, type Combatant } from './damage.ts';
import type { Move } from './rom.ts';

const NORMAL = 0x00;
const ROCK = 0x05;
const GROUND = 0x04;
const GHOST = 0x08;
const FIRE = 0x14;
const WATER = 0x15;
const GRASS = 0x16;

// Minimal chart: water > fire, fire > grass, normal x0 ghost, grass < fire.
const CHART: Record<string, number> = { [`${WATER}-${FIRE}`]: 2, [`${FIRE}-${GRASS}`]: 2, [`${NORMAL}-${GHOST}`]: 0, [`${GRASS}-${FIRE}`]: 0.5, [`${WATER}-${ROCK}`]: 2, [`${WATER}-${GROUND}`]: 2 };
const chart = (atk: number, def: [number, number]) => {
  let m = CHART[`${atk}-${def[0]}`] ?? 1;
  if (def[1] !== def[0]) m *= CHART[`${atk}-${def[1]}`] ?? 1;
  return m;
};

const move = (p: Partial<Move>): Move => ({ id: 1, name: 'Test', effect: 0, power: 40, type: NORMAL, accuracy: 100, pp: 35, ...p });
const mon = (p: Partial<Combatant>): Combatant => ({ level: 50, hp: 150, maxHp: 150, atk: 100, def: 100, spd: 100, spc: 100, types: [NORMAL, NORMAL], ...p });

describe('gen 1 damage', () => {
  it('matches the base formula', () => {
    // L50: floor(100/5)+2 = 22; 22*100*100/100 = 2200; /50 = 44; +2 = 46
    expect(baseDamage(50, 100, 100, 100)).toBe(46);
    // Stats over 255 are quartered together.
    expect(baseDamage(50, 400, 300, 100)).toBe(baseDamage(50, 100, 75, 100));
    // Cap at 997 + 2.
    expect(baseDamage(100, 255, 1, 250)).toBe(999);
  });

  it('applies STAB, type effectiveness and the random roll', () => {
    const r = calcDamage(move({ power: 100, type: WATER }), mon({ types: [WATER, WATER] }), mon({ types: [FIRE, FIRE] }), chart);
    // 46 -> STAB 69 -> x2 138; roll 217/255 -> 117
    expect(r.max).toBe(138);
    expect(r.min).toBe(117);
    expect(r.effectiveness).toBe(2);
    expect(r.critMax).toBeGreaterThan(r.max);
  });

  it('handles dual-type 4x and immunities', () => {
    const r = calcDamage(move({ power: 100, type: WATER }), mon({}), mon({ types: [ROCK, GROUND] }), chart);
    expect(r.effectiveness).toBe(4);
    expect(r.max).toBe(46 * 4);
    const g = calcDamage(move({ power: 100 }), mon({}), mon({ types: [GHOST, GHOST] }), chart);
    expect(g.kind).toBe('immune');
  });

  it('handles fixed-damage and multi-hit moves', () => {
    const st = calcDamage(move({ id: 0x45, effect: 0x29, power: 1, type: 0x01 }), mon({ level: 37 }), mon({ types: [GHOST, GHOST] }), chart);
    expect([st.kind, st.min, st.max]).toEqual(['fixed', 37, 37]);
    const dr = calcDamage(move({ id: 0x52, effect: 0x29, power: 1, type: 0x1a }), mon({}), mon({}), chart);
    expect(dr.max).toBe(40);
    const fang = calcDamage(move({ id: 0xa2, effect: 0x28, power: 1 }), mon({}), mon({ hp: 81 }), chart);
    expect(fang.max).toBe(40);
    const multi = calcDamage(move({ effect: 0x1d, power: 15 }), mon({}), mon({}), chart);
    expect(multi.hits).toEqual([2, 5]);
  });

  it('rates threats against current HP', () => {
    const r = calcDamage(move({ power: 100, type: WATER }), mon({ types: [WATER, WATER] }), mon({ types: [FIRE, FIRE] }), chart);
    expect(threatOf(r, 100)).toBe('ko');
    expect(threatOf(r, r.max + 1)).toBe('crit-ko');
    expect(threatOf(r, 1000)).toBe('ok');
  });
});

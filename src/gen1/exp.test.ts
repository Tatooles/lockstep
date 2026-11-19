import { describe, expect, it } from 'vitest';
import { expForLevel, levelProgress } from './exp.ts';

describe('experience curves', () => {
  it('matches known Gen 1 totals', () => {
    expect(expForLevel(3, 5)).toBe(135); // starters begin here
    expect(expForLevel(3, 6)).toBe(179);
    expect(expForLevel(3, 100)).toBe(1059860);
    expect(expForLevel(0, 10)).toBe(1000);
    expect(expForLevel(0, 100)).toBe(1000000);
    expect(expForLevel(4, 100)).toBe(800000);
    expect(expForLevel(5, 100)).toBe(1250000);
  });

  it('never goes negative at level 1', () => {
    expect(expForLevel(3, 1)).toBe(0);
  });

  it('reports progress within a level', () => {
    expect(levelProgress(3, 5, 157)).toEqual({ into: 22, span: 44, toNext: 22 });
    expect(levelProgress(0, 100, 1000000)).toBeNull();
  });
});

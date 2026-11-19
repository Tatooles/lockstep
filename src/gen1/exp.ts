// Experience needed for a level, by growth rate (the game's CalcExperience).
// Each rate is (a/b)·n³ + c·n² + d·n − e, with a·n³/b rounded down as the game does.

const GROWTH_RATES: readonly (readonly [number, number, number, number, number])[] = [
  [1, 1, 0, 0, 0], // medium fast
  [3, 4, 10, 0, 30], // slightly fast (unused)
  [3, 4, 20, 0, 70], // slightly slow (unused)
  [6, 5, -15, 100, 140], // medium slow
  [4, 5, 0, 0, 0], // fast
  [5, 4, 0, 0, 0], // slow
];

export function expForLevel(growth: number, level: number): number {
  const [a, b, c, d, e] = GROWTH_RATES[growth] ?? GROWTH_RATES[0];
  const n = Math.max(1, Math.min(100, level));
  return Math.max(0, Math.floor((a * n ** 3) / b) + c * n * n + d * n - e);
}

/** Progress through the current level, or null at level 100. */
export function levelProgress(growth: number, level: number, exp: number): { into: number; span: number; toNext: number } | null {
  if (level >= 100) return null;
  const lo = expForLevel(growth, level);
  const hi = expForLevel(growth, level + 1);
  const span = Math.max(1, hi - lo);
  const into = Math.min(span, Math.max(0, exp - lo));
  return { into, span, toNext: Math.max(0, hi - exp) };
}

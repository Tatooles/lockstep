// Damage results shared by the Gen 1 and Gen 3 calculators, and the threat
// rating the battle tab shows for each move.

export interface DamageResult {
  /** 'varies' is a move whose damage depends on things the helper can't see (Counter, Magnitude, Present…). */
  kind: 'damage' | 'fixed' | 'ohko' | 'status' | 'immune' | 'varies';
  /** Per-hit damage range (lowest to highest random roll). */
  min: number;
  max: number;
  /** Per-hit range on a critical hit. */
  critMin: number;
  critMax: number;
  /** Number of hits [min, max]. */
  hits: [number, number];
  effectiveness: number;
  /** Why an 'immune' move fails, when it isn't the type chart (an ability, a level check…). */
  reason?: string;
}

export const NO_DAMAGE: DamageResult = { kind: 'status', min: 0, max: 0, critMin: 0, critMax: 0, hits: [1, 1], effectiveness: 1 };

export type Threat = 'ko' | 'crit-ko' | 'heavy' | 'ok';

/** How dangerous a hit is for a defender at its current HP. */
export function threatOf(r: DamageResult, defenderHp: number): Threat {
  if (r.kind === 'status' || r.kind === 'immune' || r.kind === 'varies') return 'ok';
  const maxTotal = r.max * r.hits[1];
  const critTotal = Math.max(r.critMax, r.max) * r.hits[1];
  if (r.kind === 'ohko') return 'ko';
  if (maxTotal >= defenderHp) return 'ko';
  if (critTotal >= defenderHp) return 'crit-ko';
  if (maxTotal * 2 >= defenderHp) return 'heavy';
  return 'ok';
}

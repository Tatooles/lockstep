// Level-cap milestones: gym leaders, the Elite Four and the champion.

export interface Milestone {
  id: string;
  name: string;
  /** Badge earned by beating them (null for the Elite Four and champion). */
  badgeBit: number | null;
  /** Highest level on their team. */
  ace: number;
  team: { level: number; species: number }[];
}

/** Next milestone given obtained badges (gyms in order, then the League). */
export function nextMilestone(milestones: Milestone[], badges: number): Milestone | null {
  for (const m of milestones) {
    if (m.badgeBit === null) return m; // all gyms done -> first Elite Four member
    if (!(badges & (1 << m.badgeBit))) return m;
  }
  return null;
}

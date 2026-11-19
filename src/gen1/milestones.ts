// Level-cap milestones (gym leaders, Elite Four, champion), read from the ROM's trainer data.

import type { Gen1Data } from './rom.ts';

export interface Milestone {
  id: string;
  name: string;
  badgeBit: number | null; // badge earned by beating them (null for E4/champ)
  ace: number; // highest level on their team
  team: { level: number; species: number }[];
}

const DEFS: { id: string; name: string; cls: number; party: number; badgeBit: number | null }[] = [
  { id: 'brock', name: 'Brock', cls: 0x22, party: 1, badgeBit: 0 },
  { id: 'misty', name: 'Misty', cls: 0x23, party: 1, badgeBit: 1 },
  { id: 'surge', name: 'Lt. Surge', cls: 0x24, party: 1, badgeBit: 2 },
  { id: 'erika', name: 'Erika', cls: 0x25, party: 1, badgeBit: 3 },
  { id: 'koga', name: 'Koga', cls: 0x26, party: 1, badgeBit: 4 },
  { id: 'sabrina', name: 'Sabrina', cls: 0x28, party: 1, badgeBit: 5 },
  { id: 'blaine', name: 'Blaine', cls: 0x27, party: 1, badgeBit: 6 },
  { id: 'giovanni', name: 'Giovanni', cls: 0x1d, party: 3, badgeBit: 7 },
  { id: 'lorelei', name: 'Lorelei', cls: 0x2c, party: 1, badgeBit: null },
  { id: 'bruno', name: 'Bruno', cls: 0x21, party: 1, badgeBit: null },
  { id: 'agatha', name: 'Agatha', cls: 0x2e, party: 1, badgeBit: null },
  { id: 'lance', name: 'Lance', cls: 0x2f, party: 1, badgeBit: null },
  { id: 'champion', name: 'Champion', cls: 0x2b, party: 1, badgeBit: null },
];

export function readMilestones(data: Gen1Data): Milestone[] {
  return DEFS.map((d) => {
    const parties = data.trainerParties(d.cls);
    const team = parties[d.party - 1]?.mons ?? [];
    return {
      id: d.id,
      name: d.name,
      badgeBit: d.badgeBit,
      team,
      ace: team.reduce((m, t) => Math.max(m, t.level), 0),
    };
  });
}

/** Next milestone given obtained badges (gyms in standard order, then the League). */
export function nextMilestone(milestones: Milestone[], badges: number): Milestone | null {
  for (const m of milestones) {
    if (m.badgeBit === null) return m; // all gyms done -> first E4 member
    if (!(badges & (1 << m.badgeBit))) return m;
  }
  return null;
}

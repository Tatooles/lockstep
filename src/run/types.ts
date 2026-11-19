export interface Rules {
  /** Skip first encounters whose evolution family you already own. */
  dupesClause: boolean;
  /** Gift Pokémon (Eevee, Lapras, fossils, …) use up the area's encounter. */
  giftsCount: boolean;
  /** Group multi-floor dungeons and town buildings into one area. */
  areaGrouping: 'area' | 'map';
  /** Warn when a party Pokémon is above the next milestone's ace level. */
  levelCaps: boolean;
  /** Disable save states for this run. */
  noSaveStates: boolean;
  /** Force the in-game battle style option to SET. */
  forceSetMode: boolean;
  /** Flag items (other than Poké Balls) used during battles. */
  noBattleItems: boolean;
  /** Wild battles only count as encounters once the player has had Poké Balls. */
  waitForBalls: boolean;
}

export const DEFAULT_RULES: Rules = {
  dupesClause: true,
  giftsCount: true,
  areaGrouping: 'area',
  levelCaps: true,
  noSaveStates: false,
  forceSetMode: false,
  noBattleItems: false,
  waitForBalls: true,
};

export type EncounterKind = 'wild' | 'gift' | 'starter' | 'trade';
export type EncounterOutcome = 'pending' | 'caught' | 'failed' | 'dupe' | 'skipped';

export interface Encounter {
  id: string;
  area: string;
  mapId: number;
  species: number;
  level: number;
  kind: EncounterKind;
  outcome: EncounterOutcome;
  monKey?: string;
  at: number;
  playSeconds: number;
  manual?: boolean;
}

export type MonOrigin = 'starter' | 'caught' | 'gift' | 'trade' | 'baseline';

export interface Death {
  at: number;
  playSeconds: number;
  level: number;
  mapId: number;
  area: string;
  cause: string;
}

export interface TrackedMon {
  key: string;
  nickname: string;
  species: number;
  originalSpecies: number;
  level: number;
  metLevel: number;
  area: string;
  mapId: number;
  metAt: number;
  origin: MonOrigin;
  status: 'alive' | 'dead';
  death?: Death;
  violation?: string;
  hp: number;
  maxHp: number;
  inParty: boolean;
}

export type TimelineKind =
  | 'start' | 'encounter' | 'catch' | 'miss' | 'dupe' | 'death' | 'badge' | 'violation' | 'whiteout' | 'note' | 'evolve';

export interface TimelineEntry {
  at: number;
  playSeconds: number;
  kind: TimelineKind;
  text: string;
  species?: number;
}

export interface Run {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  romKey: string;
  version: string;
  rules: Rules;
  status: 'active' | 'failed' | 'won';
  encounters: Encounter[];
  mons: Record<string, TrackedMon>;
  timeline: TimelineEntry[];
  /** Encounter id of the wild battle in progress, if any. */
  activeEncounterId: string | null;
  badges: number;
  trainerId: number | null;
  trainerName: string | null;
  /** Set once the player has held Poké Balls; encounters count from then on. */
  hadBalls?: boolean;
}

export interface Notice {
  tone: 'info' | 'good' | 'bad' | 'warn';
  title: string;
  body?: string;
  species?: number;
  /** Show at most once per session (for reminders that other UI already covers). */
  once?: boolean;
}

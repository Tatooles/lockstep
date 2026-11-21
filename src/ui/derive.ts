import type { Dex } from '../run/dex.ts';
import { ownedFamilies, usedAreas } from '../run/engine.ts';
import type { MonData, Snapshot } from '../run/events.ts';
import type { Encounter, Run } from '../run/types.ts';

export type RouteState = 'untracked' | 'none' | 'noballs' | 'open' | 'pending' | 'caught' | 'failed' | 'loading';

export interface RouteInfo {
  state: RouteState;
  area: string;
  mapName: string;
  encounter: Encounter | null;
}

export function routeInfo(data: Dex | null, run: Run | null, snap: Snapshot | null): RouteInfo {
  if (!snap || !data) return { state: 'loading', area: 'Starting up', mapName: '', encounter: null };
  const mapName = data.mapName(snap.mapId);
  if (!run) return { state: 'untracked', area: mapName, mapName, encounter: null };
  const area = data.areaOf(snap.mapId, run.rules);
  const enc = usedAreas(run).get(area) ?? null;
  if (enc) {
    const state = enc.outcome === 'pending' ? 'pending' : enc.outcome === 'caught' ? 'caught' : 'failed';
    return { state, area, mapName, encounter: enc };
  }
  // Areas with grouped maps: wild data may live on another floor.
  if (!data.areaHasWild(area, run.rules)) return { state: 'none', area, mapName, encounter: null };
  if (run.rules.waitForBalls && !run.hadBalls) return { state: 'noballs', area, mapName, encounter: null };
  return { state: 'open', area, mapName, encounter: null };
}

export function routeLine(info: RouteInfo, data: Dex | null): string {
  const n = (s: number) => data?.speciesName(s) ?? '?';
  switch (info.state) {
    case 'loading':
      return 'Waiting for the game to load a save';
    case 'untracked':
      return 'Not tracking. Tap to start a run';
    case 'none':
      return 'No wild Pokémon here';
    case 'noballs':
      return 'Encounters start once you have Poké Balls';
    case 'open':
      return 'First encounter available';
    case 'pending':
      return `Battling ${n(info.encounter!.species)}. Catch it!`;
    case 'caught':
      return `Caught ${n(info.encounter!.species)}`;
    case 'failed':
      return `Missed ${n(info.encounter!.species)}`;
  }
}

export function isDupe(run: Run | null, data: Dex | null, species: number): boolean {
  if (!run || !data || !run.rules.dupesClause) return false;
  const f = data.family(species);
  return f !== undefined && ownedFamilies(run, data).has(f);
}

/** Share of the way to the next level, 0–1 (1 at level 100), or null if the species is unknown. */
export function xpFraction(data: Dex, m: MonData): number | null {
  const xp = data.xpProgress(m.species, m.level, m.exp);
  if (xp === undefined) return null;
  return xp ? xp.into / xp.span : 1;
}

export function hpClass(hp: number, max: number): string {
  if (max === 0) return '';
  const f = hp / max;
  return f <= 0.2 ? 'low' : f <= 0.5 ? 'mid' : '';
}

export function fmtPlay(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${m.toString().padStart(2, '0')}`;
}

/** 'firered' → 'FireRed', 'red' → 'Red'. */
export function versionLabel(version: string): string {
  const special: Record<string, string> = { firered: 'FireRed', leafgreen: 'LeafGreen' };
  return special[version] ?? version[0].toUpperCase() + version.slice(1);
}

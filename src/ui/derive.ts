import { MAPS } from '../gen1/maps.ts';
import type { Gen1Data } from '../gen1/rom.ts';
import { areaOf, ownedFamilies, usedAreas } from '../run/engine.ts';
import type { Encounter, Run } from '../run/types.ts';
import type { MonData, Snapshot } from '../gen1/watcher.ts';
import { levelProgress } from '../gen1/exp.ts';

export type RouteState = 'untracked' | 'none' | 'noballs' | 'open' | 'pending' | 'caught' | 'failed' | 'loading';

export interface RouteInfo {
  state: RouteState;
  area: string;
  mapName: string;
  encounter: Encounter | null;
  hasWild: boolean;
}

export function routeInfo(data: Gen1Data | null, run: Run | null, snap: Snapshot | null): RouteInfo {
  if (!snap) return { state: 'loading', area: 'Starting up', mapName: '', encounter: null, hasWild: false };
  const map = MAPS[snap.mapId];
  const mapName = map?.name ?? `Map ${snap.mapId}`;
  const hasWild = !!data?.wild(snap.mapId);
  if (!run) return { state: 'untracked', area: mapName, mapName, encounter: null, hasWild };
  const area = areaOf(snap.mapId, run.rules);
  const enc = usedAreas(run).get(area) ?? null;
  if (enc) {
    const state = enc.outcome === 'pending' ? 'pending' : enc.outcome === 'caught' ? 'caught' : 'failed';
    return { state, area, mapName, encounter: enc, hasWild };
  }
  // Areas with grouped maps: wild data may live on another floor.
  const anyWild = hasWild || MAPS.some((m) => areaOf(m.id, run.rules) === area && !!data?.wild(m.id));
  if (!anyWild) return { state: 'none', area, mapName, encounter: null, hasWild };
  if (run.rules.waitForBalls && !run.hadBalls) return { state: 'noballs', area, mapName, encounter: null, hasWild };
  return { state: 'open', area, mapName, encounter: null, hasWild };
}

export function routeLine(info: RouteInfo, data: Gen1Data | null): string {
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

export function isDupe(run: Run | null, data: Gen1Data | null, species: number): boolean {
  if (!run || !data || !run.rules.dupesClause) return false;
  const sp = data.species.get(species);
  return !!sp && ownedFamilies(run, data).has(sp.family);
}

/** Share of the way to the next level, 0–1 (1 at level 100), or null if the species is unknown. */
export function xpFraction(data: Gen1Data, m: MonData): number | null {
  const growth = data.species.get(m.species)?.growth;
  if (growth === undefined) return null;
  const xp = levelProgress(growth, m.level, m.exp);
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

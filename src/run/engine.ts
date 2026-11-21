// Applies game events to a Nuzlocke run. Pure logic: no DOM, no storage.

import type { Dex } from './dex.ts';
import type { GameEvent, MonData, Snapshot } from './events.ts';
import { DEFAULT_RULES, type Encounter, type Notice, type Rules, type Run, type TrackedMon } from './types.ts';

export function newRun(opts: { name: string; romKey: string; version: string; rules?: Partial<Rules> }): Run {
  const now = Date.now();
  return {
    id: `run-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: opts.name,
    createdAt: now,
    updatedAt: now,
    romKey: opts.romKey,
    version: opts.version,
    rules: { ...DEFAULT_RULES, ...opts.rules },
    status: 'active',
    encounters: [],
    mons: {},
    timeline: [{ at: now, playSeconds: 0, kind: 'start', text: `Run “${opts.name}” started` }],
    activeEncounterId: null,
    badges: 0,
    trainerId: null,
    trainerName: null,
  };
}

/** Areas whose encounter has been used (pending, caught or failed). */
export function usedAreas(run: Run): Map<string, Encounter> {
  const m = new Map<string, Encounter>();
  for (const e of run.encounters) {
    if (e.kind === 'trade') continue;
    if (e.kind === 'gift' && !run.rules.giftsCount) continue;
    if (e.outcome === 'pending' || e.outcome === 'caught' || e.outcome === 'failed') {
      if (!m.has(e.area)) m.set(e.area, e);
    }
  }
  return m;
}

export function ownedFamilies(run: Run, data: Dex): Set<number> {
  const s = new Set<number>();
  for (const mon of Object.values(run.mons)) {
    const f = data.family(mon.originalSpecies) ?? data.family(mon.species);
    if (f !== undefined) s.add(f);
  }
  return s;
}

export interface EngineContext {
  data: Dex;
  snap: Snapshot;
  now?: number;
}

let idCounter = 0;
function eid(): string {
  return `e${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

function trackMon(run: Run, m: MonData, area: string, mapId: number, origin: TrackedMon['origin'], now: number): TrackedMon {
  const t: TrackedMon = {
    key: m.key,
    nickname: m.nickname,
    species: m.species,
    originalSpecies: m.species,
    level: m.level,
    metLevel: m.level,
    area,
    mapId,
    metAt: now,
    origin,
    status: 'alive',
    hp: m.hp,
    maxHp: m.maxHp,
    inParty: true,
  };
  run.mons[m.key] = t;
  return t;
}

/** Apply one event. Mutates `run`; returns notices for the UI. */
export function applyEvent(run: Run, ev: GameEvent, ctx: EngineContext): Notice[] {
  const { data, snap } = ctx;
  const now = ctx.now ?? Date.now();
  const notices: Notice[] = [];
  const name = (sp: number) => data.speciesName(sp);
  const tl = (kind: Run['timeline'][number]['kind'], text: string, species?: number) =>
    run.timeline.push({ at: now, playSeconds: snap.playSeconds, kind, text, species });
  run.updatedAt = now;

  switch (ev.type) {
    case 'loaded': {
      // A new game first shows the intro's placeholder trainer ("NINTEN"), so keep
      // taking the identity until the run has Pokémon.
      if (Object.keys(run.mons).length === 0 || run.trainerId === null) {
        run.trainerId = ev.snap.playerId;
        run.trainerName = ev.snap.playerName;
      }
      run.badges = ev.snap.badges;
      // A save that's already past the start (badges or several Pokémon) has had balls.
      if (data.hasPokeBalls(ev.snap.bag) || ev.snap.badges > 0 || ev.snap.party.length + ev.snap.box.length > 1) run.hadBalls = true;
      // Adopt anything already owned that we don't know about.
      for (const m of [...ev.snap.party, ...ev.snap.box]) {
        if (!run.mons[m.key]) trackMon(run, m, 'Before tracking', ev.snap.mapId, 'baseline', now);
      }
      break;
    }

    case 'battle-start': {
      if (ev.kind !== 'wild' || data.scriptedBattle(ev.battleType)) break;
      run.activeEncounterId = null;
      if (ev.enemy.ghost) {
        notices.push({ tone: 'info', title: 'Unidentified ghost', body: "Doesn't count as an encounter." });
        break;
      }
      if (!run.hadBalls && data.hasPokeBalls(snap.bag)) run.hadBalls = true;
      if (run.rules.waitForBalls && !run.hadBalls) {
        notices.push({ tone: 'info', title: 'No Poké Balls yet', body: "Doesn't count. Encounters start once you have Poké Balls.", once: true });
        break;
      }
      const area = data.areaOf(ev.mapId, run.rules);
      const used = usedAreas(run);
      if (used.has(area)) break;
      const family = data.family(ev.enemy.species);
      const enc: Encounter = {
        id: eid(),
        area,
        mapId: ev.mapId,
        species: ev.enemy.species,
        level: ev.enemy.level,
        kind: 'wild',
        outcome: 'pending',
        at: now,
        playSeconds: snap.playSeconds,
      };
      if (run.rules.dupesClause && family !== undefined && ownedFamilies(run, data).has(family)) {
        enc.outcome = 'dupe';
        run.encounters.push(enc);
        tl('dupe', `${area}: ${name(enc.species)} is a dupe — next encounter counts`, enc.species);
        notices.push({ tone: 'info', title: `Dupe: ${name(enc.species)}`, body: `${area} is still open.`, species: enc.species });
        break;
      }
      run.encounters.push(enc);
      run.activeEncounterId = enc.id;
      tl('encounter', `${area}: first encounter — ${name(enc.species)} Lv${enc.level}`, enc.species);
      notices.push({
        tone: 'good',
        title: `First encounter: ${name(enc.species)}`,
        body: `${area} · Lv${enc.level} — this is your one shot.`,
        species: enc.species,
      });
      break;
    }

    case 'ghost-revealed': {
      const i = run.encounters.findIndex((e) => e.id === run.activeEncounterId && e.outcome === 'pending');
      if (i >= 0) {
        const [enc] = run.encounters.splice(i, 1);
        const t = run.timeline.findLastIndex((x) => x.kind === 'encounter' && x.text.startsWith(enc.area));
        if (t >= 0) run.timeline.splice(t, 1);
        run.activeEncounterId = null;
        notices.push({ tone: 'info', title: 'Unidentified ghost', body: `Doesn't count. ${enc.area} is still open.` });
      }
      break;
    }

    case 'battle-end': {
      if (ev.kind !== 'wild') break;
      const enc = run.encounters.find((e) => e.id === run.activeEncounterId);
      if (enc && enc.outcome === 'pending') {
        enc.outcome = 'failed';
        tl('miss', `${enc.area}: ${name(enc.species)} got away`, enc.species);
        notices.push({ tone: 'bad', title: `${name(enc.species)} got away`, body: `${enc.area} is used up.`, species: enc.species });
      }
      run.activeEncounterId = null;
      break;
    }

    case 'acquired': {
      const m = ev.mon;
      if (run.mons[m.key]) break;
      const area = data.areaOf(ev.mapId, run.rules);
      if (ev.duringBattle) {
        // Caught in battle.
        const enc =
          run.encounters.find((e) => e.id === run.activeEncounterId) ??
          [...run.encounters].reverse().find((e) => e.kind === 'wild' && e.area === area && e.species === m.species && e.outcome === 'failed' && now - e.at < 120000);
        if (enc && enc.species === m.species && (enc.outcome === 'pending' || enc.outcome === 'failed')) {
          if (enc.outcome === 'failed') run.timeline.pop();
          enc.outcome = 'caught';
          enc.monKey = m.key;
          trackMon(run, m, enc.area, ev.mapId, 'caught', now);
          tl('catch', `${enc.area}: caught ${name(m.species)}${m.nickname && m.nickname !== name(m.species).toUpperCase() ? ` “${m.nickname}”` : ''}`, m.species);
          notices.push({ tone: 'good', title: `Caught ${name(m.species)}!`, body: `Welcome to the team, ${m.nickname || name(m.species)}.`, species: m.species });
        } else {
          const t = trackMon(run, m, area, ev.mapId, 'caught', now);
          t.violation = `Extra catch — ${area} was already used`;
          run.encounters.push({
            id: eid(), area, mapId: ev.mapId, species: m.species, level: m.level, kind: 'wild', outcome: 'caught',
            monKey: m.key, at: now, playSeconds: snap.playSeconds,
          });
          tl('violation', `${area}: caught ${name(m.species)} but the area was already used`, m.species);
          notices.push({ tone: 'warn', title: 'Rule check: extra catch', body: `${area} was already used.`, species: m.species });
        }
        run.activeEncounterId = null;
        break;
      }
      if (ev.foreign) {
        trackMon(run, m, area, ev.mapId, 'trade', now);
        run.encounters.push({
          id: eid(), area, mapId: ev.mapId, species: m.species, level: m.level, kind: 'trade', outcome: 'caught',
          monKey: m.key, at: now, playSeconds: snap.playSeconds,
        });
        tl('catch', `Traded for ${name(m.species)}`, m.species);
        notices.push({ tone: 'info', title: `Traded for ${name(m.species)}`, species: m.species });
        break;
      }
      const isStarter = data.isStarter(ev.mapId, run);
      if (isStarter) {
        trackMon(run, m, 'Starter', ev.mapId, 'starter', now);
        run.encounters.push({
          id: eid(), area: 'Starter', mapId: ev.mapId, species: m.species, level: m.level, kind: 'starter',
          outcome: 'caught', monKey: m.key, at: now, playSeconds: snap.playSeconds,
        });
        tl('catch', `Chose ${name(m.species)} as starter`, m.species);
        notices.push({ tone: 'good', title: `${name(m.species)}, I choose you!`, body: 'Your starter is on the board.', species: m.species });
        break;
      }
      // Gift / static gift Pokémon.
      const used = usedAreas(run);
      const t = trackMon(run, m, area, ev.mapId, 'gift', now);
      run.encounters.push({
        id: eid(), area, mapId: ev.mapId, species: m.species, level: m.level, kind: 'gift', outcome: 'caught',
        monKey: m.key, at: now, playSeconds: snap.playSeconds,
      });
      if (run.rules.giftsCount && used.has(area)) {
        t.violation = `Gift in ${area}, which was already used`;
        tl('violation', `Received ${name(m.species)} in ${area}, but the area was already used`, m.species);
        notices.push({ tone: 'warn', title: 'Rule check: gift', body: `${area} was already used.`, species: m.species });
      } else {
        tl('catch', `Received ${name(m.species)} (gift) in ${area}`, m.species);
        notices.push({ tone: 'good', title: `Received ${name(m.species)}`, body: run.rules.giftsCount ? `Counts as the ${area} encounter.` : 'Gifts are free this run.', species: m.species });
      }
      break;
    }

    case 'fainted': {
      const t = run.mons[ev.mon.key];
      if (!t || t.status === 'dead') break;
      t.status = 'dead';
      const area = data.areaOf(ev.mapId, run.rules);
      let cause = 'Fainted';
      if (ev.enemy) {
        const who = ev.enemy.trainerClass ? `${data.trainerClassName(ev.enemy.trainerClass) ?? 'Trainer'}'s ` : 'a wild ';
        cause = `${who}${name(ev.enemy.species)} (Lv${ev.enemy.level})`;
      } else if (!ev.inBattle) cause = 'Poison';
      t.death = { at: now, playSeconds: snap.playSeconds, level: ev.mon.level, mapId: ev.mapId, area, cause };
      const label = ev.mon.nickname || name(ev.mon.species);
      tl('death', `${label} (${name(ev.mon.species)} Lv${ev.mon.level}) fell to ${cause} in ${area}`, ev.mon.species);
      notices.push({ tone: 'bad', title: `${label} has fallen`, body: `Lv${ev.mon.level} · ${cause} · ${area}`, species: ev.mon.species });
      break;
    }

    case 'revived': {
      // Healing with a dead Pokémon still in the party is normal (a Pokémon Center
      // heals the whole team before you can reach the PC). Using it is what counts.
      break;
    }

    case 'sent-out': {
      const t = run.mons[ev.mon.key];
      if (t && t.status === 'dead' && !t.violation) {
        const label = ev.mon.nickname || name(ev.mon.species);
        t.violation = 'Used in battle after fainting';
        tl('violation', `${label} was sent into battle after fainting — dead Pokémon must stay boxed`, ev.mon.species);
        notices.push({ tone: 'warn', title: 'Rule check: dead Pokémon used', body: `${label} fainted earlier and should be boxed.`, species: ev.mon.species });
      }
      break;
    }

    case 'whiteout': {
      if (run.status === 'active') {
        run.status = 'failed';
        tl('whiteout', `Blacked out in ${data.areaOf(ev.mapId, run.rules)} — the run is over`);
        notices.push({ tone: 'bad', title: 'Wipe!', body: 'Every party Pokémon has fainted. The run is over (you can keep playing).' });
      }
      break;
    }

    case 'items-used': {
      if (!run.rules.noBattleItems) break;
      const list = ev.items.map((i) => `${data.itemName(i.id) ?? 'item'}${i.count > 1 ? ` ×${i.count}` : ''}`).join(', ');
      tl('violation', `Used ${list} in a ${ev.kind} battle`);
      notices.push({ tone: 'warn', title: 'Rule check: battle items', body: `Used ${list}.` });
      break;
    }

    case 'badge': {
      run.badges |= 1 << ev.index;
      const badge = data.badgeName(ev.index);
      tl('badge', `Earned the ${badge} Badge`);
      notices.push({ tone: 'good', title: `${badge} Badge!` });
      break;
    }

    default:
      break;
  }
  return notices;
}

/** Keep tracked mons in sync with the live party/box (levels, evolutions, nicknames). */
export function syncMons(run: Run, snap: Snapshot, data: Dex): void {
  if (!snap.valid) return;
  if (!run.hadBalls && data.hasPokeBalls(snap.bag)) {
    run.hadBalls = true;
    if (run.rules.waitForBalls) {
      run.timeline.push({ at: Date.now(), playSeconds: snap.playSeconds, kind: 'note', text: 'Got Poké Balls. Encounters count from here on' });
    }
  }
  const inParty = new Set(snap.party.map((m) => m.key));
  for (const m of [...snap.party, ...snap.box]) {
    const t = run.mons[m.key];
    if (!t) continue;
    if (t.species !== m.species && t.status === 'alive') {
      run.timeline.push({ at: Date.now(), playSeconds: snap.playSeconds, kind: 'evolve', text: `${t.nickname} evolved`, species: m.species });
    }
    t.species = m.species;
    t.nickname = m.nickname;
    t.level = m.level;
    if (inParty.has(m.key)) {
      t.hp = m.hp;
      t.maxHp = m.maxHp;
    }
  }
  for (const t of Object.values(run.mons)) t.inParty = inParty.has(t.key);
}

/** Live rule warnings derived from the current state. */
export function liveWarnings(run: Run, snap: Snapshot, cap: number | null): string[] {
  const w: string[] = [];
  if (!snap.valid) return w;
  for (const m of snap.party) {
    const t = run.mons[m.key];
    if (t?.status === 'dead') w.push(`${m.nickname} is dead but still in your party — box it.`);
  }
  if (run.rules.levelCaps && cap) {
    const over = snap.party.filter((m) => m.level > cap && run.mons[m.key]?.status !== 'dead');
    if (over.length) w.push(`${over.map((m) => m.nickname).join(', ')} over the level cap (${cap}).`);
  }
  return w;
}

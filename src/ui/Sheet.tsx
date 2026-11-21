import { useEffect, useRef, useState } from 'react';
import { MAPS } from '../gen1/maps.ts';
import { Gen1Data } from '../gen1/rom.ts';
import { TYPE_COLORS, typeName } from '../gen1/types.ts';
import type { BattleMonData, EnemyData, MonData } from '../gen1/watcher.ts';
import { calcDamage, threatOf, type Combatant, type Threat } from '../gen1/damage.ts';
import { THUMB_H as GBA_THUMB_H, THUMB_W as GBA_THUMB_W, type GbaSession } from '../gba/session.ts';
import type { Dex } from '../run/dex.ts';
import { usedAreas } from '../run/engine.ts';
import type { Encounter, Run, TrackedMon } from '../run/types.ts';
import { PALETTES, paletteById } from '../platform/palettes.ts';
import type { Session, SessionView } from '../platform/session.ts';
import { db, type StateRecord } from '../platform/storage.ts';
import { fmtPlay, hpClass, isDupe, routeInfo, routeLine, versionLabel } from './derive.ts';
import { prefs } from './prefs.ts';
import { Sprite } from './Sprite.tsx';

export type TabId = 'battle' | 'route' | 'team' | 'log' | 'graves' | 'run';

/** A Game Boy or Game Boy Advance play session. */
export type PlaySession = Session | GbaSession;

interface Props {
  session: PlaySession;
  view: SessionView;
  tab: TabId;
  onTab: (t: TabId) => void;
  onClose: () => void;
  onStartRun: () => void;
  onExit: () => void;
  docked: boolean;
}

export function Sheet({ session, view, tab, onTab, onClose, onStartRun, onExit, docked }: Props) {
  const data: Dex | null = session.data;
  // The battle tab and wild tables are Gen 1 only for now.
  const gen1 = data instanceof Gen1Data ? data : null;
  const { run, snap } = view;
  const inBattle = !!snap?.inBattle && !!snap.enemy?.species;
  const dead = run ? Object.values(run.mons).filter((m) => m.status === 'dead') : [];
  const tabs: { id: TabId; label: string; count?: number; live?: boolean; hidden?: boolean }[] = [
    { id: 'battle', label: 'Battle', live: true, hidden: !inBattle || !gen1 },
    { id: 'route', label: 'Route', hidden: !data },
    { id: 'team', label: 'Team', hidden: !data },
    { id: 'log', label: 'Log', hidden: !run },
    { id: 'graves', label: 'Graves', count: dead.length || undefined, hidden: !run },
    { id: 'run', label: run ? 'Run' : 'Settings' },
  ];
  const visible = tabs.filter((t) => !t.hidden);
  const wanted = tab === 'battle' && !inBattle ? 'route' : tab;
  const active: TabId = visible.some((t) => t.id === wanted) ? wanted : visible[0].id;
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [active]);

  useEffect(() => {
    if (docked) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [docked, onClose]);

  return (
    <>
      {!docked && <div className="sheet-scrim" onClick={onClose} />}
      <section className="sheet" aria-label="Run panel">
        <button className="sheet-handle" onClick={onClose} aria-label="Close panel">
          <i />
        </button>
        <div className="tabs" role="tablist">
          {tabs
            .filter((t) => !t.hidden)
            .map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={active === t.id}
                className={`tab${t.live ? ' live' : ''}`}
                onClick={() => onTab(t.id)}
              >
                {t.label}
                {t.count !== undefined && <span className="count">{t.count}</span>}
              </button>
            ))}
        </div>
        <div className="sheet-body" ref={bodyRef}>
          {active === 'battle' && gen1 && <BattleTab data={gen1} view={view} />}
          {active === 'route' && data && <RouteTab data={data} view={view} session={session} onStartRun={onStartRun} />}
          {active === 'team' && data && <TeamTab data={data} view={view} />}
          {active === 'log' && run && <LogTab run={run} />}
          {active === 'graves' && run && <GravesTab data={data} dead={dead} session={session} />}
          {active === 'run' && <RunTab session={session} view={view} onStartRun={onStartRun} onExit={onExit} />}
        </div>
      </section>
    </>
  );
}

function Types({ types, data }: { types: [number, number]; data?: Dex }) {
  const list = types[0] === types[1] ? [types[0]] : types;
  return (
    <span className="types">
      {list.map((t) => (
        <span key={t} className="type" style={{ background: (data ? data.typeColor(t) : TYPE_COLORS[t]) ?? '#888' }}>
          {data ? data.typeName(t) : typeName(t)}
        </span>
      ))}
    </span>
  );
}

function effLabel(m: number): { cls: string; txt: string } | null {
  if (m === 0) return { cls: 'x0', txt: 'no effect' };
  if (m < 1) return { cls: 'lo', txt: `×${m}` };
  if (m > 1) return { cls: 'hi', txt: `×${m}` };
  return null;
}

// ---------------- Battle ----------------
function BattleTab({ data, view }: { data: Gen1Data; view: SessionView }) {
  const { snap, run } = view;
  const enemy = snap?.enemy;
  if (!snap || !enemy) return <p className="empty-state">No battle right now.</p>;
  const sp = data.species.get(enemy.species);
  const types = enemy.types;
  const trainerTeam =
    enemy.trainerClass && enemy.trainerNo ? data.trainerParties(enemy.trainerClass)[enemy.trainerNo - 1]?.mons ?? [] : [];
  const area = run ? data.areaOf(snap.mapId, run.rules) : MAPS[snap.mapId]?.name;
  const enc = run && enemy.trainerClass === 0 ? usedAreas(run).get(area ?? '') : undefined;
  const counts = enemy.trainerClass === 0 && run?.activeEncounterId && enc?.id === run.activeEncounterId;

  return (
    <div>
      <div className="battle-head">
        <Sprite data={data} species={enemy.ghost ? 0 : enemy.species} />
        <div>
          <h2>
            {enemy.ghost ? 'Ghost' : data.speciesName(enemy.species)} <span style={{ fontWeight: 500 }}>Lv{enemy.level}</span>
          </h2>
          {!enemy.ghost && <Types types={types} />}
          <p className="sub" style={{ marginTop: 6 }}>
            {enemy.trainerClass
              ? `${data.trainerClasses[enemy.trainerClass]}'s Pokémon`
              : counts
                ? `This is your ${area} encounter. Don't knock it out.`
                : enemy.ghost
                  ? "Unidentified ghost. It can't be caught and doesn't count."
                  : `Wild. ${area} is already used${isDupe(run, data, enemy.species) ? ', and this is a dupe' : ''}.`}
          </p>
          {enemy.maxHp > 0 && (
            <div className={`hp ${hpClass(enemy.hp, enemy.maxHp)}`} style={{ width: '100%', height: 6 }}>
              <i style={{ width: `${(100 * enemy.hp) / enemy.maxHp}%` }} />
            </div>
          )}
        </div>
      </div>

      {sp && !enemy.ghost && (
        <div className="stats" aria-label="Base stats">
          {(['hp', 'atk', 'def', 'spd', 'spc'] as const).map((k) => (
            <div key={k}>
              <b>{sp.base[k]}</b>
              {k === 'hp' ? 'HP' : k === 'atk' ? 'Atk' : k === 'def' ? 'Def' : k === 'spd' ? 'Spe' : 'Spc'}
            </div>
          ))}
        </div>
      )}

      {trainerTeam.length > 0 && (
        <>
          <h3>Their team</h3>
          <div className="enemy-team">
            {trainerTeam.map((m, i) => (
              <div className="row" key={i}>
                <Sprite data={data} species={m.species} />
                <span className="s">
                  {data.speciesName(m.species)} {m.level}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {!enemy.ghost && (
        <>
          {snap.battleMon && snap.battleMon.species > 0 && (
            <DangerCheck
              data={data}
              me={snap.battleMon}
              foe={{ ...enemy, hp: enemy.hp, maxHp: enemy.maxHp }}
              myName={snap.party[snap.activeSlot]?.nickname ?? data.speciesName(snap.battleMon.species)}
            />
          )}
          {snap.party.some((m, i) => i !== snap.activeSlot && m.hp > 0) && <h3>If you switch</h3>}
          <div className="matchups">
            {snap.party.filter((m, i) => i !== snap.activeSlot && m.hp > 0).map((m) => (
              <div key={m.key} className="matchup">
                <Sprite data={data} species={m.species} />
                <div>
                  <div className="s" style={{ fontWeight: 700, fontSize: 13.5 }}>
                    {m.nickname} {m.hp === 0 && <span className="outcome dead">fainted</span>}
                  </div>
                  <div className="mv">
                    {m.moves
                      .filter((x) => x > 0)
                      .map((id, i) => {
                        const mv = data.moves[id];
                        const mult = mv && mv.power > 0 ? data.effectiveness(mv.type, types) : 1;
                        const e = mv && mv.power > 0 ? effLabel(mult) : null;
                        return (
                          <span key={i}>
                            {mv?.name}
                            {e && <span className={`eff ${e.cls}`}>{e.txt}</span>}
                          </span>
                        );
                      })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const THREAT_LABEL: Record<Threat, string> = { ko: 'Can KO', 'crit-ko': 'KO on crit', heavy: 'Heavy', ok: 'Safe' };

function toCombatant(x: { level: number; hp: number; maxHp: number; types: [number, number]; stats: { atk: number; def: number; spd: number; spc: number } }): Combatant {
  return { level: x.level, hp: x.hp, maxHp: x.maxHp, types: x.types, ...x.stats };
}

function DamageRows({ data, moves, att, def, defName }: { data: Gen1Data; moves: number[]; att: Combatant; def: Combatant; defName: string }) {
  const chart = (a: number, d: [number, number]) => data.effectiveness(a, d);
  const rows = moves
    .filter((id) => id > 0)
    .map((id) => {
      const mv = data.moves[id];
      return { mv, r: calcDamage(mv, att, def, chart) };
    });
  return (
    <ul className="rows dmg">
      {rows.map(({ mv, r }, i) => {
        const threat = threatOf(r, def.hp);
        const pct = (n: number) => (def.maxHp ? Math.round((100 * n) / def.maxHp) : 0);
        let detail: string;
        if (r.kind === 'status') detail = 'No damage';
        else if (r.kind === 'immune') detail = r.effectiveness === 0 ? `${defName} is immune` : 'Fails (too slow)';
        else if (r.kind === 'ohko') detail = 'One-hit KO if it lands';
        else {
          const hits = r.hits[1] > 1 ? ` ×${r.hits[0] === r.hits[1] ? r.hits[0] : `${r.hits[0]}–${r.hits[1]}`}` : '';
          detail = `${r.min}–${r.max}${hits} HP (${pct(r.min)}–${pct(r.max)}%)`;
          if (r.kind === 'damage') detail += `, crit ${r.critMax}`;
        }
        const e = r.kind === 'damage' ? effLabel(r.effectiveness) : null;
        return (
          <li key={i} className="dmg-row" style={{ borderLeftColor: TYPE_COLORS[mv?.type] ?? undefined }}>
            <div>
              <div className="t">
                {mv?.name} {e && <span className={`eff ${e.cls}`}>{e.txt}</span>}
              </div>
              <div className="s">{detail}</div>
            </div>
            <span className={`threat ${threat}`}>{THREAT_LABEL[threat]}</span>
          </li>
        );
      })}
    </ul>
  );
}

function DangerCheck({ data, me, foe, myName }: { data: Gen1Data; me: BattleMonData; foe: EnemyData; myName: string }) {
  const mine = toCombatant(me);
  const theirs = toCombatant(foe);
  const foeName = data.speciesName(foe.species);
  const known = foe.moves.filter((m) => m > 0);
  return (
    <>
      {known.length > 0 && (
        <>
          <h3>
            Its moves against {myName} ({me.hp}/{me.maxHp} HP)
          </h3>
          <DamageRows data={data} moves={known} att={theirs} def={mine} defName={myName} />
        </>
      )}
      <h3>
        {myName}'s moves against {foeName}
      </h3>
      <DamageRows data={data} moves={me.moves} att={mine} def={theirs} defName={foeName} />
      <p className="sub" style={{ marginTop: 8 }}>
        Ranges use current in-battle stats; Reflect and Light Screen aren't counted. {mine.spd > theirs.spd ? `${myName} moves first.` : mine.spd < theirs.spd ? `${foeName} moves first.` : 'Speed tie.'}
      </p>
    </>
  );
}

// ---------------- Route ----------------
function RouteTab({ data, view, session, onStartRun }: { data: Dex; view: SessionView; session: PlaySession; onStartRun: () => void }) {
  const { run, snap } = view;
  const info = routeInfo(data, run, snap);
  if (!snap) return <p className="empty-state">Load your save in the game and the route info will appear here.</p>;
  const gen1 = data instanceof Gen1Data ? data : null;
  const mapIds = !gen1 ? [] : run ? MAPS.filter((m) => gen1.areaOf(m.id, run.rules) === info.area).map((m) => m.id) : [snap.mapId];
  // Current map first.
  mapIds.sort((a, b) => (a === snap.mapId ? -1 : b === snap.mapId ? 1 : a - b));
  const tables = gen1 ? mapIds.map((id) => ({ id, t: gen1.wild(id) })).filter((x) => x.t) : [];

  return (
    <div>
      <h2>{info.area}</h2>
      {info.mapName !== info.area && <p className="sub">{info.mapName}</p>}
      {!run ? (
        <div className="status-card">
          <div className="glyph">+</div>
          <div>
            <div className="big">You're not tracking a run</div>
            <div className="small">Start one and every first encounter, catch and loss is logged as you play.</div>
            <div className="btn-row">
              <button className="btn primary" onClick={onStartRun}>
                Start a Nuzlocke run
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className={`status-card ${info.state === 'pending' ? 'open' : info.state}`}>
          {info.encounter ? <Sprite data={data} species={info.encounter.species} /> : <div className="glyph">{info.state === 'open' ? '?' : '·'}</div>}
          <div>
            <div className="big">{routeLine(info, data)}</div>
            <div className="small">
              {info.state === 'open' && 'The first wild Pokémon you meet here is the only one you can catch.'}
              {info.state === 'none' && 'Nothing to catch in this area.'}
              {info.state === 'noballs' && "Wild battles before then don't use up an area."}
              {info.state === 'caught' && info.encounter && `Level ${info.encounter.level}.`}
              {info.state === 'failed' && 'This area is used up.'}
              {info.state === 'pending' && 'Weaken it, then throw a ball.'}
            </div>
          </div>
        </div>
      )}

      {tables.map(({ id, t }) => (
        <div key={id}>
          {tables.length > 1 && <h3 style={{ color: 'var(--ink)' }}>{MAPS[id].name}</h3>}
          {t!.grass.length > 0 && <WildGrid title={`Grass and caves (rate ${t!.grassRate})`} slots={t!.grass} data={gen1!} run={run} />}
          {t!.water.length > 0 && <WildGrid title={`Surfing (rate ${t!.waterRate})`} slots={t!.water} data={gen1!} run={run} />}
          {t!.superRod.length > 0 && (
            <WildGrid
              title="Super Rod"
              slots={t!.superRod.map((s) => ({ ...s, chance: 1 / t!.superRod.length }))}
              data={gen1!}
              run={run}
            />
          )}
        </div>
      ))}
      {gen1 && tables.length === 0 && <p className="empty-state">No wild Pokémon live here.</p>}
      {run && <EncounterList data={data} run={run} session={session} />}
    </div>
  );
}

function WildGrid({ title, slots, data, run }: { title: string; slots: { level: number; species: number; chance: number }[]; data: Gen1Data; run: Run | null }) {
  // Merge slots per species.
  const by = new Map<number, { species: number; chance: number; min: number; max: number }>();
  for (const s of slots) {
    const e = by.get(s.species) ?? { species: s.species, chance: 0, min: 999, max: 0 };
    e.chance += s.chance;
    e.min = Math.min(e.min, s.level);
    e.max = Math.max(e.max, s.level);
    by.set(s.species, e);
  }
  const list = [...by.values()].sort((a, b) => b.chance - a.chance);
  return (
    <>
      <h3>{title}</h3>
      <div className="wild">
        {list.map((e) => {
          const dupe = isDupe(run, data, e.species);
          return (
            <div key={e.species} className={`wild-mon${dupe ? ' dupe' : ''}`}>
              {dupe && <span className="tag">Dupe</span>}
              <span className="pct">{Math.round(e.chance * 100)}%</span>
              <Sprite data={data} species={e.species} />
              <span className="nm">{data.speciesName(e.species)}</span>
              <span className="meta">Lv {e.min === e.max ? e.min : `${e.min}–${e.max}`}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

const OUTCOME_LABEL: Record<Encounter['outcome'], string> = {
  pending: 'In battle',
  caught: 'Caught',
  failed: 'Missed',
  dupe: 'Dupe',
  skipped: "Doesn't count",
};

function EncounterList({ data, run, session }: { data: Dex; run: Run; session: PlaySession }) {
  const setOutcome = (id: string, outcome: Encounter['outcome']) =>
    session.updateRun((r) => {
      const e = r.encounters.find((x) => x.id === id);
      if (!e) return;
      e.outcome = outcome;
      e.manual = true;
      if (r.activeEncounterId === id && outcome !== 'pending') r.activeEncounterId = null;
      r.timeline.push({ at: Date.now(), playSeconds: 0, kind: 'note', text: `Marked ${e.area} (${data.speciesName(e.species)}) as ${OUTCOME_LABEL[outcome].toLowerCase()}` });
    });
  const list = [...run.encounters].reverse();
  if (!list.length) return null;
  return (
    <>
      <h3>All encounters ({run.encounters.filter((e) => e.outcome !== 'dupe').length})</h3>
      <ul className="rows">
        {list.map((e) => {
          const mon = e.monKey ? run.mons[e.monKey] : undefined;
          const dead = mon?.status === 'dead';
          return (
            <li className="row" key={e.id}>
              <Sprite data={data} species={mon?.species ?? e.species} />
              <div>
                <div className="t">{mon?.nickname || data.speciesName(e.species)}</div>
                <div className="s">
                  {e.area}, Lv{e.level}
                  {e.kind !== 'wild' && ` (${e.kind})`}
                </div>
              </div>
              {dead ? (
                <span className="outcome dead">Dead</span>
              ) : (
                <select
                  className={`outcome ${e.outcome}`}
                  value={e.outcome}
                  aria-label={`Outcome for ${e.area}`}
                  onChange={(ev) => setOutcome(e.id, ev.target.value as Encounter['outcome'])}
                >
                  {e.outcome === 'pending' && <option value="pending">In battle</option>}
                  <option value="caught">Caught</option>
                  <option value="failed">Missed</option>
                  <option value="dupe">Dupe</option>
                  <option value="skipped">Doesn't count</option>
                </select>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---------------- Team ----------------
function MonCard({ data, m, tracked }: { data: Dex; m: MonData; tracked?: TrackedMon }) {
  const dead = tracked?.status === 'dead';
  const progress = data.xpProgress(m.species, m.level, m.exp);
  const hasXp = progress !== undefined;
  const xp = progress ?? null;
  return (
    <article className={`mon-card${dead ? ' dead' : ''}`}>
      <header>
        <Sprite data={data} species={m.species} />
        <div>
          <div className="nick">{m.nickname}</div>
          <div className="species">
            {data.speciesName(m.species)}
            {tracked?.origin === 'starter' ? ', your starter' : tracked && tracked.origin !== 'baseline' ? `, met in ${tracked.area}` : ''}
          </div>
          <div style={{ marginTop: 4 }}>
            <Types types={m.types} data={data} />
          </div>
        </div>
        <div className="lvl">
          {m.level}
          <small>level</small>
        </div>
      </header>
      {(m.maxHp > 0 || hasXp) && (
        <div className="bars">
          {m.maxHp > 0 && (
            <>
              <span className={`hp ${hpClass(m.hp, m.maxHp)}`}>
                <i style={{ width: `${(100 * m.hp) / m.maxHp}%` }} />
              </span>
              <span>
                {m.hp}/{m.maxHp} HP
              </span>
            </>
          )}
          {hasXp && (
            <>
              <span className="xp" role="progressbar" aria-label="Experience" aria-valuenow={xp ? Math.round((100 * xp.into) / xp.span) : 100} aria-valuemin={0} aria-valuemax={100}>
                <i style={{ width: `${xp ? (100 * xp.into) / xp.span : 100}%` }} />
              </span>
              <span>{xp ? `${xp.toNext.toLocaleString()} XP to Lv ${m.level + 1}` : 'Max level'}</span>
            </>
          )}
        </div>
      )}
      {dead && <div className="outcome dead" style={{ justifySelf: 'start' }}>Dead: {tracked?.death?.cause}</div>}
      {tracked?.violation && <div className="warn-bar">{tracked.violation}</div>}
      <div className="moves">
        {m.moves
          .map((id, i) => ({ id, pp: m.pp[i] }))
          .filter((x) => x.id > 0)
          .map(({ id, pp }, i) => {
            const mv = data.move(id);
            return (
              <div key={i} className="move" style={{ borderLeftColor: (mv && data.typeColor(mv.type)) ?? undefined }}>
                <b>{mv?.name}</b>
                <small>
                  {pp}/{mv?.pp}
                </small>
              </div>
            );
          })}
      </div>
      {m.stats && (
        <div className={`stats${m.stats.spdef === undefined ? '' : ' six'}`}>
          <div>
            <b>{m.maxHp}</b>HP
          </div>
          <div>
            <b>{m.stats.atk}</b>Atk
          </div>
          <div>
            <b>{m.stats.def}</b>Def
          </div>
          <div>
            <b>{m.stats.spd}</b>Spe
          </div>
          {m.stats.spdef === undefined ? (
            <div>
              <b>{m.stats.spc}</b>Spc
            </div>
          ) : (
            <>
              <div>
                <b>{m.stats.spc}</b>SpA
              </div>
              <div>
                <b>{m.stats.spdef}</b>SpD
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function TeamTab({ data, view }: { data: Dex; view: SessionView }) {
  const { snap, run } = view;
  if (!snap) return <p className="empty-state">Your team shows up once a save is loaded.</p>;
  const cap = view.milestone;
  return (
    <div>
      <h2>Team</h2>
      {cap && (
        <p className="sub">
          Next: {cap.name}, whose strongest is level {cap.ace}
          {run?.rules.levelCaps ? `. Keep your team at ${cap.ace} or below.` : '.'}
        </p>
      )}
      {cap && cap.team.length > 0 && (
        <div className="enemy-team" style={{ marginBottom: 14 }}>
          {cap.team.map((t, i) => (
            <div className="row" key={i}>
              <Sprite data={data} species={t.species} />
              <span className="s">
                {data.speciesName(t.species)} {t.level}
              </span>
            </div>
          ))}
        </div>
      )}
      {snap.party.map((m) => (
        <MonCard key={m.key} data={data} m={m} tracked={run?.mons[m.key]} />
      ))}
      {snap.box.length > 0 && (
        <>
          <h3>{data.gen === 1 ? `Box ${snap.boxNum} (${snap.box.length}/20)` : `PC (${snap.box.length})`}</h3>
          <ul className="rows">
            {snap.box.map((m) => {
              const t = run?.mons[m.key];
              return (
                <li className="row" key={m.key}>
                  <Sprite data={data} species={m.species} />
                  <div>
                    <div className="t">{m.nickname}</div>
                    <div className="s">
                      {data.speciesName(m.species)}, Lv{m.level}
                    </div>
                  </div>
                  {t?.status === 'dead' && <span className="outcome dead">Dead</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="sub" style={{ marginTop: 16 }}>
        Trainer {snap.playerName}, ID {snap.playerId.toString().padStart(5, '0')}, ¥{snap.money.toLocaleString()}, played {fmtPlay(snap.playSeconds)}.
      </p>
    </div>
  );
}

// ---------------- Log ----------------
function LogTab({ run }: { run: Run }) {
  const items = [...run.timeline].reverse();
  const caught = run.encounters.filter((e) => e.outcome === 'caught').length;
  const dead = Object.values(run.mons).filter((m) => m.status === 'dead').length;
  return (
    <div>
      <h2>{run.name}</h2>
      <p className="sub">
        {caught} caught, {dead} lost, {Object.keys(run.mons).length - dead} still standing.
        {run.status === 'failed' && ' The run ended in a wipe.'}
      </p>
      <ul className="log">
        {items.map((e, i) => (
          <li key={i} className={e.kind}>
            <time>{e.playSeconds ? fmtPlay(e.playSeconds) : new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
            {e.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------- Graves ----------------
function GravesTab({ data, dead, session }: { data: Dex | null; dead: TrackedMon[]; session: PlaySession }) {
  const undo = (m: TrackedMon) => {
    if (!confirm(`Bring ${m.nickname} back? Use this only if the faint was undone, for example by reloading your in-game save.`)) return;
    session.updateRun((r) => {
      const t = r.mons[m.key];
      if (!t) return;
      t.status = 'alive';
      t.death = undefined;
      r.timeline.push({ at: Date.now(), playSeconds: 0, kind: 'note', text: `${t.nickname}'s faint was undone` });
    });
  };
  if (!dead.length) return <p className="empty-state">No losses yet. Keep it that way.</p>;
  const sorted = [...dead].sort((a, b) => (b.death?.at ?? 0) - (a.death?.at ?? 0));
  return (
    <div>
      <h2>Graves</h2>
      <p className="sub">{dead.length === 1 ? 'One Pokémon has fallen.' : `${dead.length} Pokémon have fallen.`}</p>
      <div className="graves">
        {sorted.map((m) => (
          <div className="grave" key={m.key}>
            <Sprite data={data} species={m.species} />
            <span className="nick">{m.nickname}</span>
            <span className="sp">
              {data?.speciesName(m.species)}, Lv{m.death?.level ?? m.level}
            </span>
            <span className="cause">
              {m.death?.cause}
              <br />
              {m.death?.area}
            </span>
            <button className="btn ghost" style={{ minHeight: 32, padding: '4px 10px', fontSize: 13 }} onClick={() => undo(m)}>
              Undo
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------- Run / settings ----------------
function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="field">
      <span>
        <span className="lbl">{label}</span>
        {hint && <div className="hint">{hint}</div>}
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function SlotThumb({ rec }: { rec: StateRecord<unknown> | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const palette = paletteById(prefs.get().palette);
  const rgba = rec?.thumb?.length === GBA_THUMB_W * GBA_THUMB_H * 4;
  useEffect(() => {
    const c = ref.current;
    if (!c || !rec?.thumb) return;
    if (rgba) {
      // Game Boy Advance: a half-size RGBA screenshot.
      c.width = GBA_THUMB_W;
      c.height = GBA_THUMB_H;
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(GBA_THUMB_W, GBA_THUMB_H);
      img.data.set(rec.thumb);
      ctx.putImageData(img, 0, 0);
      return;
    }
    c.width = 160;
    c.height = 144;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(160, 144);
    const cols = palette.colors.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
    rec.thumb.forEach((s, i) => {
      img.data.set([...cols[s], 255], i * 4);
    });
    ctx.putImageData(img, 0, 0);
  }, [rec, palette, rgba]);
  return <canvas ref={ref} className={rgba ? 'gba' : undefined} />;
}

function RunTab({ session, view, onStartRun, onExit }: { session: PlaySession; view: SessionView; onStartRun: () => void; onExit: () => void }) {
  const { run } = view;
  const p = prefs.get();
  const gb = session.system === 'gb';
  const [, force] = useState(0);
  const [slots, setSlots] = useState<Record<string, StateRecord<unknown> | undefined>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const statesOk = session.canUseStates();

  const loadSlots = async () => {
    const list = await db.listStates(session.rom.key);
    setSlots(Object.fromEntries(list.map((r) => [r.slot, r])));
  };
  useEffect(() => {
    void loadSlots();
  }, []);

  const setPref = (patch: Parameters<typeof prefs.set>[0]) => {
    prefs.set(patch);
    force((n) => n + 1);
  };
  const setRule = <K extends keyof Run['rules']>(k: K, v: Run['rules'][K]) => session.updateRun((r) => (r.rules[k] = v));

  const download = () => {
    const url = URL.createObjectURL(session.exportSave());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session.rom.name}.sav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div>
      {run ? (
        <>
          <h2>{run.name}</h2>
          <p className="sub">Started {new Date(run.createdAt).toLocaleDateString()}. Rules apply from the moment you change them.</p>
          <Toggle label="Dupes clause" hint="Skip first encounters you already own the evolution line of." checked={run.rules.dupesClause} onChange={(v) => setRule('dupesClause', v)} />
          <Toggle label="Gifts use the area" hint="Eevee, Lapras, fossils and other gifts count as that area's encounter." checked={run.rules.giftsCount} onChange={(v) => setRule('giftsCount', v)} />
          <Toggle label="Level caps" hint="Warn when your team is above the next leader's strongest Pokémon." checked={run.rules.levelCaps} onChange={(v) => setRule('levelCaps', v)} />
          <Toggle label="Force Set battle style" hint="No free switch after knocking out a foe." checked={run.rules.forceSetMode} onChange={(v) => setRule('forceSetMode', v)} />
          <Toggle label="Wait for Poké Balls" hint="Wild battles only count as encounters once you've had Poké Balls." checked={run.rules.waitForBalls} onChange={(v) => setRule('waitForBalls', v)} />
          <Toggle label="No items in battle" hint="Flag healing and other items used mid-battle. Poké Balls are fine." checked={!!run.rules.noBattleItems} onChange={(v) => setRule('noBattleItems', v)} />
          <Toggle label="No save states" hint="Hardcore: only the in-game save. Resuming after closing the app still works." checked={run.rules.noSaveStates} onChange={(v) => setRule('noSaveStates', v)} />
          {gb && <div className="field">
            <span>
              <span className="lbl">Areas</span>
              <div className="hint">Whether each cave floor or building counts separately.</div>
            </span>
            <span className="seg">
              <button aria-pressed={run.rules.areaGrouping === 'area'} onClick={() => setRule('areaGrouping', 'area')}>
                Grouped
              </button>
              <button aria-pressed={run.rules.areaGrouping === 'map'} onClick={() => setRule('areaGrouping', 'map')}>
                Per map
              </button>
            </span>
          </div>}
        </>
      ) : (
        <>
          <h2>Settings</h2>
          {session.data && (
            <div className="btn-row" style={{ marginBottom: 8 }}>
              <button className="btn primary" onClick={onStartRun}>
                Start a Nuzlocke run
              </button>
            </div>
          )}
        </>
      )}

      {session.system === 'gb' && session.data && (
        <>
          <h3>Game helpers</h3>
          <Toggle
            label="Endless Repel"
            hint="Works like a Repel that never wears off: wild Pokémon weaker than your lead stay away, stronger ones still appear."
            checked={p.repel}
            onChange={(v) => setPref({ repel: v })}
          />
        </>
      )}

      <h3>Save states</h3>
      {statesOk ? (
        <div className="slots">
          {['1', '2', '3'].map((s) => (
            <div className="slot" key={s}>
              <SlotThumb rec={slots[s]} />
              <span>{slots[s] ? new Date(slots[s]!.savedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : `Slot ${s} is empty`}</span>
              <div className="btns">
                <button
                  className="btn"
                  onClick={async () => {
                    await session.saveSlot(s);
                    await loadSlots();
                    setMsg(`Saved to slot ${s}.`);
                  }}
                >
                  Save
                </button>
                <button
                  className="btn"
                  disabled={!slots[s]}
                  onClick={async () => {
                    try {
                      if (await session.loadSlot(s)) setMsg(`Loaded slot ${s}.`);
                    } catch (err) {
                      setMsg(err instanceof Error ? err.message : String(err));
                    }
                  }}
                >
                  Load
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="sub">Save states are off for this run. Use the in-game save.</p>
      )}
      {msg && <p className="sub" role="status">{msg}</p>}

      {gb && <h3>Screen colors</h3>}
      {gb && <div className="swatches">
        {PALETTES.map((pal) => (
          <button key={pal.id} className="swatch" aria-pressed={p.palette === pal.id} onClick={() => setPref({ palette: pal.id })}>
            <span className="chips">
              {pal.colors.map((c) => (
                <i key={c} style={{ background: c }} />
              ))}
            </span>
            {pal.name}
          </button>
        ))}
      </div>}

      <h3>Device</h3>
      <div className="field">
        <span className="lbl">Appearance</span>
        <span className="seg">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button key={t} aria-pressed={p.theme === t} onClick={() => setPref({ theme: t })}>
              {t === 'system' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </span>
      </div>
      <Toggle label="Sound" checked={!view.muted} onChange={(v) => session.setMuted(!v)} />
      <Toggle label="Pause while this panel is open" checked={p.pauseOnSheet} onChange={(v) => setPref({ pauseOnSheet: v })} />
      <Toggle label="Vibrate on button press" hint="Android only; iPhone browsers don't allow it." checked={p.haptics} onChange={(v) => setPref({ haptics: v })} />
      <div className="field">
        <span>
          <span className="lbl">Emulator</span>
          <div className="hint">
            {gb ? 'Rust' : 'Game Boy Advance core in Rust'}, compiled to WebAssembly{view.emuMs != null && ` · ${view.emuMs.toFixed(2)} ms per frame`}
          </div>
        </span>
      </div>

      <h3>In-game save</h3>
      <p className="sub">Back up your .sav file, or bring one from another emulator or a cartridge dump.</p>
      <div className="btn-row">
        <button className="btn" onClick={download} disabled={session.system === 'gba' && !session.hasSave}>
          Download .sav
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          Import .sav
        </button>
        <input
          ref={fileRef}
          type="file"
          className="sr-only"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            if (!confirm('Replace the current in-game save with this file? The game will restart.')) return;
            try {
              await session.importSave(new Uint8Array(await f.arrayBuffer()));
              setMsg('Save imported. The game restarted.');
            } catch (err) {
              setMsg(err instanceof Error ? err.message : String(err));
            }
          }}
        />
        <button
          className="btn"
          onClick={() => {
            if (confirm('Restart the game? Unsaved in-game progress is lost.')) session.reset();
          }}
        >
          Restart game
        </button>
      </div>

      {run && (
        <>
          <h3>Run log</h3>
          <div className="btn-row">
            <button
              className="btn"
              onClick={() => {
                const blob = new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${run.name.replace(/[^\w-]+/g, '-')}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Download run log
            </button>
          </div>
        </>
      )}

      <div className="btn-row" style={{ marginTop: 24 }}>
        {run && (
          <button
            className="btn danger"
            onClick={async () => {
              if (confirm(`End “${run.name}”? Its log is kept on this device, and the game keeps running.`)) await session.endRun();
            }}
          >
            End run
          </button>
        )}
        <button className="btn ghost" onClick={onExit}>
          Back to library
        </button>
      </div>
      <p className="sub" style={{ marginTop: 16 }}>
        {view.version ? `Pokémon ${versionLabel(view.version)}` : session.rom.title}, running at {view.fps} fps.
      </p>
    </div>
  );
}

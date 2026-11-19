import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { Session } from '../platform/session.ts';
import { Controls, useGamepad, useKeyboard } from './Controls.tsx';
import { hpClass, routeInfo, routeLine } from './derive.ts';
import { NewRunModal } from './NewRunModal.tsx';
import { prefs } from './prefs.ts';
import { Sheet, type TabId } from './Sheet.tsx';
import { Sprite } from './Sprite.tsx';

export function Play({ session, onExit }: { session: Session; onExit: () => void }) {
  const view = useSyncExternalStore(session.subscribe, session.getView);
  const p = useSyncExternalStore(prefs.subscribe, prefs.get);
  const [sheet, setSheet] = useState<TabId | null>(null);
  const [newRun, setNewRun] = useState(false);
  const data = session.data;
  const { snap, run } = view;
  const info = routeInfo(data, run, snap);
  const isDesktop = typeof window !== 'undefined' && window.matchMedia('(min-width: 1000px) and (min-height: 600px) and (hover: hover)').matches;
  const sheetOpen = sheet !== null || isDesktop;

  useKeyboard(session, !newRun);
  useGamepad(session);

  useEffect(() => {
    session.setPalette(p.palette);
  }, [session, p.palette]);

  // iOS only lets audio start inside certain gestures; try on each until it sticks.
  useEffect(() => {
    const unlock = () => {
      void session.audio.unlock().then(() => {
        if (session.audio.ready) {
          for (const e of ['touchend', 'click', 'keydown'] as const) document.removeEventListener(e, unlock, true);
        }
      });
    };
    for (const e of ['touchend', 'click', 'keydown'] as const) document.addEventListener(e, unlock, true);
    return () => {
      for (const e of ['touchend', 'click', 'keydown'] as const) document.removeEventListener(e, unlock, true);
    };
  }, [session]);

  useEffect(() => {
    document.title = run ? `${run.name} · Lockstep` : `${session.rom.name} · Lockstep`;
  }, [run, session.rom.name]);

  // Pause while the panel covers the controls (phones only).
  useEffect(() => {
    if (isDesktop) return;
    if (sheet !== null && p.pauseOnSheet) {
      session.setPaused(true);
      return () => session.setPaused(false);
    }
  }, [sheet, p.pauseOnSheet, session, isDesktop]);

  const canvasRef = useCallback((el: HTMLCanvasElement | null) => session.attachCanvas(el), [session]);

  const openSheet = (tab?: TabId) => {
    void session.audio.unlock();
    setSheet(tab ?? (snap?.inBattle ? 'battle' : 'route'));
  };

  const onChip = () => {
    if (!run && data) setNewRun(true);
    else openSheet('route');
  };

  const cap = view.milestone;
  const overCap = !!(cap && snap && run?.rules.levelCaps && snap.party.some((m) => m.level > cap.ace && run.mons[m.key]?.status !== 'dead'));
  const party = snap?.party ?? [];

  return (
    <div className="play" onPointerDown={() => void session.audio.unlock()}>
      <div className="strip">
        <button className="icon-btn" onClick={onExit} aria-label="Back to library">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <button className={`route-chip ${info.state}`} onClick={onChip}>
          <span className="dot" aria-hidden="true">
            {info.encounter && <Sprite data={data} species={info.encounter.species} />}
          </span>
          <span className="txt">
            <span className="area">{data ? info.area : session.rom.name}</span>
            <span className="state">{data ? routeLine(info, data) : 'Tracking unavailable for this game'}</span>
          </span>
        </button>
        {cap && run && (
          <button className={`cap-chip${overCap ? ' over' : ''}`} onClick={() => openSheet('team')} aria-label={`Level cap ${cap.ace} for ${cap.name}`}>
            <b>{cap.ace}</b>
            cap
          </button>
        )}
      </div>

      <div className="screen-wrap">
        <canvas ref={canvasRef} className="screen" aria-label="Game screen" />
        <div className="screen-badges">
          {view.speed > 1 && <span className="speed-pill">{view.speed}× speed</span>}
        </div>
        {view.paused && !sheetOpen && (
          <button className="pause-overlay" onClick={() => session.setPaused(false)}>
            Paused. Tap to resume
          </button>
        )}
      </div>

      {data && (
        <button className="team" onClick={() => openSheet('team')} aria-label="Open team">
          {Array.from({ length: 6 }, (_, i) => {
            const m = party[i];
            if (!m) return <div key={i} className="mon-pip empty" />;
            const dead = run?.mons[m.key]?.status === 'dead';
            const active = !!snap?.inBattle && snap.activeSlot === i;
            const hp = active && snap?.activeHp != null ? snap.activeHp : m.hp;
            return (
              <div key={m.key + i} className={`mon-pip${dead ? ' dead' : ''}${active ? ' active' : ''}`}>
                <Sprite data={data} species={m.species} alt={m.nickname} />
                <span className="lv">{m.level}</span>
                <span className={`hp ${hpClass(hp, m.maxHp)}`}>
                  <i style={{ width: `${m.maxHp ? (100 * hp) / m.maxHp : 0}%` }} />
                </span>
              </div>
            );
          })}
        </button>
      )}

      <div className="lower">
        {view.warnings.length > 0 && <div className="warn-bar" role="status">{view.warnings[0]}</div>}
        <Controls session={session} speed={view.speed} onMenu={() => openSheet()} />
        <p className="keys-hint">Arrows move, X is A, Z is B, Enter is Start, Shift is Select. Space changes speed, P pauses.</p>
      </div>

      <div className="toasts" aria-live="polite">
        {view.toasts.map((t) => (
          <button key={t.id} className={`toast ${t.tone}`} onClick={() => session.dismissToast(t.id)}>
            {t.species ? <Sprite data={data} species={t.species} /> : <span className="ph" />}
            <span>
              <strong>{t.title}</strong>
              {t.body && <small>{t.body}</small>}
            </span>
          </button>
        ))}
      </div>

      {sheetOpen && (
        <Sheet
          session={session}
          view={view}
          tab={sheet ?? (snap?.inBattle ? 'battle' : 'route')}
          onTab={setSheet}
          onClose={() => setSheet(null)}
          onStartRun={() => setNewRun(true)}
          onExit={onExit}
          docked={isDesktop}
        />
      )}

      {newRun && data && <NewRunModal session={session} onClose={() => setNewRun(false)} />}
    </div>
  );
}

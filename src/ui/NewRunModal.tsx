import { useEffect, useRef, useState } from 'react';
import type { Session } from '../platform/session.ts';
import { db } from '../platform/storage.ts';
import { DEFAULT_RULES, type Rules } from '../run/types.ts';

export function NewRunModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const version = session.data?.version ?? 'game';
  const label = version[0].toUpperCase() + version.slice(1);
  const [name, setName] = useState(`${label} Nuzlocke`);
  const [rules, setRules] = useState<Rules>({ ...DEFAULT_RULES });
  const [busy, setBusy] = useState(false);
  const snap = session.getView().snap;
  const hasMons = !!snap && (snap.party.length > 0 || snap.box.length > 0);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    session.setPaused(true);
    void db.listRuns().then((runs) => {
      const n = runs.filter((r) => r.romKey === session.rom.key).length;
      if (n > 0) setName(`${label} Nuzlocke #${n + 1}`);
    });
    dialog.current?.querySelector('input')?.focus();
    return () => session.setPaused(false);
  }, [session, label]);

  const set = <K extends keyof Rules>(k: K, v: Rules[K]) => setRules((r) => ({ ...r, [k]: v }));

  const start = async () => {
    setBusy(true);
    await session.startRun(name.trim() || `${label} Nuzlocke`, rules);
    onClose();
  };

  const Row = ({ k, label: l, hint }: { k: 'dupesClause' | 'giftsCount' | 'waitForBalls' | 'levelCaps' | 'forceSetMode' | 'noSaveStates' | 'noBattleItems'; label: string; hint: string }) => (
    <label className="field">
      <span>
        <span className="lbl">{l}</span>
        <div className="hint">{hint}</div>
      </span>
      <input type="checkbox" className="switch" checked={rules[k]} onChange={(e) => set(k, e.target.checked)} />
    </label>
  );

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="newrun-title" ref={dialog}>
        <h2 id="newrun-title">Start a Nuzlocke run</h2>
        <p className="sub">
          Lockstep watches the game and logs each area's first encounter, every catch and every loss for you.
          {hasMons && ' Pokémon you already have are kept as they are.'}
        </p>
        <label className="lbl" htmlFor="run-name">
          Run name
        </label>
        <input id="run-name" type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        <Row k="dupesClause" label="Dupes clause" hint="Skip first encounters you already own the evolution line of." />
        <Row k="giftsCount" label="Gifts use the area" hint="Gift Pokémon count as that area's encounter." />
        <Row k="waitForBalls" label="Wait for Poké Balls" hint="Wild battles only count once you've had Poké Balls." />
        <Row k="levelCaps" label="Level caps" hint="Warn when you're above the next leader's strongest Pokémon." />
        <Row k="forceSetMode" label="Force Set battle style" hint="No free switch after knocking out a foe." />
        <Row k="noBattleItems" label="No items in battle" hint="Flag healing items used mid-battle. Poké Balls are fine." />
        <Row k="noSaveStates" label="No save states" hint="Hardcore: in-game saves only." />
        <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn ghost" onClick={onClose}>
            Not now
          </button>
          <button className="btn primary" onClick={() => void start()} disabled={busy}>
            Start run
          </button>
        </div>
      </div>
    </div>
  );
}

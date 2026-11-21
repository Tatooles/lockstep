import { useEffect, useState } from 'react';
import type { PlaySession } from './Sheet.tsx';
import { Sprite } from './Sprite.tsx';

const USE_POTIONS_KEY = 'lockstep:grindPotions';

function readPotionsPref(): boolean {
  try {
    return localStorage.getItem(USE_POTIONS_KEY) !== '0';
  } catch {
    return true;
  }
}

export function GrindModal({ session, onClose }: { session: PlaySession; onClose: () => void }) {
  const view = session.getView();
  const lead = view.snap?.party[0];
  const cap = view.milestone?.ace ?? null;
  const capRule = !!view.run?.rules.levelCaps;
  const current = lead?.level ?? 1;
  const [target, setTarget] = useState(() => (cap && cap > current ? cap : Math.min(100, current + 3)));
  const [usePotions, setUsePotions] = useState(readPotionsPref);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    session.setPaused(true);
    return () => session.setPaused(false);
  }, [session]);

  const problem = session.grindProblem(target);
  const start = () => {
    try {
      localStorage.setItem(USE_POTIONS_KEY, usePotions ? '1' : '0');
    } catch {
      // ignore
    }
    const err = session.startGrind({ targetLevel: target, usePotions });
    if (err) setError(err);
    else onClose();
  };
  const step = (d: number) => setTarget((t) => Math.max(current + 1, Math.min(100, t + d)));
  const overCap = capRule && cap !== null && target > cap;

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal grind-modal" role="dialog" aria-modal="true" aria-labelledby="grind-title">
        <h2 id="grind-title">Auto-grind</h2>
        <p className="sub">
          Lockstep plays the real game at full speed: it walks the grass here and battles wild Pokémon with your lead,
          running from anything that could knock it out. It hands control back for first encounters, trainers, new
          moves, evolutions and faints.
        </p>
        {lead && (
          <div className="grind-target">
            <span className="mon">
              <Sprite data={session.data} species={lead.species} alt="" />
            </span>
            <span className="who">
              <strong>{lead.nickname}</strong>
              <small>
                Lv {current} → {target}
                {cap !== null && <> · cap {cap}</>}
              </small>
            </span>
            <span className="stepper" role="group" aria-label="Target level">
              <button className="btn" onClick={() => step(-1)} disabled={target <= current + 1} aria-label="One level lower">
                −
              </button>
              <output aria-live="polite">{target}</output>
              <button className="btn" onClick={() => step(1)} disabled={target >= 100} aria-label="One level higher">
                +
              </button>
            </span>
          </div>
        )}
        {overCap && <div className="warn-bar">That's above the level cap for {view.milestone?.name}.</div>}
        <label className="field">
          <span>
            <span className="lbl">Heal with Potions</span>
            <div className="hint">Between battles, below half HP. Uses Potions, then Super and Hyper Potions. Never drinks.</div>
          </span>
          <input type="checkbox" className="switch" checked={usePotions} onChange={(e) => setUsePotions(e.target.checked)} />
        </label>
        {view.run && <p className="grind-note">Faints count. The bot plays it safe, but a Pokémon that faints while it plays is gone.</p>}
        {(error ?? problem) && <div className="warn-bar">{error ?? problem}</div>}
        <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={start} disabled={!!problem}>
            Start grinding
          </button>
        </div>
      </div>
    </div>
  );
}

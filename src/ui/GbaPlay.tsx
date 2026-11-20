// Play screen for Game Boy Advance games: screen, controls with L and R, and a
// menu with save states, the in-game save and settings. No tracker.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { THUMB_H, THUMB_W, type GbaSession, type GbaView } from '../gba/session.ts';
import type { StateRecord } from '../platform/storage.ts';
import { Controls, useGamepad, useKeyboard } from './Controls.tsx';
import { prefs } from './prefs.ts';

export function GbaPlay({ session, onExit }: { session: GbaSession; onExit: () => void }) {
  const view = useSyncExternalStore(session.subscribe, session.getView);
  const p = useSyncExternalStore(prefs.subscribe, prefs.get);
  const [menu, setMenu] = useState(false);
  const isDesktop = typeof window !== 'undefined' && window.matchMedia('(min-width: 1000px) and (min-height: 600px) and (hover: hover)').matches;
  const menuOpen = menu || isDesktop;

  useKeyboard(session, true, true);
  useGamepad(session, true);

  // iOS only lets audio start inside certain gestures; try on each until it sticks.
  useEffect(() => {
    const events = ['touchend', 'click', 'keydown'] as const;
    const unlock = () => {
      void session.audio.unlock().then(() => {
        if (session.audio.ready) for (const e of events) document.removeEventListener(e, unlock, true);
      });
    };
    for (const e of events) document.addEventListener(e, unlock, true);
    return () => {
      for (const e of events) document.removeEventListener(e, unlock, true);
    };
  }, [session]);

  useEffect(() => {
    document.title = `${session.rom.name} · Lockstep`;
  }, [session.rom.name]);

  // Pause while the menu covers the controls (phones only).
  useEffect(() => {
    if (isDesktop || !menu || !p.pauseOnSheet) return;
    session.setPaused(true);
    return () => session.setPaused(false);
  }, [menu, p.pauseOnSheet, session, isDesktop]);

  const canvasRef = useCallback((el: HTMLCanvasElement | null) => session.attachCanvas(el), [session]);

  return (
    <div className="play gba" onPointerDown={() => void session.audio.unlock()}>
      <div className="strip">
        <button className="icon-btn" onClick={onExit} aria-label="Back to library">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <button className="route-chip" onClick={() => setMenu(true)}>
          <span className="txt">
            <span className="area">{session.rom.name}</span>
            <span className="state">Game Boy Advance</span>
          </span>
        </button>
      </div>

      <div className="screen-wrap">
        <canvas ref={canvasRef} className="screen" aria-label="Game screen" />
        <div className="screen-badges">{view.speed > 1 && <span className="speed-pill">{view.speed}× speed</span>}</div>
        {view.paused && !menuOpen && (
          <button className="pause-overlay" onClick={() => session.setPaused(false)}>
            Paused. Tap to resume
          </button>
        )}
      </div>

      <div className="lower">
        <Controls session={session} speed={view.speed} onMenu={() => setMenu(true)} shoulders menuLabel="Menu" />
        <p className="keys-hint">Arrows move, X is A, Z is B, Q and E are L and R, Enter is Start, Shift is Select. Space changes speed, P pauses.</p>
      </div>

      {menuOpen && <GbaMenu session={session} view={view} onClose={() => setMenu(false)} onExit={onExit} docked={isDesktop} />}
    </div>
  );
}

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

function SlotThumb({ rec }: { rec: StateRecord<Uint8Array> | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !rec?.thumb || rec.thumb.length !== THUMB_W * THUMB_H * 4) return;
    c.width = THUMB_W;
    c.height = THUMB_H;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(THUMB_W, THUMB_H);
    img.data.set(rec.thumb);
    ctx.putImageData(img, 0, 0);
  }, [rec]);
  return <canvas ref={ref} className="gba" />;
}

function GbaMenu({ session, view, onClose, onExit, docked }: { session: GbaSession; view: GbaView; onClose: () => void; onExit: () => void; docked: boolean }) {
  const p = useSyncExternalStore(prefs.subscribe, prefs.get);
  const [slots, setSlots] = useState<Record<string, StateRecord<Uint8Array> | undefined>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadSlots = useCallback(async () => {
    const list = await session.listSlots();
    setSlots(Object.fromEntries(list.map((r) => [r.slot, r])));
  }, [session]);
  useEffect(() => {
    void loadSlots();
  }, [loadSlots]);

  useEffect(() => {
    if (docked) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [docked, onClose]);

  const download = () => {
    const url = URL.createObjectURL(session.exportSave());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session.rom.name}.sav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <>
      {!docked && <div className="sheet-scrim" onClick={onClose} />}
      <section className="sheet" aria-label="Menu">
        <button className="sheet-handle" onClick={onClose} aria-label="Close menu">
          <i />
        </button>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected className="tab">
            Menu
          </button>
        </div>
        <div className="sheet-body">
          <h3>Save states</h3>
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
          {msg && (
            <p className="sub" role="status">
              {msg}
            </p>
          )}

          <h3>Device</h3>
          <div className="field">
            <span className="lbl">Appearance</span>
            <span className="seg">
              {(['system', 'light', 'dark'] as const).map((t) => (
                <button key={t} aria-pressed={p.theme === t} onClick={() => prefs.set({ theme: t })}>
                  {t === 'system' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </span>
          </div>
          <Toggle label="Sound" checked={!view.muted} onChange={(v) => session.setMuted(!v)} />
          <Toggle label="Pause while this menu is open" checked={p.pauseOnSheet} onChange={(v) => prefs.set({ pauseOnSheet: v })} />
          <Toggle label="Vibrate on button press" hint="Android only; iPhone browsers don't allow it." checked={p.haptics} onChange={(v) => prefs.set({ haptics: v })} />
          <div className="field">
            <span>
              <span className="lbl">Emulator</span>
              <div className="hint">
                Game Boy Advance core in Rust, compiled to WebAssembly{view.emuMs != null && ` · ${view.emuMs.toFixed(2)} ms per frame`}
              </div>
            </span>
          </div>

          {session.hasSave && (
            <>
              <h3>In-game save</h3>
              <p className="sub">Back up your .sav file, or bring one from another emulator or a cartridge dump.</p>
              <div className="btn-row">
                <button className="btn" onClick={download}>
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
              </div>
            </>
          )}

          <div className="btn-row" style={{ marginTop: 24 }}>
            <button
              className="btn"
              onClick={() => {
                if (confirm('Restart the game? Unsaved in-game progress is lost.')) session.reset();
              }}
            >
              Restart game
            </button>
            <button className="btn ghost" onClick={onExit}>
              Back to library
            </button>
          </div>
          <p className="sub" style={{ marginTop: 16 }}>
            {session.rom.title || session.rom.name}, running at {view.fps} fps.
          </p>
        </div>
      </section>
    </>
  );
}

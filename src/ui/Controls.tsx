import { useEffect, useRef, useState } from 'react';
import { Button, Shoulder } from '../core/constants.ts';
import { prefs } from './prefs.ts';

/** What the controls drive: a Game Boy or a GBA session. */
export interface Pad {
  press(button: number, down: boolean): void;
  cycleSpeed(): void;
  setPaused(p: boolean): void;
  getView(): { paused: boolean };
}

function buzz(): void {
  if (prefs.get().haptics) navigator.vibrate?.(8);
}

type Dir = 'up' | 'down' | 'left' | 'right' | null;
const DIR_BUTTON: Record<Exclude<Dir, null>, number> = {
  up: Button.Up,
  down: Button.Down,
  left: Button.Left,
  right: Button.Right,
};

function DPad({ session }: { session: Pad }) {
  const ref = useRef<HTMLDivElement>(null);
  const [dir, setDir] = useState<Dir>(null);
  const cur = useRef<Dir>(null);
  const pointer = useRef<number | null>(null);

  const set = (d: Dir) => {
    if (d === cur.current) return;
    if (cur.current) session.press(DIR_BUTTON[cur.current], false);
    if (d) {
      session.press(DIR_BUTTON[d], true);
      buzz();
    }
    cur.current = d;
    setDir(d);
  };

  const fromEvent = (e: React.PointerEvent): Dir => {
    const r = ref.current!.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < 12) return cur.current;
    // Dominant axis only: Gen 1 movement is grid-based, so diagonals just cause misfires.
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
    return dy > 0 ? 'down' : 'up';
  };

  const litStyle: Record<Exclude<Dir, null>, React.CSSProperties> = {
    up: { left: 50, top: 6 },
    down: { left: 50, bottom: 6 },
    left: { left: 6, top: 50 },
    right: { right: 6, top: 50 },
  };

  return (
    <div
      ref={ref}
      className="dpad"
      role="group"
      aria-label="Direction pad"
      onPointerDown={(e) => {
        e.preventDefault();
        pointer.current = e.pointerId;
        ref.current?.setPointerCapture(e.pointerId);
        set(fromEvent(e));
      }}
      onPointerMove={(e) => {
        if (pointer.current === e.pointerId) set(fromEvent(e));
      }}
      onPointerUp={(e) => {
        if (pointer.current === e.pointerId) {
          pointer.current = null;
          set(null);
        }
      }}
      onPointerCancel={() => {
        pointer.current = null;
        set(null);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="arm h" />
      <div className="arm v" />
      {dir && <div className="lit" style={litStyle[dir]} />}
      <div className="hub" />
    </div>
  );
}

function Key({ session, button, className, label }: { session: Pad; button: number; className: string; label: string }) {
  const [down, setDown] = useState(false);
  const release = () => {
    setDown(false);
    session.press(button, false);
  };
  return (
    <button
      className={`${className}${down ? ' down' : ''}`}
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        setDown(true);
        session.press(button, true);
        buzz();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={() => down && release()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span>{label}</span>
    </button>
  );
}

const KEYMAP: Record<string, number> = {
  ArrowUp: Button.Up,
  ArrowDown: Button.Down,
  ArrowLeft: Button.Left,
  ArrowRight: Button.Right,
  KeyW: Button.Up,
  KeyS: Button.Down,
  KeyA: Button.Left,
  KeyD: Button.Right,
  KeyX: Button.A,
  KeyK: Button.A,
  KeyZ: Button.B,
  KeyJ: Button.B,
  Enter: Button.Start,
  ShiftRight: Button.Select,
  ShiftLeft: Button.Select,
  Backspace: Button.Select,
};

const SHOULDER_KEYMAP: Record<string, number> = { ...KEYMAP, KeyQ: Shoulder.L, KeyE: Shoulder.R };

export function useKeyboard(session: Pad, enabled: boolean, shoulders = false) {
  useEffect(() => {
    if (!enabled) return;
    const keymap = shoulders ? SHOULDER_KEYMAP : KEYMAP;
    const buttons = shoulders ? 10 : 8;
    const isTyping = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) session.cycleSpeed();
        return;
      }
      if (e.code === 'KeyP' && !e.repeat) {
        session.setPaused(!session.getView().paused);
        return;
      }
      const b = keymap[e.code];
      if (b === undefined) return;
      e.preventDefault();
      session.press(b, true);
    };
    const up = (e: KeyboardEvent) => {
      const b = keymap[e.code];
      if (b !== undefined) session.press(b, false);
    };
    const blur = () => {
      for (let i = 0; i < buttons; i++) session.press(i, false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [session, enabled, shoulders]);
}

/** Standard-mapping gamepads (Bluetooth controllers, etc.). With shoulders, L1/R1 are L/R and R2 changes speed. */
export function useGamepad(session: Pad, shoulders = false) {
  useEffect(() => {
    let raf = 0;
    const prev = new Array(10).fill(false);
    let ffPrev = false;
    const poll = () => {
      raf = requestAnimationFrame(poll);
      const pads = navigator.getGamepads?.() ?? [];
      const p = pads.find((g) => g && g.connected);
      if (!p) return;
      const b = (i: number) => !!p.buttons[i]?.pressed;
      const ax = p.axes[0] ?? 0;
      const ay = p.axes[1] ?? 0;
      const state = [
        b(15) || ax > 0.5,
        b(14) || ax < -0.5,
        b(12) || ay < -0.5,
        b(13) || ay > 0.5,
        b(1),
        b(0),
        b(8),
        b(9),
      ];
      // Button.Right=0, Left=1, Up=2, Down=3, A=4, B=5, Select=6, Start=7, then L, R
      if (shoulders) state.push(b(4), b(5));
      state.forEach((v, i) => {
        if (v !== prev[i]) {
          session.press(i, v);
          prev[i] = v;
        }
      });
      const ff = shoulders ? b(7) : b(7) || b(5);
      if (ff && !ffPrev) session.cycleSpeed();
      ffPrev = ff;
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [session, shoulders]);
}

interface ControlsProps {
  session: Pad;
  speed: number;
  onMenu: () => void;
  onGrind?: () => void;
  /** Show L and R (GBA). */
  shoulders?: boolean;
  menuLabel?: string;
}

export function Controls({ session, speed, onMenu, onGrind, shoulders, menuLabel = 'Run' }: ControlsProps) {
  return (
    <div className="controls">
      {shoulders && (
        <div className="shoulders">
          <Key session={session} button={Shoulder.L} className="pill shoulder l" label="L" />
          <Key session={session} button={Shoulder.R} className="pill shoulder r" label="R" />
        </div>
      )}
      <DPad session={session} />
      <div className="ab">
        <Key session={session} button={Button.B} className="key b" label="B" />
        <Key session={session} button={Button.A} className="key a" label="A" />
      </div>
      <div className="pills">
        <Key session={session} button={Button.Select} className="pill" label="Select" />
        <Key session={session} button={Button.Start} className="pill" label="Start" />
        <button
          className={`pill ff${speed > 1 ? ' on' : ''}`}
          onClick={() => {
            session.cycleSpeed();
            buzz();
          }}
          aria-label={`Speed ${speed}x, tap to change`}
        >
          {speed > 1 ? `${speed}×` : '1×'}
        </button>
        {onGrind && (
          <button className="pill grind" onClick={onGrind} aria-label="Auto-grind: let Lockstep level up your lead">
            Grind
          </button>
        )}
        <button className="pill" onClick={onMenu} aria-label={menuLabel === 'Run' ? 'Open run panel' : 'Open menu'}>
          {menuLabel}
        </button>
      </div>
    </div>
  );
}

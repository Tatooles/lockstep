// Per-device UI preferences (best effort; storage may be unavailable).

export interface Prefs {
  palette: string;
  theme: 'system' | 'light' | 'dark';
  pauseOnSheet: boolean;
  haptics: boolean;
}

const DEFAULTS: Prefs = { palette: 'dusk', theme: 'system', pauseOnSheet: true, haptics: true };
const KEY = 'lockstep:prefs';

let current: Prefs = DEFAULTS;
try {
  const raw = localStorage.getItem(KEY);
  if (raw) current = { ...DEFAULTS, ...JSON.parse(raw) };
} catch {
  // ignore
}

const listeners = new Set<() => void>();

export const prefs = {
  get: (): Prefs => current,
  set(patch: Partial<Prefs>): void {
    current = { ...current, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      // ignore
    }
    if (patch.theme) applyTheme(patch.theme);
    for (const l of listeners) l();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function applyTheme(theme: Prefs['theme']): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

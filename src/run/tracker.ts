// The Nuzlocke tracker shared by the Game Boy and GBA sessions: feeds snapshots
// through the event differ and run engine, keeps toasts, and persists the run.

import { db } from '../platform/storage.ts';
import type { Dex } from './dex.ts';
import { applyEvent, liveWarnings, newRun, syncMons } from './engine.ts';
import { EventDiffer, type Snapshot } from './events.ts';
import { nextMilestone, type Milestone } from './milestones.ts';
import { DEFAULT_RULES, type Notice, type Rules, type Run } from './types.ts';

export { nextMilestone, type Milestone };

export interface ToastItem extends Notice {
  id: number;
  at: number;
}

export interface TrackerView {
  snap: Snapshot | null;
  run: Run | null;
  toasts: ToastItem[];
  warnings: string[];
  milestone: Milestone | null;
}

export interface TrackerOptions {
  /** Samples a wild battle start is held for while the intro plays (see EventDiffer). */
  wildStartDelay?: number;
  /** Notices to drop, e.g. info toasts while auto-grind plays. */
  mute?: (n: Notice) => boolean;
}

export class Tracker {
  readonly dex: Dex | null;
  readonly milestones: Milestone[];
  run: Run | null = null;
  snap: Snapshot | null = null;
  toasts: ToastItem[] = [];
  dirty = false;
  private readonly romKey: string;
  private readonly opts: TrackerOptions;
  private differ: EventDiffer;
  private toastId = 0;
  private shownOnce = new Set<string>();
  private saveTimer = 0;
  private readonly changed: () => void;

  constructor(dex: Dex | null, romKey: string, milestones: Milestone[], changed: () => void, opts: TrackerOptions = {}) {
    this.dex = dex;
    this.romKey = romKey;
    this.milestones = milestones;
    this.changed = changed;
    this.opts = opts;
    this.differ = this.makeDiffer();
  }

  private makeDiffer(): EventDiffer {
    const dex = this.dex;
    return new EventDiffer({ wildStartDelay: this.opts.wildStartDelay, isBall: dex ? (i) => dex.isBall(i) : undefined });
  }

  /** Load the ROM's active run, if any. */
  async restore(): Promise<void> {
    const id = await db.getKv<string>(`activeRun:${this.romKey}`);
    if (!id) return;
    const run = await db.getRun(id);
    if (run) this.attach(run);
  }

  view(): TrackerView {
    const cap = this.snap ? nextMilestone(this.milestones, this.snap.badges) : null;
    return {
      snap: this.snap,
      run: this.run,
      toasts: this.toasts,
      warnings: this.run && this.snap ? liveWarnings(this.run, this.snap, cap?.ace ?? null) : [],
      milestone: cap,
    };
  }

  /** Feed a snapshot. Returns true if anything happened worth re-rendering for. */
  observe(snap: Snapshot): boolean {
    if (!snap.valid) return false;
    this.snap = snap;
    const events = this.differ.update(snap);
    if (this.run && this.dex) {
      for (const ev of events) {
        for (const n of applyEvent(this.run, ev, { data: this.dex, snap })) this.toast(n);
        this.dirty = true;
      }
      syncMons(this.run, snap, this.dex);
      if (events.length) this.scheduleSave();
    }
    return events.length > 0;
  }

  /** After a reset or state load the game jumps: start diffing afresh, keeping known Pokémon. */
  resync(): void {
    this.differ.reset();
    this.differ.seedKnown(Object.keys(this.run?.mons ?? {}));
  }

  // ---- toasts ----
  toast(n: Notice): void {
    if (this.opts.mute?.(n)) return;
    if (n.once) {
      if (this.shownOnce.has(n.title)) return;
      this.shownOnce.add(n.title);
    }
    const now = performance.now();
    // A repeat of a toast still on screen replaces it rather than stacking.
    const rest = this.toasts.filter((t) => t.title !== n.title || t.body !== n.body);
    this.toasts = [...rest, { ...n, id: ++this.toastId, at: now }].slice(-3);
    if ((n.tone === 'bad' || n.tone === 'good') && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate?.(n.tone === 'bad' ? [40, 60, 40] : 20);
    }
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  expireToasts(now: number): void {
    const keep = this.toasts.filter((t) => now - t.at < (t.tone === 'bad' ? 7000 : 4500));
    if (keep.length !== this.toasts.length) this.toasts = keep;
  }

  // ---- runs ----
  private attach(run: Run): void {
    run.rules = { ...DEFAULT_RULES, ...run.rules };
    this.run = run;
    this.differ = this.makeDiffer();
    this.differ.seedKnown(Object.keys(run.mons));
  }

  async startRun(name: string, rules: Partial<Rules>): Promise<Run> {
    const run = newRun({ name, romKey: this.romKey, version: this.dex?.version ?? 'unknown', rules });
    this.attach(run);
    await db.putRun(run);
    await db.putKv(`activeRun:${this.romKey}`, run.id);
    this.changed();
    return run;
  }

  async endRun(): Promise<void> {
    if (!this.run) return;
    await db.putRun(this.run);
    await db.putKv(`activeRun:${this.romKey}`, null);
    this.run = null;
    this.differ = this.makeDiffer();
    this.changed();
  }

  /** Apply a manual change to the run (from the UI) and persist it. */
  updateRun(mut: (run: Run) => void): void {
    if (!this.run) return;
    mut(this.run);
    this.run.updatedAt = Date.now();
    this.scheduleSave();
    this.changed();
  }

  private scheduleSave(): void {
    if (this.saveTimer || typeof window === 'undefined') return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      void this.save();
    }, 800);
  }

  async save(): Promise<void> {
    if (!this.run) return;
    this.dirty = false;
    await db.putRun(this.run);
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
  }
}

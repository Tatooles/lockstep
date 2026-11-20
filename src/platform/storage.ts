// Minimal IndexedDB wrapper. Everything stays on the device.

import type { SaveState } from '../core/gameboy.ts';
import type { Run } from '../run/types.ts';

const DB_NAME = 'lockstep';
const DB_VERSION = 1;
const STORES = ['roms', 'sram', 'states', 'runs', 'kv'] as const;
type StoreName = (typeof STORES)[number];

export interface RomRecord {
  key: string;
  name: string;
  title: string;
  version: string | null;
  /** Absent for Game Boy games (records from before GBA support). */
  system?: 'gba';
  size: number;
  addedAt: number;
  lastPlayedAt: number;
  data: Uint8Array;
}

/** A save state: SaveState for Game Boy games, the core's bytes (src/gba/gba.ts) for GBA games. */
export interface StateRecord<S = SaveState> {
  key: string; // `${romKey}:${slot}`
  romKey: string;
  slot: string; // 'resume' | '1' | '2' | '3'
  savedAt: number;
  state: S;
  thumb?: Uint8Array; // GB: 160x144 shade indices; GBA: 120x80 RGBA
  runId?: string | null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: s === 'kv' || s === 'sram' ? undefined : 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const db = {
  getRom: (key: string) => tx<RomRecord | undefined>('roms', 'readonly', (s) => s.get(key)),
  putRom: (r: RomRecord) => tx('roms', 'readwrite', (s) => s.put(r)),
  deleteRom: (key: string) => tx('roms', 'readwrite', (s) => s.delete(key)),
  listRoms: () => tx<RomRecord[]>('roms', 'readonly', (s) => s.getAll()),

  getSram: (romKey: string) => tx<Uint8Array | undefined>('sram', 'readonly', (s) => s.get(romKey)),
  putSram: (romKey: string, data: Uint8Array) => tx('sram', 'readwrite', (s) => s.put(data, romKey)),

  getState: <S = SaveState>(romKey: string, slot: string) => tx<StateRecord<S> | undefined>('states', 'readonly', (s) => s.get(`${romKey}:${slot}`)),
  putState: (r: StateRecord<SaveState | Uint8Array>) => tx('states', 'readwrite', (s) => s.put(r)),
  deleteState: (romKey: string, slot: string) => tx('states', 'readwrite', (s) => s.delete(`${romKey}:${slot}`)),
  listStates: async <S = SaveState>(romKey: string) => {
    const all = await tx<StateRecord<S>[]>('states', 'readonly', (s) => s.getAll());
    return all.filter((r) => r.romKey === romKey);
  },

  getRun: (id: string) => tx<(Run & { key: string }) | undefined>('runs', 'readonly', (s) => s.get(id)),
  putRun: (r: Run) => tx('runs', 'readwrite', (s) => s.put({ ...r, key: r.id })),
  deleteRun: (id: string) => tx('runs', 'readwrite', (s) => s.delete(id)),
  listRuns: () => tx<Run[]>('runs', 'readonly', (s) => s.getAll()),

  getKv: <T>(k: string) => tx<T | undefined>('kv', 'readonly', (s) => s.get(k)),
  putKv: (k: string, v: unknown) => tx('kv', 'readwrite', (s) => s.put(v, k)),
};

export async function romKeyFor(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', data as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(buf).slice(0, 10), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Ask the browser not to evict our data (best effort). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

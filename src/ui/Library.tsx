import { useEffect, useRef, useState } from 'react';
import { parseHeader } from '../core/header.ts';
import { GBA_MAX_ROM, isGbaRom, parseGbaHeader } from '../gba/header.ts';
import { detectGen3 } from '../gen3/rom.ts';
import { detectVersion } from '../gen1/rom.ts';
import { db, requestPersistence, romKeyFor, type RomRecord } from '../platform/storage.ts';

const VERSION_LABEL: Record<string, string> = {
  red: 'Red version',
  blue: 'Blue version',
  yellow: 'Yellow version',
  ruby: 'Ruby version',
  sapphire: 'Sapphire version',
  emerald: 'Emerald version',
  firered: 'FireRed version',
  leafgreen: 'LeafGreen version',
};

function relTime(t: number): string {
  const d = Date.now() - t;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  return new Date(t).toLocaleDateString();
}

export function Library({ onOpen, opening, error }: { onOpen: (r: RomRecord) => void; opening: boolean; error: string | null }) {
  const [roms, setRoms] = useState<RomRecord[] | null>(null);
  const [over, setOver] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const list = await db.listRoms();
    list.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
    setRoms(list);
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Show whichever message is newer: a failed open replaces the import notice.
  useEffect(() => {
    if (error) setMsg(null);
  }, [error]);

  const save = async (rec: RomRecord) => {
    const existing = await db.getRom(rec.key);
    await db.putRom({ ...rec, addedAt: existing?.addedAt ?? rec.addedAt });
    void requestPersistence();
    await refresh();
  };

  const addGba = async (file: File) => {
    if (file.size > GBA_MAX_ROM) {
      setMsg('That file is too big to be a Game Boy Advance ROM.');
      return;
    }
    const data = new Uint8Array(await file.arrayBuffer());
    if (!isGbaRom(data)) {
      setMsg("That file doesn't look like a Game Boy Advance ROM.");
      return;
    }
    const rec: RomRecord = {
      key: await romKeyFor(data),
      name: file.name.replace(/\.(gba|agb|bin)$/i, ''),
      title: parseGbaHeader(data).title,
      version: detectGen3(data)?.version ?? null,
      system: 'gba',
      size: data.length,
      addedAt: Date.now(),
      lastPlayedAt: Date.now(),
      data,
    };
    await save(rec);
    if (!rec.version) setMsg('Added. Nuzlocke tracking needs an English Pokémon Ruby, Sapphire, Emerald, FireRed or LeafGreen ROM, but this game will still play.');
    onOpen(rec);
  };

  const addFile = async (file: File) => {
    setMsg(null);
    // By extension, or by header for files named otherwise (e.g. .bin).
    if (/\.(gba|agb)$/i.test(file.name) || isGbaRom(new Uint8Array(await file.slice(0, 0xc0).arrayBuffer()))) {
      await addGba(file);
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setMsg('That file is too big to be a Game Boy ROM.');
      return;
    }
    const data = new Uint8Array(await file.arrayBuffer());
    let header;
    try {
      header = parseHeader(data);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Not a Game Boy ROM.');
      return;
    }
    if (header.mbc === 'unknown') {
      setMsg(`This cartridge type (0x${header.cartType.toString(16)}) isn't supported yet.`);
      return;
    }
    const version = detectVersion(data);
    const rec: RomRecord = {
      key: await romKeyFor(data),
      name: file.name.replace(/\.(gbc?|zip)$/i, ''),
      title: header.title,
      version,
      size: data.length,
      addedAt: Date.now(),
      lastPlayedAt: Date.now(),
      data,
    };
    await save(rec);
    if (!version) setMsg('Added. Nuzlocke tracking needs an English Pokémon Red, Blue or Yellow ROM, but this game will still play.');
    onOpen(rec);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void addFile(f);
    e.target.value = '';
  };

  const remove = async (r: RomRecord) => {
    if (!confirm(`Remove ${r.name} from this device? Its in-game save and save states stay unless you clear site data.`)) return;
    await db.deleteRom(r.key);
    await refresh();
  };

  return (
    <main className="library">
      <h1 className="wordmark">
        Lockstep<span aria-hidden="true" />
      </h1>
      <p className="tagline">A Game Boy that keeps your Nuzlocke honest. Every encounter, catch and loss is logged as you play.</p>

      <label
        className={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) void addFile(f);
        }}
      >
        <strong>{opening ? 'Opening…' : 'Load a ROM'}</strong>
        <small>Pick a .gb or .gba file you dumped from your own cartridge. It stays on this device and is never uploaded.</small>
        <input ref={input} type="file" className="sr-only" onChange={onPick} />
      </label>
      {(msg || error) && <div className="error">{msg ?? error}</div>}

      {roms && roms.length > 0 && (
        <ul className="rom-list">
          {roms.map((r) => (
            <li key={r.key} className="rom">
              <div>
                <h3>{r.name}</h3>
                <p>
                  {r.version ? VERSION_LABEL[r.version] : r.system === 'gba' ? 'Game Boy Advance' : r.title || 'Game Boy game'}, played {relTime(r.lastPlayedAt)}
                </p>
              </div>
              <div className="actions">
                <button className="btn ghost" onClick={() => void remove(r)} aria-label={`Remove ${r.name}`}>
                  Remove
                </button>
                <button className="btn primary" onClick={() => onOpen(r)} disabled={opening}>
                  Play
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="notice">
        Tracking works with English Pokémon Red, Blue and Yellow. Add Lockstep to your home screen for full-screen play and
        offline use. Saves, save states and runs are stored in this browser only.
      </p>
    </main>
  );
}

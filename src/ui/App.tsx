import { useEffect, useState } from 'react';
import { GbaSession } from '../gba/session.ts';
import { Session } from '../platform/session.ts';
import { db, type RomRecord } from '../platform/storage.ts';
import { GbaPlay } from './GbaPlay.tsx';
import { Library } from './Library.tsx';
import { Play } from './Play.tsx';

export function App() {
  const [session, setSession] = useState<Session | GbaSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const open = async (rom: RomRecord) => {
    setOpening(true);
    setError(null);
    try {
      const full = rom.data ? rom : await db.getRom(rom.key);
      if (!full) throw new Error('That game is no longer on this device.');
      setSession(full.system === 'gba' ? await GbaSession.open(full) : await Session.open(full));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  };

  const close = async () => {
    if (session) await session.destroy();
    setSession(null);
  };

  useEffect(() => {
    if (!session) document.title = 'Lockstep';
  }, [session]);

  if (session instanceof GbaSession) return <GbaPlay session={session} onExit={close} />;
  if (session) return <Play session={session} onExit={close} />;
  return <Library onOpen={open} opening={opening} error={error} />;
}

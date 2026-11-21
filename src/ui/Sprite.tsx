import { useMemo } from 'react';
import type { Dex } from '../run/dex.ts';

export function Sprite({ data, species, alt, className }: { data: Dex | null; species: number; alt?: string; className?: string }) {
  const url = useMemo(() => (data ? data.spriteUrl(species) : null), [data, species]);
  if (!url) return <span className={className} style={{ display: 'inline-block', width: 1 }} aria-hidden="true" />;
  return <img src={url} alt={alt ?? data?.speciesName(species) ?? ''} className={className} draggable={false} />;
}

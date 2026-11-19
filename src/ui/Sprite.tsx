import { useMemo } from 'react';
import type { Gen1Data } from '../gen1/rom.ts';
import { spriteUrl } from './sprites.ts';

export function Sprite({ data, species, alt, className }: { data: Gen1Data | null; species: number; alt?: string; className?: string }) {
  const url = useMemo(() => (data ? spriteUrl(data, species) : null), [data, species]);
  if (!url) return <span className={className} style={{ display: 'inline-block', width: 1 }} aria-hidden="true" />;
  return <img src={url} alt={alt ?? data?.speciesName(species) ?? ''} className={className} draggable={false} />;
}

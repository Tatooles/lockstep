import { decompressPic, picToPixels } from '../gen1/pic.ts';
import type { Gen1Data } from '../gen1/rom.ts';

const cache = new Map<string, string>();

// Sprite inks: color 0 is transparent; the rest use the UI's ink ramp.
const INKS: [number, number, number][] = [
  [0, 0, 0],
  [176, 166, 196],
  [96, 82, 122],
  [36, 28, 50],
];

export function spriteUrl(data: Gen1Data, speciesIndex: number): string | null {
  const key = `${data.version}:${speciesIndex}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit || null;
  const sp = data.species.get(speciesIndex);
  if (!sp || typeof document === 'undefined') return null;
  try {
    const offset = sp.picBank * 0x4000 + (sp.picPtr - 0x4000);
    const pic = decompressPic(data.rom, offset);
    const { size, pixels } = picToPixels(pic);
    // Center inside a 56x56 box, bottom-aligned like the game does.
    const box = 56;
    const canvas = document.createElement('canvas');
    canvas.width = box;
    canvas.height = box;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(box, box);
    const ox = Math.floor((box - size) / 2);
    const oy = box - size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c = pixels[y * size + x];
        if (c === 0) continue;
        const i = ((oy + y) * box + ox + x) * 4;
        const [r, g, b] = INKS[c];
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const url = canvas.toDataURL('image/png');
    cache.set(key, url);
    return url;
  } catch (err) {
    console.warn('sprite decode failed', speciesIndex, err);
    cache.set(key, '');
    return null;
  }
}

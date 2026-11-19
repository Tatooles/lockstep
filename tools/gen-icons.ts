// Draws the app icon as pixel art and writes PNG/SVG variants into public/.
//   node tools/gen-icons.ts

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const PUB = join(import.meta.dirname, '..', 'public');

// 16x16 glyph: a padlock whose body is a little LCD with a check mark.
// . = background, k = ink, s = screen, c = check
const GLYPH = [
  '................',
  '......kkkk......',
  '.....kk..kk.....',
  '....kk....kk....',
  '....k......k....',
  '....k......k....',
  '..kkkkkkkkkkkk..',
  '..kssssssssssk..',
  '..ksssssssscsk..',
  '..kssssssscssk..',
  '..kscsssscsssk..',
  '..ksscsscssssk..',
  '..ksssccsssssk..',
  '..kssssssssssk..',
  '..kkkkkkkkkkkk..',
  '................',
];

const COLORS: Record<string, [number, number, number]> = {
  '.': [0xd9, 0xd3, 0xe3],
  k: [0x24, 0x1a, 0x33],
  s: [0xb9, 0xe0, 0xd4],
  c: [0x1f, 0x7a, 0x6e],
};

function draw(size: number, padFrac: number): PNG {
  const png = new PNG({ width: size, height: size });
  const bg = COLORS['.'];
  for (let i = 0; i < size * size; i++) {
    png.data[i * 4] = bg[0];
    png.data[i * 4 + 1] = bg[1];
    png.data[i * 4 + 2] = bg[2];
    png.data[i * 4 + 3] = 255;
  }
  const inner = Math.floor(size * (1 - padFrac * 2));
  const cell = Math.floor(inner / 16);
  const off = Math.floor((size - cell * 16) / 2);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const col = COLORS[GLYPH[y][x]];
      for (let dy = 0; dy < cell; dy++)
        for (let dx = 0; dx < cell; dx++) {
          const px = off + x * cell + dx;
          const py = off + y * cell + dy;
          const i = (py * size + px) * 4;
          png.data[i] = col[0];
          png.data[i + 1] = col[1];
          png.data[i + 2] = col[2];
        }
    }
  return png;
}

writeFileSync(join(PUB, 'icon-192.png'), PNG.sync.write(draw(192, 0.08)));
writeFileSync(join(PUB, 'icon-512.png'), PNG.sync.write(draw(512, 0.08)));
writeFileSync(join(PUB, 'icon-512-maskable.png'), PNG.sync.write(draw(512, 0.18)));
writeFileSync(join(PUB, 'apple-touch-icon.png'), PNG.sync.write(draw(180, 0.1)));

let rects = '';
for (let y = 0; y < 16; y++)
  for (let x = 0; x < 16; x++) {
    const ch = GLYPH[y][x];
    if (ch === '.') continue;
    const [r, g, b] = COLORS[ch];
    rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="rgb(${r},${g},${b})"/>`;
  }
writeFileSync(
  join(PUB, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 18 18" shape-rendering="crispEdges"><rect x="-1" y="-1" width="18" height="18" rx="3" fill="#d9d3e3"/>${rects}</svg>\n`,
);
console.log('icons written');

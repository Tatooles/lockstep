// Verifies src/gen1/pic.ts against pret's reference compressor (vendor-data/pictest).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { decompressPic } from '../src/gen1/pic.ts';

const dir = join(import.meta.dirname, '..', 'vendor-data', 'pictest');
let ok = 0;
for (const name of ['bulbasaur', 'mew', 'charizard']) {
  const png = PNG.sync.read(readFileSync(join(dir, `${name}.png`)));
  const w = png.width / 8;
  const tiles = new Uint8Array(w * w * 16);
  for (let ty = 0; ty < w; ty++)
    for (let tx = 0; tx < w; tx++)
      for (let r = 0; r < 8; r++) {
        let lo = 0;
        let hi = 0;
        for (let b = 0; b < 8; b++) {
          const g = png.data[((ty * 8 + r) * png.width + tx * 8 + b) * 4];
          const c = 3 - Math.round(g / 85);
          lo |= (c & 1) << (7 - b);
          hi |= ((c >> 1) & 1) << (7 - b);
        }
        const t = ty * w + tx;
        tiles[t * 16 + r * 2] = lo;
        tiles[t * 16 + r * 2 + 1] = hi;
      }
  writeFileSync(join(dir, `${name}.2bpp`), tiles);
  execFileSync(join(dir, 'pkmncompress'), [join(dir, `${name}.2bpp`), join(dir, `${name}.pic`)]);
  const pic = new Uint8Array(readFileSync(join(dir, `${name}.pic`)));
  const dec = decompressPic(pic, 0);
  const same = dec.tiles.length === tiles.length && dec.tiles.every((v, i) => v === tiles[i]);
  console.log(`${same ? 'OK  ' : 'FAIL'} ${name} (${w}x${w} tiles, ${pic.length} bytes compressed)`);
  if (same) ok++;
}
process.exit(ok === 3 ? 0 : 1);

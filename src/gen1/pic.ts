// Gen 1 Pokémon pic decompression, ported from pret's tools/pkmncompress.c.
// Input: compressed pic starting with its dimension byte. Output: 2bpp tiles,
// row-major, width*width tiles of 16 bytes.

class BitReader {
  private data: Uint8Array;
  private byte: number;
  private bit = 7;

  constructor(data: Uint8Array, offset: number) {
    this.data = data;
    this.byte = offset;
  }

  readBit(): number {
    if (this.bit === -1) {
      this.byte++;
      this.bit = 7;
    }
    return (this.data[this.byte] >> this.bit--) & 1;
  }

  readInt(count: number): number {
    let n = 0;
    while (count--) n = (n << 1) | this.readBit();
    return n;
  }
}

const RLE_TABLE = [
  0x0001, 0x0003, 0x0007, 0x000f, 0x001f, 0x003f, 0x007f, 0x00ff,
  0x01ff, 0x03ff, 0x07ff, 0x0fff, 0x1fff, 0x3fff, 0x7fff, 0xffff,
];

const CODES = [
  [0x0, 0x1, 0x3, 0x2, 0x7, 0x6, 0x4, 0x5, 0xf, 0xe, 0xc, 0xd, 0x8, 0x9, 0xb, 0xa],
  [0xf, 0xe, 0xc, 0xd, 0x8, 0x9, 0xb, 0xa, 0x0, 0x1, 0x3, 0x2, 0x7, 0x6, 0x4, 0x5],
];

function fillPlane(r: BitReader, width: number): Uint8Array {
  let mode = r.readBit();
  const size = width * width * 0x20;
  const plane = new Uint8Array(size);
  let len = 0;
  while (len < size) {
    if (mode) {
      while (len < size) {
        const g = r.readInt(2);
        if (!g) break;
        plane[len++] = g;
      }
    } else {
      let w = 0;
      while (r.readBit()) {
        w++;
        if (w >= RLE_TABLE.length) throw new Error('Invalid compressed pic data');
      }
      let n = RLE_TABLE[w] + r.readInt(w + 1);
      while (len < size && n--) plane[len++] = 0;
    }
    mode ^= 1;
  }
  const ram = new Uint8Array(size);
  len = 0;
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width * 8; x++) {
      for (let i = 0; i < 4; i++) ram[len++] = plane[(y * 4 + i) * width * 8 + x];
    }
  }
  const out = new Uint8Array(size / 4);
  for (let i = 0; i < size - 3; i += 4) {
    out[i / 4] = (ram[i] << 6) | (ram[i + 1] << 4) | (ram[i + 2] << 2) | ram[i + 3];
  }
  return out;
}

function uncompressPlane(plane: Uint8Array, width: number): void {
  for (let x = 0; x < width * 8; x++) {
    let bit = 0;
    for (let y = 0; y < width; y++) {
      const i = y * width * 8 + x;
      const hi = CODES[bit][(plane[i] >> 4) & 0xf];
      bit = hi & 1;
      const lo = CODES[bit][plane[i] & 0xf];
      bit = lo & 1;
      plane[i] = (hi << 4) | lo;
    }
  }
}

function transposeTiles(data: Uint8Array, width: number): void {
  const size = width * width;
  const tmp = new Uint8Array(16);
  for (let i = 0; i < size; i++) {
    const j = (i * width + Math.floor(i / width)) % size;
    if (i < j) {
      tmp.set(data.subarray(i * 16, i * 16 + 16));
      data.copyWithin(i * 16, j * 16, j * 16 + 16);
      data.set(tmp, j * 16);
    }
  }
}

export interface DecodedPic {
  width: number; // tiles
  tiles: Uint8Array; // 2bpp, row-major tiles
}

export function decompressPic(data: Uint8Array, offset: number): DecodedPic {
  const r = new BitReader(data, offset);
  const width = r.readInt(4);
  const height = r.readInt(4);
  if (width !== height || width < 1 || width > 15) throw new Error('Unsupported pic dimensions');
  const size = width * width * 8;
  const rams: Uint8Array[] = [new Uint8Array(0), new Uint8Array(0)];
  const order = r.readBit();
  rams[order] = fillPlane(r, width);
  let mode = r.readBit();
  if (mode) mode += r.readBit();
  rams[order ^ 1] = fillPlane(r, width);
  uncompressPlane(rams[order], width);
  if (mode !== 1) uncompressPlane(rams[order ^ 1], width);
  if (mode !== 0) {
    for (let i = 0; i < size; i++) rams[order ^ 1][i] ^= rams[order][i];
  }
  const out = new Uint8Array(size * 2);
  for (let i = 0; i < size; i++) {
    out[i * 2] = rams[0][i];
    out[i * 2 + 1] = rams[1][i];
  }
  transposeTiles(out, width);
  return { width, tiles: out };
}

/** Convert decoded tiles to a 2-bit color index per pixel (row-major). */
export function picToPixels(pic: DecodedPic): { size: number; pixels: Uint8Array } {
  const w = pic.width;
  const size = w * 8;
  const px = new Uint8Array(size * size);
  for (let t = 0; t < w * w; t++) {
    const tr = Math.floor(t / w);
    const tc = t % w;
    for (let row = 0; row < 8; row++) {
      const lo = pic.tiles[t * 16 + row * 2];
      const hi = pic.tiles[t * 16 + row * 2 + 1];
      for (let b = 0; b < 8; b++) {
        const c = (((hi >> (7 - b)) & 1) << 1) | ((lo >> (7 - b)) & 1);
        px[(tr * 8 + row) * size + tc * 8 + b] = c;
      }
    }
  }
  return { size, pixels: px };
}

// GBA graphics helpers: LZ77 (BIOS type 0x10) decompression and 4bpp tile decoding.

/** Decompress LZ77 data as the BIOS LZ77UnComp does. */
export function lz77(src: Uint8Array, offset: number): Uint8Array {
  if (src[offset] !== 0x10) throw new Error('not LZ77 data');
  const size = src[offset + 1] | (src[offset + 2] << 8) | (src[offset + 3] << 16);
  const out = new Uint8Array(size);
  let s = offset + 4;
  let d = 0;
  while (d < size) {
    const flags = src[s++];
    for (let bit = 7; bit >= 0 && d < size; bit--) {
      if (flags & (1 << bit)) {
        const b1 = src[s++];
        const b2 = src[s++];
        const len = (b1 >> 4) + 3;
        const disp = (((b1 & 0xf) << 8) | b2) + 1;
        for (let i = 0; i < len && d < size; i++, d++) out[d] = out[d - disp];
      } else {
        out[d++] = src[s++];
      }
    }
  }
  return out;
}

/** BGR555 colors to [r, g, b] triples. */
export function palette(bytes: Uint8Array, count = 16): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    const c = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    const ch = (v: number) => (v << 3) | (v >> 2);
    out.push([ch(c & 31), ch((c >> 5) & 31), ch((c >> 10) & 31)]);
  }
  return out;
}

/** 4bpp tiles laid out row-major in a `w`×`h` pixel image → palette indices. */
export function tiles4bpp(data: Uint8Array, w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h);
  const tw = w / 8;
  for (let t = 0; t < tw * (h / 8); t++) {
    const tx = (t % tw) * 8;
    const ty = Math.floor(t / tw) * 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x += 2) {
        const b = data[t * 32 + y * 4 + x / 2] ?? 0;
        px[(ty + y) * w + tx + x] = b & 0xf;
        px[(ty + y) * w + tx + x + 1] = b >> 4;
      }
    }
  }
  return px;
}

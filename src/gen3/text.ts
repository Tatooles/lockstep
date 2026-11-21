// Gen 3 (English) text encoding, from the decompilations' charmap.txt.

const CHARS: Record<number, string> = {
  0x00: ' ', 0x01: 'À', 0x02: 'Á', 0x03: 'Â', 0x04: 'Ç', 0x05: 'È', 0x06: 'É', 0x07: 'Ê', 0x08: 'Ë', 0x09: 'Ì',
  0x0b: 'Î', 0x0c: 'Ï', 0x0d: 'Ò', 0x0e: 'Ó', 0x0f: 'Ô', 0x10: 'Œ', 0x11: 'Ù', 0x12: 'Ú', 0x13: 'Û', 0x14: 'Ñ',
  0x15: 'ß', 0x16: 'à', 0x17: 'á', 0x19: 'ç', 0x1a: 'è', 0x1b: 'é', 0x1c: 'ê', 0x1d: 'ë', 0x1e: 'ì', 0x20: 'î',
  0x21: 'ï', 0x22: 'ò', 0x23: 'ó', 0x24: 'ô', 0x25: 'œ', 0x26: 'ù', 0x27: 'ú', 0x28: 'û', 0x29: 'ñ', 0x2a: 'º',
  0x2b: 'ª', 0x2d: '&', 0x2e: '+', 0x34: 'Lv', 0x35: '=', 0x36: ';', 0x51: '¿', 0x52: '¡', 0x5a: 'Í', 0x5b: '%',
  0x5c: '(', 0x5d: ')', 0x68: 'â', 0x6f: 'í', 0x85: '<', 0x86: '>', 0xab: '!', 0xac: '?', 0xad: '.', 0xae: '-',
  0xaf: '·', 0xb0: '…', 0xb1: '“', 0xb2: '”', 0xb3: '‘', 0xb4: '’', 0xb5: '♂', 0xb6: '♀', 0xb7: '¥', 0xb8: ',',
  0xb9: '×', 0xba: '/', 0xf0: ':', 0xf1: 'Ä', 0xf2: 'Ö', 0xf3: 'Ü', 0xf4: 'ä', 0xf5: 'ö', 0xf6: 'ü',
};
for (let i = 0; i < 10; i++) CHARS[0xa1 + i] = String(i);
for (let i = 0; i < 26; i++) {
  CHARS[0xbb + i] = String.fromCharCode(65 + i);
  CHARS[0xd5 + i] = String.fromCharCode(97 + i);
}

/** Decode up to `max` bytes, stopping at the 0xFF terminator (or a control code). */
export function decodeText(bytes: ArrayLike<number>, start = 0, max = 64): string {
  let s = '';
  for (let i = 0; i < max; i++) {
    const b = bytes[start + i];
    if (b === undefined || b === 0xff || b >= 0xfa) break;
    s += CHARS[b] ?? '';
  }
  return s.trimEnd();
}

// Words that stay as written when names are title-cased.
const KEEP = new Set(['TV', 'S.S.', 'HM', 'TM', 'PP', 'HP', 'SS', 'II', 'XI', 'TECH']);

/** "ROUTE 101" → "Route 101", "MT. PYRE" → "Mt. Pyre", "POKéMON" → "Pokémon". */
export function prettyName(s: string): string {
  return s
    .split(' ')
    .map((w) => {
      if (KEEP.has(w) || !/[A-Z]/.test(w)) return w;
      return w
        .split('-')
        .map((p) => (p.length ? p[0] + p.slice(1).toLowerCase() : p))
        .join('-');
    })
    .join(' ')
    .replace(/Pokémon|Pokemon|Poké/gi, (m) => (m.length === 4 ? 'Poké' : 'Pokémon'));
}

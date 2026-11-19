// Gen 1 (English) character encoding.

const TABLE: Record<number, string> = {
  0x4a: 'PkMn', 0x54: 'POKé', 0x5b: 'PC', 0x5c: 'TM', 0x5d: 'TRAINER', 0x5e: 'ROCKET',
  0x70: '‘', 0x71: '’', 0x72: '“', 0x73: '”', 0x75: '…', 0x7f: ' ',
  0x9a: '(', 0x9b: ')', 0x9c: ':', 0x9d: ';', 0x9e: '[', 0x9f: ']',
  0xba: 'é', 0xbb: "'d", 0xbc: "'l", 0xbd: "'s", 0xbe: "'t", 0xbf: "'v",
  0xe0: "'", 0xe1: 'Pk', 0xe2: 'Mn', 0xe3: '-', 0xe4: "'r", 0xe5: "'m", 0xe6: '?', 0xe7: '!', 0xe8: '.',
  0xef: '♂', 0xf0: '¥', 0xf1: '×', 0xf2: '.', 0xf3: '/', 0xf4: ',', 0xf5: '♀',
};
for (let i = 0; i < 26; i++) {
  TABLE[0x80 + i] = String.fromCharCode(65 + i);
  TABLE[0xa0 + i] = String.fromCharCode(97 + i);
}
for (let i = 0; i < 10; i++) TABLE[0xf6 + i] = String(i);

export const TERMINATOR = 0x50;

/** Decode a 0x50-terminated string starting at `offset` (max `max` bytes). */
export function decodeText(bytes: ArrayLike<number>, offset: number, max = 64): string {
  let s = '';
  for (let i = 0; i < max; i++) {
    const c = bytes[offset + i];
    if (c === TERMINATOR || c === undefined) break;
    s += TABLE[c] ?? '';
  }
  return s;
}

/** Decode and return [string, bytesConsumedIncludingTerminator]. */
export function decodeTextLen(bytes: ArrayLike<number>, offset: number, max = 64): [string, number] {
  let s = '';
  for (let i = 0; i < max; i++) {
    const c = bytes[offset + i];
    if (c === TERMINATOR || c === undefined) return [s, i + 1];
    s += TABLE[c] ?? '';
  }
  return [s, max];
}

/** Title-case an all-caps game name for display ("NIDORAN♂" -> "Nidoran♂", "MR.MIME" -> "Mr. Mime"). */
export function prettyName(s: string): string {
  const special: Record<string, string> = {
    'MR.MIME': 'Mr. Mime', "FARFETCH'D": "Farfetch'd", 'POKé BALL': 'Poké Ball', 'S.S.TICKET': 'S.S. Ticket',
  };
  if (special[s]) return special[s];
  return s
    .toLowerCase()
    .replace(/(^|[\s\-.(])([a-zé])/g, (_m, p: string, c: string) => p + c.toUpperCase())
    .replace(/Poké/g, 'Poké')
    .replace(/\bHp\b/g, 'HP')
    .replace(/\bPp\b/g, 'PP')
    .replace(/\bTm(\d)/g, 'TM$1')
    .replace(/\bHm(\d)/g, 'HM$1');
}

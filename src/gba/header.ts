// Game Boy Advance cartridge header (0xA0..0xBF).

export interface GbaHeader {
  /** Up to 12 ASCII characters, e.g. "POKEMON EMER". */
  title: string;
  /** Four-character game code, e.g. "BPEE". */
  code: string;
  version: number;
}

/** GBA ROMs are at most 32 MB. */
export const GBA_MAX_ROM = 32 * 1024 * 1024;

function ascii(rom: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) {
    const c = rom[i];
    if (c < 0x20 || c > 0x7e) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/** True if `rom` has a GBA header: the fixed 0x96 byte and a valid header checksum. */
export function isGbaRom(rom: Uint8Array): boolean {
  if (rom.length < 0xc0 || rom[0xb2] !== 0x96) return false;
  let sum = 0;
  for (let i = 0xa0; i <= 0xbc; i++) sum += rom[i];
  return ((-(sum + 0x19)) & 0xff) === rom[0xbd];
}

export function parseGbaHeader(rom: Uint8Array): GbaHeader {
  if (rom.length < 0xc0) throw new Error('ROM is too small to be a Game Boy Advance ROM');
  return { title: ascii(rom, 0xa0, 0xac), code: ascii(rom, 0xac, 0xb0), version: rom[0xbc] };
}

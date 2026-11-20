// Cartridge header parsing (the emulation itself lives in the Rust core, wasm-core/).

export interface CartHeader {
  title: string;
  cartType: number;
  romBanks: number;
  ramSize: number;
  cgbFlag: number;
  globalChecksum: number;
  headerChecksum: number;
  version: number;
  hasBattery: boolean;
  mbc: 'none' | 'mbc1' | 'mbc2' | 'mbc3' | 'mbc5' | 'unknown';
}

const RAM_SIZES = [0, 0x800, 0x2000, 0x8000, 0x20000, 0x10000];

export function parseHeader(rom: Uint8Array): CartHeader {
  if (rom.length < 0x150) throw new Error('ROM is too small to be a Game Boy ROM');
  let title = '';
  for (let i = 0x134; i < 0x144; i++) {
    const c = rom[i];
    if (c === 0) break;
    if (c < 0x20 || c > 0x7e) break;
    title += String.fromCharCode(c);
  }
  const cartType = rom[0x147];
  let mbc: CartHeader['mbc'] = 'unknown';
  if (cartType === 0x00 || cartType === 0x08 || cartType === 0x09) mbc = 'none';
  else if (cartType >= 0x01 && cartType <= 0x03) mbc = 'mbc1';
  else if (cartType === 0x05 || cartType === 0x06) mbc = 'mbc2';
  else if (cartType >= 0x0f && cartType <= 0x13) mbc = 'mbc3';
  else if (cartType >= 0x19 && cartType <= 0x1e) mbc = 'mbc5';
  const hasBattery = [0x03, 0x06, 0x09, 0x0d, 0x0f, 0x10, 0x13, 0x1b, 0x1e, 0x22, 0xff].includes(cartType);
  let ramSize = RAM_SIZES[rom[0x149]] ?? 0;
  if (mbc === 'mbc2') ramSize = 512;
  return {
    title,
    cartType,
    romBanks: Math.max(2, 2 << rom[0x148]),
    ramSize,
    cgbFlag: rom[0x143],
    globalChecksum: (rom[0x14e] << 8) | rom[0x14f],
    headerChecksum: rom[0x14d],
    version: rom[0x14c],
    hasBattery,
    mbc,
  };
}

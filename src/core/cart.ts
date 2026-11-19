// Cartridge + memory bank controllers (MBC1, MBC2, MBC3 w/ RTC, MBC5).

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

export interface CartState {
  ram: Uint8Array;
  regs: number[];
  rtc?: number[];
}

export class Cartridge {
  readonly header: CartHeader;
  readonly rom: Uint8Array;
  ram: Uint8Array;
  /** Set whenever battery RAM is written; the host clears it after persisting. */
  ramDirty = false;
  private romMask: number;
  private ramEnabled = false;
  private romBank = 1;
  private bank2 = 0; // MBC1 upper bits / MBC3+5 RAM bank
  private mode = 0; // MBC1 banking mode
  private romBank0Offset = 0;
  private romBankOffset = 0x4000;
  private ramOffset = 0;
  // MBC3 RTC: live registers derived from a base timestamp.
  private rtcLatched = [0, 0, 0, 0, 0];
  private rtcLatchPrev = 0xff;
  private rtcBase = Date.now(); // ms timestamp corresponding to rtc "zero"
  private rtcHaltedAt = 0;
  private rtcHalted = false;
  private rtcCarry = false;

  constructor(rom: Uint8Array) {
    this.header = parseHeader(rom);
    // Pad ROM to a power-of-two bank count so masking works.
    let banks = 2;
    while (banks * 0x4000 < rom.length) banks *= 2;
    if (rom.length !== banks * 0x4000) {
      const padded = new Uint8Array(banks * 0x4000).fill(0xff);
      padded.set(rom);
      this.rom = padded;
    } else {
      this.rom = rom;
    }
    this.romMask = banks - 1;
    this.ram = new Uint8Array(Math.max(this.header.ramSize, 0));
    if (this.header.mbc === 'none' && this.ram.length === 0) this.ram = new Uint8Array(0);
    this.updateOffsets();
  }

  private updateOffsets(): void {
    const h = this.header;
    switch (h.mbc) {
      case 'mbc1': {
        const bank = ((this.bank2 << 5) | this.romBank) & this.romMask;
        this.romBankOffset = bank * 0x4000;
        this.romBank0Offset = this.mode === 1 ? ((this.bank2 << 5) & this.romMask) * 0x4000 : 0;
        this.ramOffset = this.mode === 1 && this.ram.length > 0x2000 ? (this.bank2 & 3) * 0x2000 : 0;
        break;
      }
      case 'mbc2':
        this.romBankOffset = (this.romBank & this.romMask) * 0x4000;
        break;
      case 'mbc3':
        this.romBankOffset = (this.romBank & this.romMask) * 0x4000;
        this.ramOffset = (this.bank2 & 3) * 0x2000;
        break;
      case 'mbc5':
        this.romBankOffset = (this.romBank & this.romMask) * 0x4000;
        this.ramOffset = (this.bank2 & 0xf) * 0x2000;
        break;
      default:
        this.romBankOffset = 0x4000;
    }
    if (this.ram.length > 0 && this.ramOffset >= this.ram.length) this.ramOffset %= this.ram.length;
  }

  /** The ROM bank currently mapped at 0x4000-0x7FFF. */
  get currentRomBank(): number {
    return this.romBankOffset / 0x4000;
  }

  readRom(addr: number): number {
    if (addr < 0x4000) return this.rom[this.romBank0Offset + addr];
    return this.rom[this.romBankOffset + (addr - 0x4000)];
  }

  writeRom(addr: number, val: number): void {
    switch (this.header.mbc) {
      case 'mbc1':
        if (addr < 0x2000) this.ramEnabled = (val & 0x0f) === 0x0a;
        else if (addr < 0x4000) {
          this.romBank = val & 0x1f;
          if (this.romBank === 0) this.romBank = 1;
        } else if (addr < 0x6000) this.bank2 = val & 3;
        else this.mode = val & 1;
        break;
      case 'mbc2':
        if (addr < 0x4000) {
          if (addr & 0x100) {
            this.romBank = val & 0x0f;
            if (this.romBank === 0) this.romBank = 1;
          } else this.ramEnabled = (val & 0x0f) === 0x0a;
        }
        break;
      case 'mbc3':
        if (addr < 0x2000) this.ramEnabled = (val & 0x0f) === 0x0a;
        else if (addr < 0x4000) {
          this.romBank = val & 0x7f;
          if (this.romBank === 0) this.romBank = 1;
        } else if (addr < 0x6000) this.bank2 = val & 0x0f;
        else {
          if (this.rtcLatchPrev === 0 && val === 1) this.latchRtc();
          this.rtcLatchPrev = val;
        }
        break;
      case 'mbc5':
        if (addr < 0x2000) this.ramEnabled = (val & 0x0f) === 0x0a;
        else if (addr < 0x3000) this.romBank = (this.romBank & 0x100) | val;
        else if (addr < 0x4000) this.romBank = (this.romBank & 0xff) | ((val & 1) << 8);
        else if (addr < 0x6000) this.bank2 = val & 0x0f;
        break;
      default:
        break;
    }
    this.updateOffsets();
  }

  readRam(addr: number): number {
    if (!this.ramEnabled) return 0xff;
    const off = addr - 0xa000;
    if (this.header.mbc === 'mbc2') return (this.ram[off & 0x1ff] & 0x0f) | 0xf0;
    if (this.header.mbc === 'mbc3' && this.bank2 >= 0x08 && this.bank2 <= 0x0c) {
      return this.rtcLatched[this.bank2 - 0x08];
    }
    if (this.ram.length === 0) return 0xff;
    return this.ram[(this.ramOffset + off) % this.ram.length];
  }

  writeRam(addr: number, val: number): void {
    if (!this.ramEnabled) return;
    const off = addr - 0xa000;
    if (this.header.mbc === 'mbc2') {
      this.ram[off & 0x1ff] = val & 0x0f;
      this.ramDirty = true;
      return;
    }
    if (this.header.mbc === 'mbc3' && this.bank2 >= 0x08 && this.bank2 <= 0x0c) {
      this.writeRtc(this.bank2 - 0x08, val);
      return;
    }
    if (this.ram.length === 0) return;
    this.ram[(this.ramOffset + off) % this.ram.length] = val;
    this.ramDirty = true;
  }

  // ---- MBC3 RTC (wall-clock based) ----
  private rtcSeconds(): number {
    const now = this.rtcHalted ? this.rtcHaltedAt : Date.now();
    return Math.max(0, Math.floor((now - this.rtcBase) / 1000));
  }

  private latchRtc(): void {
    let s = this.rtcSeconds();
    let days = Math.floor(s / 86400);
    s %= 86400;
    if (days > 511) {
      this.rtcCarry = true;
      days %= 512;
    }
    this.rtcLatched = [
      s % 60,
      Math.floor(s / 60) % 60,
      Math.floor(s / 3600),
      days & 0xff,
      ((days >> 8) & 1) | (this.rtcHalted ? 0x40 : 0) | (this.rtcCarry ? 0x80 : 0),
    ];
  }

  private writeRtc(reg: number, val: number): void {
    this.latchRtc();
    const r = this.rtcLatched.slice();
    r[reg] = val;
    const days = r[3] | ((r[4] & 1) << 8);
    const total = (((days * 24 + (r[2] & 0x1f)) * 60 + (r[1] & 0x3f)) * 60 + (r[0] & 0x3f)) * 1000;
    const halted = (r[4] & 0x40) !== 0;
    const now = Date.now();
    this.rtcBase = now - total;
    this.rtcCarry = (r[4] & 0x80) !== 0;
    this.rtcHalted = halted;
    this.rtcHaltedAt = now;
    this.rtcLatched = r;
  }

  saveState(): CartState {
    return {
      ram: this.ram.slice(),
      regs: [this.ramEnabled ? 1 : 0, this.romBank, this.bank2, this.mode, this.rtcLatchPrev],
      rtc: [...this.rtcLatched, this.rtcBase, this.rtcHalted ? 1 : 0, this.rtcHaltedAt, this.rtcCarry ? 1 : 0],
    };
  }

  loadState(s: CartState): void {
    this.ram.set(s.ram.subarray(0, this.ram.length));
    [this.ramEnabled, this.romBank, this.bank2, this.mode, this.rtcLatchPrev] = [
      s.regs[0] === 1,
      s.regs[1],
      s.regs[2],
      s.regs[3],
      s.regs[4],
    ];
    if (s.rtc) {
      this.rtcLatched = s.rtc.slice(0, 5);
      this.rtcBase = s.rtc[5];
      this.rtcHalted = s.rtc[6] === 1;
      this.rtcHaltedAt = s.rtc[7];
      this.rtcCarry = s.rtc[8] === 1;
    }
    this.updateOffsets();
  }
}

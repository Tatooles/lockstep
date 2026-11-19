// Memory bus: address decoding, joypad, serial, OAM DMA, interrupt flags.

import { Apu } from './apu.ts';
import { Cartridge } from './cart.ts';
import { INT_JOYPAD, INT_SERIAL } from './constants.ts';
import { Ppu } from './ppu.ts';
import { Timer } from './timer.ts';

export class Bus {
  readonly wram = new Uint8Array(0x2000);
  readonly hram = new Uint8Array(0x7f);
  ie = 0;
  iflag = 0xe1;
  readonly cart: Cartridge;
  readonly ppu: Ppu;
  readonly apu: Apu;
  readonly timer: Timer;
  /** Total M-cycles elapsed. */
  mcycles = 0;

  // Joypad
  private p1Select = 0x30;
  /** Bitmask of pressed buttons (see Button). */
  pressed = 0;

  // Serial
  private sb = 0;
  private sc = 0x7e;
  private serialCycles = 0;
  onSerialByte: ((b: number) => void) | null = null;

  // OAM DMA
  private dmaReg = 0xff;
  private dmaActive = false;
  private dmaSrc = 0;
  private dmaIndex = 0;
  private dmaDelay = 0;

  constructor(cart: Cartridge) {
    this.cart = cart;
    const req = (bit: number) => {
      this.iflag |= bit;
    };
    this.ppu = new Ppu(req);
    this.apu = new Apu();
    this.timer = new Timer(req);
  }

  requestInterrupt(bit: number): void {
    this.iflag |= bit;
  }

  /** Advance every component by one M-cycle. */
  tick(): void {
    this.mcycles++;
    this.timer.tick();
    this.ppu.tick();
    this.apu.tick();
    if (this.dmaActive || this.dmaDelay) this.stepDma();
    if (this.serialCycles > 0 && --this.serialCycles === 0) {
      this.sb = 0xff;
      this.sc &= 0x7f;
      this.iflag |= INT_SERIAL;
    }
  }

  private stepDma(): void {
    if (this.dmaDelay > 0) {
      // One M-cycle of setup after the FF46 write, then one byte per M-cycle.
      if (--this.dmaDelay > 0) return;
      this.dmaActive = true;
      this.dmaIndex = 0;
    } else if (this.dmaIndex >= 0xa0) {
      this.dmaActive = false;
      return;
    }
    this.ppu.oam[this.dmaIndex] = this.readDmaSource(this.dmaSrc + this.dmaIndex);
    this.dmaIndex++;
  }

  private readDmaSource(addr: number): number {
    if (addr < 0x8000) return this.cart.readRom(addr);
    if (addr < 0xa000) return this.ppu.vram[addr - 0x8000];
    if (addr < 0xc000) return this.cart.readRam(addr);
    return this.wram[(addr - 0xc000) & 0x1fff];
  }

  setButton(id: number, down: boolean): void {
    const bit = 1 << id;
    if (down) {
      if (!(this.pressed & bit)) this.iflag |= INT_JOYPAD;
      this.pressed |= bit;
    } else this.pressed &= ~bit;
  }

  private readP1(): number {
    let low = 0x0f;
    if (!(this.p1Select & 0x10)) low &= ~(this.pressed & 0x0f);
    if (!(this.p1Select & 0x20)) low &= ~((this.pressed >> 4) & 0x0f);
    return 0xc0 | this.p1Select | low;
  }

  read(addr: number): number {
    if (addr < 0x8000) return this.cart.readRom(addr);
    if (addr < 0xa000) return this.ppu.vram[addr - 0x8000];
    if (addr < 0xc000) return this.cart.readRam(addr);
    if (addr < 0xfe00) return this.wram[(addr - 0xc000) & 0x1fff];
    if (addr < 0xfea0) return this.dmaActive ? 0xff : this.ppu.oam[addr - 0xfe00];
    if (addr < 0xff00) return 0x00;
    if (addr >= 0xff80) return addr === 0xffff ? this.ie : this.hram[addr - 0xff80];
    return this.readIo(addr);
  }

  private readIo(addr: number): number {
    if (addr === 0xff00) return this.readP1();
    if (addr === 0xff01) return this.sb;
    if (addr === 0xff02) return this.sc | 0x7e;
    if (addr >= 0xff04 && addr <= 0xff07) return this.timer.read(addr);
    if (addr === 0xff0f) return this.iflag | 0xe0;
    if (addr >= 0xff10 && addr <= 0xff3f) return this.apu.read(addr);
    if (addr === 0xff46) return this.dmaReg;
    if (addr >= 0xff40 && addr <= 0xff4b) return this.ppu.read(addr);
    return 0xff;
  }

  write(addr: number, val: number): void {
    if (addr < 0x8000) {
      this.cart.writeRom(addr, val);
    } else if (addr < 0xa000) {
      this.ppu.vram[addr - 0x8000] = val;
    } else if (addr < 0xc000) {
      this.cart.writeRam(addr, val);
    } else if (addr < 0xfe00) {
      this.wram[(addr - 0xc000) & 0x1fff] = val;
    } else if (addr < 0xfea0) {
      if (!this.dmaActive) this.ppu.oam[addr - 0xfe00] = val;
    } else if (addr < 0xff00) {
      // unusable
    } else if (addr >= 0xff80) {
      if (addr === 0xffff) this.ie = val;
      else this.hram[addr - 0xff80] = val;
    } else {
      this.writeIo(addr, val);
    }
  }

  private writeIo(addr: number, val: number): void {
    if (addr === 0xff00) {
      this.p1Select = val & 0x30;
    } else if (addr === 0xff01) {
      this.sb = val;
    } else if (addr === 0xff02) {
      this.sc = val | 0x7e;
      if ((val & 0x81) === 0x81) {
        this.onSerialByte?.(this.sb);
        this.serialCycles = 1024;
      }
    } else if (addr >= 0xff04 && addr <= 0xff07) {
      this.timer.write(addr, val);
    } else if (addr === 0xff0f) {
      this.iflag = val | 0xe0;
    } else if (addr >= 0xff10 && addr <= 0xff3f) {
      this.apu.write(addr, val);
    } else if (addr === 0xff46) {
      this.dmaReg = val;
      this.dmaSrc = val << 8;
      if (this.dmaSrc >= 0xe000) this.dmaSrc -= 0x2000;
      this.dmaDelay = 2;
    } else if (addr >= 0xff40 && addr <= 0xff4b) {
      this.ppu.write(addr, val);
    }
  }

  saveState(): object {
    return {
      wram: this.wram.slice(),
      hram: this.hram.slice(),
      regs: [
        this.ie, this.iflag, this.p1Select, this.sb, this.sc, this.serialCycles, this.dmaReg,
        this.dmaActive ? 1 : 0, this.dmaSrc, this.dmaIndex, this.dmaDelay, this.mcycles,
      ],
    };
  }

  loadState(s: { wram: Uint8Array; hram: Uint8Array; regs: number[] }): void {
    this.wram.set(s.wram);
    this.hram.set(s.hram);
    const r = s.regs;
    [this.ie, this.iflag, this.p1Select, this.sb, this.sc, this.serialCycles, this.dmaReg] = r;
    this.dmaActive = r[7] === 1;
    [this.dmaSrc, this.dmaIndex, this.dmaDelay, this.mcycles] = r.slice(8);
  }
}

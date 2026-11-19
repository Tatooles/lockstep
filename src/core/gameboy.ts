import { Bus } from './bus.ts';
import { Cartridge } from './cart.ts';
import { CYCLES_PER_FRAME } from './constants.ts';
import { Cpu } from './cpu.ts';
import { checkState, STATE_VERSION, type Emulator, type SaveState } from './emulator.ts';

export { STATE_VERSION, type SaveState } from './emulator.ts';

export class GameBoy implements Emulator {
  readonly cart: Cartridge;
  readonly bus: Bus;
  readonly cpu: Cpu;

  constructor(rom: Uint8Array) {
    this.cart = new Cartridge(rom);
    this.bus = new Bus(this.cart);
    this.cpu = new Cpu(this.bus);
    this.initIo();
  }

  /** IO register values as left by the DMG boot ROM. */
  private initIo(): void {
    const b = this.bus;
    b.timer.counter = 0xabcc;
    b.write(0xff05, 0);
    b.write(0xff06, 0);
    b.write(0xff07, 0xf8);
    b.iflag = 0xe1;
    b.write(0xff40, 0x91);
    b.write(0xff42, 0);
    b.write(0xff43, 0);
    b.write(0xff45, 0);
    b.write(0xff47, 0xfc);
    b.write(0xff48, 0xff);
    b.write(0xff49, 0xff);
    b.write(0xff4a, 0);
    b.write(0xff4b, 0);
    b.ie = 0;
  }

  get ppu() {
    return this.bus.ppu;
  }

  get apu() {
    return this.bus.apu;
  }

  setButton(id: number, down: boolean): void {
    this.bus.setButton(id, down);
  }

  /** Run until the next VBlank (or one frame's worth of cycles if the LCD is off). */
  runFrame(): void {
    const bus = this.bus;
    const cpu = this.cpu;
    const ppu = bus.ppu;
    ppu.frameReady = false;
    const limit = bus.mcycles + CYCLES_PER_FRAME / 4;
    while (!ppu.frameReady && bus.mcycles < limit) cpu.step();
  }

  /** Run a number of M-cycles (used by tests). */
  runCycles(mcycles: number): void {
    const end = this.bus.mcycles + mcycles;
    while (this.bus.mcycles < end) this.cpu.step();
  }

  /** Side-effect-free memory read (for tracker/debugger). */
  peek(addr: number): number {
    return this.bus.read(addr & 0xffff);
  }

  saveState(): SaveState {
    return {
      version: STATE_VERSION,
      title: this.cart.header.title,
      globalChecksum: this.cart.header.globalChecksum,
      cpu: this.cpu.saveState(),
      bus: this.bus.saveState() as SaveState['bus'],
      ppu: this.bus.ppu.saveState(),
      apu: this.bus.apu.saveState(),
      timer: this.bus.timer.saveState(),
      cart: this.cart.saveState(),
    };
  }

  reset(): void {
    const fresh = new GameBoy(this.cart.rom);
    fresh.cart.ram.set(this.cart.ram);
    this.loadState(fresh.saveState());
  }

  loadState(s: SaveState): void {
    checkState(s, this.cart.header);
    this.cpu.loadState(s.cpu);
    this.bus.loadState(s.bus);
    this.bus.ppu.loadState(s.ppu);
    this.bus.apu.loadState(s.apu);
    this.bus.timer.loadState(s.timer);
    this.cart.loadState(s.cart);
  }
}

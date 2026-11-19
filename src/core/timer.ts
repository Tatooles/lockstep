// DIV/TIMA timer, modelled on the 16-bit system counter with falling-edge detection.

import { INT_TIMER } from './constants.ts';

const TAC_BITS = [1 << 9, 1 << 3, 1 << 5, 1 << 7];

export class Timer {
  counter = 0;
  tima = 0;
  tma = 0;
  tac = 0;
  private reloadPending = false;
  private reloading = false;
  private requestInterrupt: (bit: number) => void;

  constructor(requestInterrupt: (bit: number) => void) {
    this.requestInterrupt = requestInterrupt;
  }

  /** Advance one M-cycle (4 T-cycles). */
  tick(): void {
    this.reloading = false;
    if (this.reloadPending) {
      this.reloadPending = false;
      this.tima = this.tma;
      this.reloading = true;
      this.requestInterrupt(INT_TIMER);
    }
    const old = this.counter;
    this.counter = (this.counter + 4) & 0xffff;
    if (this.tac & 4) {
      const bit = TAC_BITS[this.tac & 3];
      if (old & bit && !(this.counter & bit)) this.incTima();
    }
  }

  private incTima(): void {
    this.tima = (this.tima + 1) & 0xff;
    if (this.tima === 0) this.reloadPending = true;
  }

  private signal(): boolean {
    return (this.tac & 4) !== 0 && (this.counter & TAC_BITS[this.tac & 3]) !== 0;
  }

  read(addr: number): number {
    switch (addr) {
      case 0xff04:
        return this.counter >> 8;
      case 0xff05:
        return this.tima;
      case 0xff06:
        return this.tma;
      case 0xff07:
        return this.tac | 0xf8;
    }
    return 0xff;
  }

  write(addr: number, val: number): void {
    switch (addr) {
      case 0xff04: {
        const was = this.signal();
        this.counter = 0;
        if (was) this.incTima();
        break;
      }
      case 0xff05:
        if (this.reloading) return; // write ignored on the reload cycle
        this.reloadPending = false; // write during the overflow cycle cancels reload
        this.tima = val;
        break;
      case 0xff06:
        this.tma = val;
        if (this.reloading) this.tima = val;
        break;
      case 0xff07: {
        const was = this.signal();
        this.tac = val & 7;
        if (was && !this.signal()) this.incTima();
        break;
      }
    }
  }

  saveState(): number[] {
    return [this.counter, this.tima, this.tma, this.tac, this.reloadPending ? 1 : 0, this.reloading ? 1 : 0];
  }

  loadState(s: number[]): void {
    [this.counter, this.tima, this.tma, this.tac] = s;
    this.reloadPending = s[4] === 1;
    this.reloading = s[5] === 1;
  }
}

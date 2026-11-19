// Sharp SM83 CPU. Every memory access costs one M-cycle (bus.tick()), and
// internal delays are ticked explicitly, giving M-cycle accurate timing.

import type { Bus } from './bus.ts';

const FZ = 0x80;
const FN = 0x40;
const FH = 0x20;
const FC = 0x10;

export class Cpu {
  a = 0x01;
  f = 0xb0;
  b = 0x00;
  c = 0x13;
  d = 0x00;
  e = 0xd8;
  h = 0x01;
  l = 0x4d;
  sp = 0xfffe;
  pc = 0x0100;
  ime = false;
  halted = false;
  /** Set by an illegal opcode: the CPU stops forever. */
  locked = false;
  private haltBug = false;
  private eiPending = false;
  private readonly bus: Bus;

  constructor(bus: Bus) {
    this.bus = bus;
  }

  // ---- bus helpers ----
  private rd(addr: number): number {
    this.bus.tick();
    return this.bus.read(addr);
  }

  private wr(addr: number, v: number): void {
    this.bus.tick();
    this.bus.write(addr, v);
  }

  private fetch(): number {
    this.bus.tick();
    const v = this.bus.read(this.pc);
    if (this.haltBug) this.haltBug = false;
    else this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private fetch16(): number {
    const lo = this.fetch();
    return (this.fetch() << 8) | lo;
  }

  private push(v: number): void {
    this.bus.tick();
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, v >> 8);
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, v & 0xff);
  }

  private pop(): number {
    const lo = this.rd(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const hi = this.rd(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return (hi << 8) | lo;
  }

  private get hl(): number {
    return (this.h << 8) | this.l;
  }

  private set hl(v: number) {
    this.h = (v >> 8) & 0xff;
    this.l = v & 0xff;
  }

  private getR(i: number): number {
    switch (i) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return this.h;
      case 5: return this.l;
      case 6: return this.rd(this.hl);
      default: return this.a;
    }
  }

  private setR(i: number, v: number): void {
    switch (i) {
      case 0: this.b = v; break;
      case 1: this.c = v; break;
      case 2: this.d = v; break;
      case 3: this.e = v; break;
      case 4: this.h = v; break;
      case 5: this.l = v; break;
      case 6: this.wr(this.hl, v); break;
      default: this.a = v;
    }
  }

  private getRR(i: number): number {
    switch (i) {
      case 0: return (this.b << 8) | this.c;
      case 1: return (this.d << 8) | this.e;
      case 2: return (this.h << 8) | this.l;
      default: return this.sp;
    }
  }

  private setRR(i: number, v: number): void {
    v &= 0xffff;
    switch (i) {
      case 0: this.b = v >> 8; this.c = v & 0xff; break;
      case 1: this.d = v >> 8; this.e = v & 0xff; break;
      case 2: this.h = v >> 8; this.l = v & 0xff; break;
      default: this.sp = v;
    }
  }

  private cond(i: number): boolean {
    switch (i) {
      case 0: return (this.f & FZ) === 0;
      case 1: return (this.f & FZ) !== 0;
      case 2: return (this.f & FC) === 0;
      default: return (this.f & FC) !== 0;
    }
  }

  // ---- ALU ----
  private alu(op: number, v: number): void {
    const a = this.a;
    switch (op) {
      case 0: { // ADD
        const r = a + v;
        this.f = ((r & 0xff) === 0 ? FZ : 0) | ((a & 0xf) + (v & 0xf) > 0xf ? FH : 0) | (r > 0xff ? FC : 0);
        this.a = r & 0xff;
        break;
      }
      case 1: { // ADC
        const c = (this.f & FC) >> 4;
        const r = a + v + c;
        this.f = ((r & 0xff) === 0 ? FZ : 0) | ((a & 0xf) + (v & 0xf) + c > 0xf ? FH : 0) | (r > 0xff ? FC : 0);
        this.a = r & 0xff;
        break;
      }
      case 2: { // SUB
        const r = a - v;
        this.f = ((r & 0xff) === 0 ? FZ : 0) | FN | ((a & 0xf) < (v & 0xf) ? FH : 0) | (r < 0 ? FC : 0);
        this.a = r & 0xff;
        break;
      }
      case 3: { // SBC
        const c = (this.f & FC) >> 4;
        const r = a - v - c;
        this.f = ((r & 0xff) === 0 ? FZ : 0) | FN | ((a & 0xf) - (v & 0xf) - c < 0 ? FH : 0) | (r < 0 ? FC : 0);
        this.a = r & 0xff;
        break;
      }
      case 4: // AND
        this.a = a & v;
        this.f = (this.a === 0 ? FZ : 0) | FH;
        break;
      case 5: // XOR
        this.a = a ^ v;
        this.f = this.a === 0 ? FZ : 0;
        break;
      case 6: // OR
        this.a = a | v;
        this.f = this.a === 0 ? FZ : 0;
        break;
      default: { // CP
        const r = a - v;
        this.f = ((r & 0xff) === 0 ? FZ : 0) | FN | ((a & 0xf) < (v & 0xf) ? FH : 0) | (r < 0 ? FC : 0);
      }
    }
  }

  private inc8(v: number): number {
    const r = (v + 1) & 0xff;
    this.f = (this.f & FC) | (r === 0 ? FZ : 0) | ((v & 0xf) === 0xf ? FH : 0);
    return r;
  }

  private dec8(v: number): number {
    const r = (v - 1) & 0xff;
    this.f = (this.f & FC) | (r === 0 ? FZ : 0) | FN | ((v & 0xf) === 0 ? FH : 0);
    return r;
  }

  private addSpE(): number {
    const e = this.fetch();
    const se = (e << 24) >> 24;
    const sp = this.sp;
    this.f = ((sp & 0xf) + (e & 0xf) > 0xf ? FH : 0) | ((sp & 0xff) + e > 0xff ? FC : 0);
    return (sp + se) & 0xffff;
  }

  // ---- execution ----
  /** Execute one instruction (or interrupt dispatch / halted M-cycle). */
  step(): void {
    const bus = this.bus;
    if (this.locked) {
      bus.tick();
      return;
    }
    if (this.halted) {
      if (bus.ie & bus.iflag & 0x1f) this.halted = false;
      else {
        bus.tick();
        return;
      }
    }
    if (this.ime && bus.ie & bus.iflag & 0x1f) {
      this.dispatchInterrupt();
      return;
    }
    const enableIme = this.eiPending;
    this.eiPending = false;
    const op = this.fetch();
    this.execute(op);
    if (enableIme && op !== 0xf3) this.ime = true;
  }

  private dispatchInterrupt(): void {
    const bus = this.bus;
    this.ime = false;
    bus.tick();
    bus.tick();
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, this.pc >> 8);
    // The vector is chosen after the high byte push (it may have written IE).
    const pending = bus.ie & bus.iflag & 0x1f;
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, this.pc & 0xff);
    if (pending === 0) {
      this.pc = 0;
    } else {
      let bit = 0;
      while (!(pending & (1 << bit))) bit++;
      bus.iflag &= ~(1 << bit);
      this.pc = 0x40 + bit * 8;
    }
    bus.tick();
  }

  private execute(op: number): void {
    // 0x40-0x7F: LD r,r'
    if (op >= 0x40 && op < 0x80) {
      if (op === 0x76) {
        if (!this.ime && this.bus.ie & this.bus.iflag & 0x1f) this.haltBug = true;
        else this.halted = true;
        return;
      }
      this.setR((op >> 3) & 7, this.getR(op & 7));
      return;
    }
    // 0x80-0xBF: ALU A,r
    if (op >= 0x80 && op < 0xc0) {
      this.alu((op >> 3) & 7, this.getR(op & 7));
      return;
    }
    switch (op) {
      case 0x00: return;
      case 0x01: case 0x11: case 0x21: case 0x31:
        this.setRR(op >> 4, this.fetch16());
        return;
      case 0x02: this.wr((this.b << 8) | this.c, this.a); return;
      case 0x12: this.wr((this.d << 8) | this.e, this.a); return;
      case 0x22: { const hl = this.hl; this.wr(hl, this.a); this.hl = (hl + 1) & 0xffff; return; }
      case 0x32: { const hl = this.hl; this.wr(hl, this.a); this.hl = (hl - 1) & 0xffff; return; }
      case 0x0a: this.a = this.rd((this.b << 8) | this.c); return;
      case 0x1a: this.a = this.rd((this.d << 8) | this.e); return;
      case 0x2a: { const hl = this.hl; this.a = this.rd(hl); this.hl = (hl + 1) & 0xffff; return; }
      case 0x3a: { const hl = this.hl; this.a = this.rd(hl); this.hl = (hl - 1) & 0xffff; return; }
      case 0x03: case 0x13: case 0x23: case 0x33:
        this.bus.tick();
        this.setRR(op >> 4, this.getRR(op >> 4) + 1);
        return;
      case 0x0b: case 0x1b: case 0x2b: case 0x3b:
        this.bus.tick();
        this.setRR(op >> 4, this.getRR(op >> 4) - 1);
        return;
      case 0x04: case 0x0c: case 0x14: case 0x1c: case 0x24: case 0x2c: case 0x3c:
        this.setR(op >> 3, this.inc8(this.getR(op >> 3)));
        return;
      case 0x34: { const hl = this.hl; this.wr(hl, this.inc8(this.rd(hl))); return; }
      case 0x05: case 0x0d: case 0x15: case 0x1d: case 0x25: case 0x2d: case 0x3d:
        this.setR(op >> 3, this.dec8(this.getR(op >> 3)));
        return;
      case 0x35: { const hl = this.hl; this.wr(hl, this.dec8(this.rd(hl))); return; }
      case 0x06: case 0x0e: case 0x16: case 0x1e: case 0x26: case 0x2e: case 0x3e:
        this.setR(op >> 3, this.fetch());
        return;
      case 0x36: { const v = this.fetch(); this.wr(this.hl, v); return; }
      case 0x07: { // RLCA
        const a = this.a;
        this.a = ((a << 1) | (a >> 7)) & 0xff;
        this.f = a & 0x80 ? FC : 0;
        return;
      }
      case 0x0f: { // RRCA
        const a = this.a;
        this.a = ((a >> 1) | (a << 7)) & 0xff;
        this.f = a & 1 ? FC : 0;
        return;
      }
      case 0x17: { // RLA
        const a = this.a;
        this.a = ((a << 1) | ((this.f & FC) >> 4)) & 0xff;
        this.f = a & 0x80 ? FC : 0;
        return;
      }
      case 0x1f: { // RRA
        const a = this.a;
        this.a = (a >> 1) | ((this.f & FC) << 3);
        this.f = a & 1 ? FC : 0;
        return;
      }
      case 0x08: {
        const addr = this.fetch16();
        this.wr(addr, this.sp & 0xff);
        this.wr((addr + 1) & 0xffff, this.sp >> 8);
        return;
      }
      case 0x09: case 0x19: case 0x29: case 0x39: {
        const hl = this.hl;
        const v = this.getRR(op >> 4);
        const r = hl + v;
        this.f = (this.f & FZ) | ((hl & 0xfff) + (v & 0xfff) > 0xfff ? FH : 0) | (r > 0xffff ? FC : 0);
        this.bus.tick();
        this.hl = r & 0xffff;
        return;
      }
      case 0x10: // STOP
        this.fetch();
        this.bus.timer.write(0xff04, 0);
        this.halted = true;
        return;
      case 0x18: {
        const e = (this.fetch() << 24) >> 24;
        this.bus.tick();
        this.pc = (this.pc + e) & 0xffff;
        return;
      }
      case 0x20: case 0x28: case 0x30: case 0x38: {
        const e = (this.fetch() << 24) >> 24;
        if (this.cond((op >> 3) & 3)) {
          this.bus.tick();
          this.pc = (this.pc + e) & 0xffff;
        }
        return;
      }
      case 0x27: { // DAA
        let a = this.a;
        let carry = this.f & FC;
        if (!(this.f & FN)) {
          if (carry || a > 0x99) {
            a += 0x60;
            carry = FC;
          }
          if (this.f & FH || (a & 0x0f) > 0x09) a += 0x06;
        } else {
          if (carry) a -= 0x60;
          if (this.f & FH) a -= 0x06;
        }
        a &= 0xff;
        this.a = a;
        this.f = (a === 0 ? FZ : 0) | (this.f & FN) | carry;
        return;
      }
      case 0x2f:
        this.a ^= 0xff;
        this.f |= FN | FH;
        return;
      case 0x37:
        this.f = (this.f & FZ) | FC;
        return;
      case 0x3f:
        this.f = (this.f & (FZ | FC)) ^ FC;
        return;
      // ---- 0xC0+ ----
      case 0xc0: case 0xc8: case 0xd0: case 0xd8:
        this.bus.tick();
        if (this.cond((op >> 3) & 3)) {
          this.pc = this.pop();
          this.bus.tick();
        }
        return;
      case 0xc9:
        this.pc = this.pop();
        this.bus.tick();
        return;
      case 0xd9:
        this.pc = this.pop();
        this.bus.tick();
        this.ime = true;
        return;
      case 0xc1: case 0xd1: case 0xe1:
        this.setRR((op >> 4) & 3, this.pop());
        return;
      case 0xf1: {
        const v = this.pop();
        this.a = v >> 8;
        this.f = v & 0xf0;
        return;
      }
      case 0xc5: case 0xd5: case 0xe5:
        this.push(this.getRR((op >> 4) & 3));
        return;
      case 0xf5:
        this.push((this.a << 8) | this.f);
        return;
      case 0xc2: case 0xca: case 0xd2: case 0xda: {
        const addr = this.fetch16();
        if (this.cond((op >> 3) & 3)) {
          this.bus.tick();
          this.pc = addr;
        }
        return;
      }
      case 0xc3: {
        const addr = this.fetch16();
        this.bus.tick();
        this.pc = addr;
        return;
      }
      case 0xc4: case 0xcc: case 0xd4: case 0xdc: {
        const addr = this.fetch16();
        if (this.cond((op >> 3) & 3)) {
          this.push(this.pc);
          this.pc = addr;
        }
        return;
      }
      case 0xcd: {
        const addr = this.fetch16();
        this.push(this.pc);
        this.pc = addr;
        return;
      }
      case 0xc6: case 0xce: case 0xd6: case 0xde: case 0xe6: case 0xee: case 0xf6: case 0xfe:
        this.alu((op >> 3) & 7, this.fetch());
        return;
      case 0xc7: case 0xcf: case 0xd7: case 0xdf: case 0xe7: case 0xef: case 0xf7: case 0xff:
        this.push(this.pc);
        this.pc = op & 0x38;
        return;
      case 0xcb:
        this.executeCb(this.fetch());
        return;
      case 0xe0: { const n = this.fetch(); this.wr(0xff00 | n, this.a); return; }
      case 0xf0: { const n = this.fetch(); this.a = this.rd(0xff00 | n); return; }
      case 0xe2: this.wr(0xff00 | this.c, this.a); return;
      case 0xf2: this.a = this.rd(0xff00 | this.c); return;
      case 0xea: { const addr = this.fetch16(); this.wr(addr, this.a); return; }
      case 0xfa: { const addr = this.fetch16(); this.a = this.rd(addr); return; }
      case 0xe8: {
        const r = this.addSpE();
        this.bus.tick();
        this.bus.tick();
        this.sp = r;
        return;
      }
      case 0xf8: {
        const r = this.addSpE();
        this.bus.tick();
        this.hl = r;
        return;
      }
      case 0xf9:
        this.bus.tick();
        this.sp = this.hl;
        return;
      case 0xe9:
        this.pc = this.hl;
        return;
      case 0xf3:
        this.ime = false;
        this.eiPending = false;
        return;
      case 0xfb:
        this.eiPending = true;
        return;
      default:
        // Illegal opcode (D3, DB, DD, E3, E4, EB, EC, ED, F4, FC, FD): hard lock.
        this.locked = true;
    }
  }

  private executeCb(op: number): void {
    const r = op & 7;
    const group = op >> 6;
    const bit = (op >> 3) & 7;
    if (group === 1) { // BIT
      const v = this.getR(r);
      this.f = (this.f & FC) | FH | (v & (1 << bit) ? 0 : FZ);
      return;
    }
    const v = this.getR(r);
    if (group === 2) { this.setR(r, v & ~(1 << bit)); return; }
    if (group === 3) { this.setR(r, v | (1 << bit)); return; }
    let res: number;
    let carry: number;
    switch (bit) {
      case 0: carry = v >> 7; res = ((v << 1) | carry) & 0xff; break; // RLC
      case 1: carry = v & 1; res = (v >> 1) | (carry << 7); break; // RRC
      case 2: carry = v >> 7; res = ((v << 1) | ((this.f & FC) >> 4)) & 0xff; break; // RL
      case 3: carry = v & 1; res = (v >> 1) | ((this.f & FC) << 3); break; // RR
      case 4: carry = v >> 7; res = (v << 1) & 0xff; break; // SLA
      case 5: carry = v & 1; res = (v >> 1) | (v & 0x80); break; // SRA
      case 6: carry = 0; res = ((v << 4) | (v >> 4)) & 0xff; break; // SWAP
      default: carry = v & 1; res = v >> 1; // SRL
    }
    this.f = (res === 0 ? FZ : 0) | (carry ? FC : 0);
    this.setR(r, res);
  }

  saveState(): number[] {
    return [
      this.a, this.f, this.b, this.c, this.d, this.e, this.h, this.l, this.sp, this.pc,
      this.ime ? 1 : 0, this.halted ? 1 : 0, this.haltBug ? 1 : 0, this.eiPending ? 1 : 0, this.locked ? 1 : 0,
    ];
  }

  loadState(s: number[]): void {
    [this.a, this.f, this.b, this.c, this.d, this.e, this.h, this.l, this.sp, this.pc] = s;
    this.ime = s[10] === 1;
    this.halted = s[11] === 1;
    this.haltBug = s[12] === 1;
    this.eiPending = s[13] === 1;
    this.locked = s[14] === 1;
  }
}

// Sharp SM83 CPU: a port of src/core/cpu.ts (M-cycle accurate).

use crate::bus::Bus;

const FZ: u8 = 0x80;
const FN: u8 = 0x40;
const FH: u8 = 0x20;
const FC: u8 = 0x10;

#[inline(always)]
fn z(v: bool) -> u8 {
    if v { FZ } else { 0 }
}

pub struct Cpu {
    pub a: u8,
    pub f: u8,
    pub b: u8,
    pub c: u8,
    pub d: u8,
    pub e: u8,
    pub h: u8,
    pub l: u8,
    pub sp: u16,
    pub pc: u16,
    pub ime: bool,
    pub halted: bool,
    pub locked: bool,
    halt_bug: bool,
    ei_pending: bool,
    pub bus: Bus,
}

impl Cpu {
    pub fn new(bus: Bus) -> Self {
        Cpu {
            a: 0x01, f: 0xb0, b: 0x00, c: 0x13, d: 0x00, e: 0xd8, h: 0x01, l: 0x4d,
            sp: 0xfffe, pc: 0x0100, ime: false, halted: false, locked: false,
            halt_bug: false, ei_pending: false, bus,
        }
    }

    #[inline(always)]
    fn tick(&mut self) {
        self.bus.tick();
    }

    #[inline(always)]
    fn rd(&mut self, addr: u16) -> u8 {
        self.bus.tick();
        self.bus.read(addr)
    }

    #[inline(always)]
    fn wr(&mut self, addr: u16, v: u8) {
        self.bus.tick();
        self.bus.write(addr, v);
    }

    #[inline(always)]
    fn fetch(&mut self) -> u8 {
        self.bus.tick();
        let v = self.bus.read(self.pc);
        if self.halt_bug {
            self.halt_bug = false;
        } else {
            self.pc = self.pc.wrapping_add(1);
        }
        v
    }

    #[inline(always)]
    fn fetch16(&mut self) -> u16 {
        let lo = self.fetch() as u16;
        let hi = self.fetch() as u16;
        (hi << 8) | lo
    }

    fn push(&mut self, v: u16) {
        self.tick();
        self.sp = self.sp.wrapping_sub(1);
        self.wr(self.sp, (v >> 8) as u8);
        self.sp = self.sp.wrapping_sub(1);
        self.wr(self.sp, v as u8);
    }

    fn pop(&mut self) -> u16 {
        let lo = self.rd(self.sp) as u16;
        self.sp = self.sp.wrapping_add(1);
        let hi = self.rd(self.sp) as u16;
        self.sp = self.sp.wrapping_add(1);
        (hi << 8) | lo
    }

    #[inline(always)]
    fn hl(&self) -> u16 {
        ((self.h as u16) << 8) | self.l as u16
    }

    #[inline(always)]
    fn set_hl(&mut self, v: u16) {
        self.h = (v >> 8) as u8;
        self.l = v as u8;
    }

    #[inline(always)]
    fn get_r(&mut self, i: u8) -> u8 {
        match i & 7 {
            0 => self.b,
            1 => self.c,
            2 => self.d,
            3 => self.e,
            4 => self.h,
            5 => self.l,
            6 => {
                let hl = self.hl();
                self.rd(hl)
            }
            _ => self.a,
        }
    }

    #[inline(always)]
    fn set_r(&mut self, i: u8, v: u8) {
        match i & 7 {
            0 => self.b = v,
            1 => self.c = v,
            2 => self.d = v,
            3 => self.e = v,
            4 => self.h = v,
            5 => self.l = v,
            6 => {
                let hl = self.hl();
                self.wr(hl, v)
            }
            _ => self.a = v,
        }
    }

    fn get_rr(&self, i: u8) -> u16 {
        match i & 3 {
            0 => ((self.b as u16) << 8) | self.c as u16,
            1 => ((self.d as u16) << 8) | self.e as u16,
            2 => self.hl(),
            _ => self.sp,
        }
    }

    fn set_rr(&mut self, i: u8, v: u16) {
        match i & 3 {
            0 => {
                self.b = (v >> 8) as u8;
                self.c = v as u8;
            }
            1 => {
                self.d = (v >> 8) as u8;
                self.e = v as u8;
            }
            2 => self.set_hl(v),
            _ => self.sp = v,
        }
    }

    #[inline(always)]
    fn cond(&self, i: u8) -> bool {
        match i & 3 {
            0 => self.f & FZ == 0,
            1 => self.f & FZ != 0,
            2 => self.f & FC == 0,
            _ => self.f & FC != 0,
        }
    }

    fn alu(&mut self, op: u8, v: u8) {
        let a = self.a as i32;
        let v = v as i32;
        match op & 7 {
            0 => {
                let r = a + v;
                self.f = z(r & 0xff == 0) | if (a & 0xf) + (v & 0xf) > 0xf { FH } else { 0 } | if r > 0xff { FC } else { 0 };
                self.a = r as u8;
            }
            1 => {
                let c = ((self.f & FC) >> 4) as i32;
                let r = a + v + c;
                self.f = z(r & 0xff == 0) | if (a & 0xf) + (v & 0xf) + c > 0xf { FH } else { 0 } | if r > 0xff { FC } else { 0 };
                self.a = r as u8;
            }
            2 => {
                let r = a - v;
                self.f = z(r & 0xff == 0) | FN | if (a & 0xf) < (v & 0xf) { FH } else { 0 } | if r < 0 { FC } else { 0 };
                self.a = r as u8;
            }
            3 => {
                let c = ((self.f & FC) >> 4) as i32;
                let r = a - v - c;
                self.f = z(r & 0xff == 0) | FN | if (a & 0xf) - (v & 0xf) - c < 0 { FH } else { 0 } | if r < 0 { FC } else { 0 };
                self.a = r as u8;
            }
            4 => {
                self.a = (a & v) as u8;
                self.f = z(self.a == 0) | FH;
            }
            5 => {
                self.a = (a ^ v) as u8;
                self.f = z(self.a == 0);
            }
            6 => {
                self.a = (a | v) as u8;
                self.f = z(self.a == 0);
            }
            _ => {
                let r = a - v;
                self.f = z(r & 0xff == 0) | FN | if (a & 0xf) < (v & 0xf) { FH } else { 0 } | if r < 0 { FC } else { 0 };
            }
        }
    }

    #[inline(always)]
    fn inc8(&mut self, v: u8) -> u8 {
        let r = v.wrapping_add(1);
        self.f = (self.f & FC) | z(r == 0) | if v & 0xf == 0xf { FH } else { 0 };
        r
    }

    #[inline(always)]
    fn dec8(&mut self, v: u8) -> u8 {
        let r = v.wrapping_sub(1);
        self.f = (self.f & FC) | z(r == 0) | FN | if v & 0xf == 0 { FH } else { 0 };
        r
    }

    fn add_sp_e(&mut self) -> u16 {
        let e = self.fetch() as i32;
        let se = e as u8 as i8 as i32;
        let sp = self.sp as i32;
        self.f = (if (sp & 0xf) + (e & 0xf) > 0xf { FH } else { 0 }) | (if (sp & 0xff) + e > 0xff { FC } else { 0 });
        ((sp + se) & 0xffff) as u16
    }

    /// Execute one instruction (or interrupt dispatch / halted M-cycle).
    #[inline(always)]
    pub fn step(&mut self) {
        if self.locked {
            self.tick();
            return;
        }
        if self.halted {
            if self.bus.ie & self.bus.iflag & 0x1f != 0 {
                self.halted = false;
            } else {
                self.tick();
                return;
            }
        }
        if self.ime && self.bus.ie & self.bus.iflag & 0x1f != 0 {
            self.dispatch_interrupt();
            return;
        }
        let enable_ime = self.ei_pending;
        self.ei_pending = false;
        let op = self.fetch();
        self.execute(op);
        if enable_ime && op != 0xf3 {
            self.ime = true;
        }
    }

    fn dispatch_interrupt(&mut self) {
        self.ime = false;
        self.tick();
        self.tick();
        self.sp = self.sp.wrapping_sub(1);
        self.wr(self.sp, (self.pc >> 8) as u8);
        let pending = self.bus.ie & self.bus.iflag & 0x1f;
        self.sp = self.sp.wrapping_sub(1);
        self.wr(self.sp, self.pc as u8);
        if pending == 0 {
            self.pc = 0;
        } else {
            let bit = pending.trailing_zeros() as u16;
            self.bus.iflag &= !(1u8 << bit);
            self.pc = 0x40 + bit * 8;
        }
        self.tick();
    }

    fn execute(&mut self, op: u8) {
        match op {
            0x76 => {
                if !self.ime && self.bus.ie & self.bus.iflag & 0x1f != 0 {
                    self.halt_bug = true;
                } else {
                    self.halted = true;
                }
            }
            0x40..=0x7f => {
                let v = self.get_r(op);
                self.set_r(op >> 3, v);
            }
            0x80..=0xbf => {
                let v = self.get_r(op);
                self.alu(op >> 3, v);
            }
            0x00 => {}
            0x01 | 0x11 | 0x21 | 0x31 => {
                let v = self.fetch16();
                self.set_rr(op >> 4, v);
            }
            0x02 => self.wr(((self.b as u16) << 8) | self.c as u16, self.a),
            0x12 => self.wr(((self.d as u16) << 8) | self.e as u16, self.a),
            0x22 => {
                let hl = self.hl();
                self.wr(hl, self.a);
                self.set_hl(hl.wrapping_add(1));
            }
            0x32 => {
                let hl = self.hl();
                self.wr(hl, self.a);
                self.set_hl(hl.wrapping_sub(1));
            }
            0x0a => self.a = self.rd(((self.b as u16) << 8) | self.c as u16),
            0x1a => self.a = self.rd(((self.d as u16) << 8) | self.e as u16),
            0x2a => {
                let hl = self.hl();
                self.a = self.rd(hl);
                self.set_hl(hl.wrapping_add(1));
            }
            0x3a => {
                let hl = self.hl();
                self.a = self.rd(hl);
                self.set_hl(hl.wrapping_sub(1));
            }
            0x03 | 0x13 | 0x23 | 0x33 => {
                self.tick();
                let v = self.get_rr(op >> 4).wrapping_add(1);
                self.set_rr(op >> 4, v);
            }
            0x0b | 0x1b | 0x2b | 0x3b => {
                self.tick();
                let v = self.get_rr(op >> 4).wrapping_sub(1);
                self.set_rr(op >> 4, v);
            }
            0x34 => {
                let hl = self.hl();
                let v = self.rd(hl);
                let r = self.inc8(v);
                self.wr(hl, r);
            }
            0x04 | 0x0c | 0x14 | 0x1c | 0x24 | 0x2c | 0x3c => {
                let v = self.get_r(op >> 3);
                let r = self.inc8(v);
                self.set_r(op >> 3, r);
            }
            0x35 => {
                let hl = self.hl();
                let v = self.rd(hl);
                let r = self.dec8(v);
                self.wr(hl, r);
            }
            0x05 | 0x0d | 0x15 | 0x1d | 0x25 | 0x2d | 0x3d => {
                let v = self.get_r(op >> 3);
                let r = self.dec8(v);
                self.set_r(op >> 3, r);
            }
            0x36 => {
                let v = self.fetch();
                let hl = self.hl();
                self.wr(hl, v);
            }
            0x06 | 0x0e | 0x16 | 0x1e | 0x26 | 0x2e | 0x3e => {
                let v = self.fetch();
                self.set_r(op >> 3, v);
            }
            0x07 => {
                let a = self.a;
                self.a = a.rotate_left(1);
                self.f = if a & 0x80 != 0 { FC } else { 0 };
            }
            0x0f => {
                let a = self.a;
                self.a = a.rotate_right(1);
                self.f = if a & 1 != 0 { FC } else { 0 };
            }
            0x17 => {
                let a = self.a;
                self.a = (a << 1) | ((self.f & FC) >> 4);
                self.f = if a & 0x80 != 0 { FC } else { 0 };
            }
            0x1f => {
                let a = self.a;
                self.a = (a >> 1) | ((self.f & FC) << 3);
                self.f = if a & 1 != 0 { FC } else { 0 };
            }
            0x08 => {
                let addr = self.fetch16();
                self.wr(addr, self.sp as u8);
                self.wr(addr.wrapping_add(1), (self.sp >> 8) as u8);
            }
            0x09 | 0x19 | 0x29 | 0x39 => {
                let hl = self.hl() as u32;
                let v = self.get_rr(op >> 4) as u32;
                let r = hl + v;
                self.f = (self.f & FZ)
                    | if (hl & 0xfff) + (v & 0xfff) > 0xfff { FH } else { 0 }
                    | if r > 0xffff { FC } else { 0 };
                self.tick();
                self.set_hl(r as u16);
            }
            0x10 => {
                self.fetch();
                self.bus.timer.write(0xff04, 0);
                self.halted = true;
            }
            0x18 => {
                let e = self.fetch() as i8 as i16;
                self.tick();
                self.pc = self.pc.wrapping_add(e as u16);
            }
            0x20 | 0x28 | 0x30 | 0x38 => {
                let e = self.fetch() as i8 as i16;
                if self.cond(op >> 3) {
                    self.tick();
                    self.pc = self.pc.wrapping_add(e as u16);
                }
            }
            0x27 => {
                let mut a = self.a as i32;
                let mut carry = self.f & FC;
                if self.f & FN == 0 {
                    if carry != 0 || a > 0x99 {
                        a += 0x60;
                        carry = FC;
                    }
                    if self.f & FH != 0 || (a & 0x0f) > 0x09 {
                        a += 0x06;
                    }
                } else {
                    if carry != 0 {
                        a -= 0x60;
                    }
                    if self.f & FH != 0 {
                        a -= 0x06;
                    }
                }
                a &= 0xff;
                self.a = a as u8;
                self.f = z(a == 0) | (self.f & FN) | carry;
            }
            0x2f => {
                self.a ^= 0xff;
                self.f |= FN | FH;
            }
            0x37 => self.f = (self.f & FZ) | FC,
            0x3f => self.f = (self.f & (FZ | FC)) ^ FC,
            0xc0 | 0xc8 | 0xd0 | 0xd8 => {
                self.tick();
                if self.cond(op >> 3) {
                    self.pc = self.pop();
                    self.tick();
                }
            }
            0xc9 => {
                self.pc = self.pop();
                self.tick();
            }
            0xd9 => {
                self.pc = self.pop();
                self.tick();
                self.ime = true;
            }
            0xc1 | 0xd1 | 0xe1 => {
                let v = self.pop();
                self.set_rr(op >> 4, v);
            }
            0xf1 => {
                let v = self.pop();
                self.a = (v >> 8) as u8;
                self.f = (v as u8) & 0xf0;
            }
            0xc5 | 0xd5 | 0xe5 => {
                let v = self.get_rr(op >> 4);
                self.push(v);
            }
            0xf5 => self.push(((self.a as u16) << 8) | self.f as u16),
            0xc2 | 0xca | 0xd2 | 0xda => {
                let addr = self.fetch16();
                if self.cond(op >> 3) {
                    self.tick();
                    self.pc = addr;
                }
            }
            0xc3 => {
                let addr = self.fetch16();
                self.tick();
                self.pc = addr;
            }
            0xc4 | 0xcc | 0xd4 | 0xdc => {
                let addr = self.fetch16();
                if self.cond(op >> 3) {
                    self.push(self.pc);
                    self.pc = addr;
                }
            }
            0xcd => {
                let addr = self.fetch16();
                self.push(self.pc);
                self.pc = addr;
            }
            0xc6 | 0xce | 0xd6 | 0xde | 0xe6 | 0xee | 0xf6 | 0xfe => {
                let v = self.fetch();
                self.alu(op >> 3, v);
            }
            0xc7 | 0xcf | 0xd7 | 0xdf | 0xe7 | 0xef | 0xf7 | 0xff => {
                self.push(self.pc);
                self.pc = (op & 0x38) as u16;
            }
            0xcb => {
                let cb = self.fetch();
                self.execute_cb(cb);
            }
            0xe0 => {
                let n = self.fetch() as u16;
                self.wr(0xff00 | n, self.a);
            }
            0xf0 => {
                let n = self.fetch() as u16;
                self.a = self.rd(0xff00 | n);
            }
            0xe2 => self.wr(0xff00 | self.c as u16, self.a),
            0xf2 => self.a = self.rd(0xff00 | self.c as u16),
            0xea => {
                let addr = self.fetch16();
                self.wr(addr, self.a);
            }
            0xfa => {
                let addr = self.fetch16();
                self.a = self.rd(addr);
            }
            0xe8 => {
                let r = self.add_sp_e();
                self.tick();
                self.tick();
                self.sp = r;
            }
            0xf8 => {
                let r = self.add_sp_e();
                self.tick();
                self.set_hl(r);
            }
            0xf9 => {
                self.tick();
                self.sp = self.hl();
            }
            0xe9 => self.pc = self.hl(),
            0xf3 => {
                self.ime = false;
                self.ei_pending = false;
            }
            0xfb => self.ei_pending = true,
            _ => self.locked = true,
        }
    }

    fn execute_cb(&mut self, op: u8) {
        let r = op & 7;
        let group = op >> 6;
        let bit = (op >> 3) & 7;
        if group == 1 {
            let v = self.get_r(r);
            self.f = (self.f & FC) | FH | z(v & (1 << bit) == 0);
            return;
        }
        let v = self.get_r(r);
        if group == 2 {
            self.set_r(r, v & !(1 << bit));
            return;
        }
        if group == 3 {
            self.set_r(r, v | (1 << bit));
            return;
        }
        let (res, carry) = match bit {
            0 => (v.rotate_left(1), v >> 7),
            1 => (v.rotate_right(1), v & 1),
            2 => ((v << 1) | ((self.f & FC) >> 4), v >> 7),
            3 => ((v >> 1) | ((self.f & FC) << 3), v & 1),
            4 => (v << 1, v >> 7),
            5 => ((v >> 1) | (v & 0x80), v & 1),
            6 => (v.rotate_left(4), 0),
            _ => (v >> 1, v & 1),
        };
        self.f = z(res == 0) | if carry != 0 { FC } else { 0 };
        self.set_r(r, res);
    }
}

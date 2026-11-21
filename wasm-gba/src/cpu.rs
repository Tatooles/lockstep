// ARM7TDMI interpreter (ARMv4T: ARM and Thumb).
//
// The pipeline is modelled the way the hardware exposes it: two prefetched
// opcodes, with r15 pointing two instructions past the one executing (+8 in
// ARM state, +4 in Thumb). Edge cases (empty register lists, r15 operands,
// writeback conflicts, the multiply carry flag) follow the SingleStepTests
// ARM7TDMI suite, which was generated from NanoBoyAdvance.

/// What the CPU needs from the outside world. `seq` marks sequential accesses
/// for waitstate timing. Reads take unaligned addresses; the bus aligns them
/// and the CPU applies the ARM7's rotation rules.
pub trait Bus {
    fn read8(&mut self, addr: u32, seq: bool) -> u32;
    fn read16(&mut self, addr: u32, seq: bool) -> u32;
    fn read32(&mut self, addr: u32, seq: bool) -> u32;
    fn write8(&mut self, addr: u32, v: u8, seq: bool);
    fn write16(&mut self, addr: u32, v: u16, seq: bool);
    fn write32(&mut self, addr: u32, v: u32, seq: bool);
    fn fetch16(&mut self, addr: u32, seq: bool) -> u32;
    fn fetch32(&mut self, addr: u32, seq: bool) -> u32;
    /// One internal (I) cycle.
    fn idle(&mut self);
    /// High-level BIOS hook for SWI `n`.
    fn swi(&mut self, cpu: &mut Cpu, n: u32) -> Swi;
    /// Side-effect-free halfword read, for code analysis.
    fn peek16(&mut self, _addr: u32) -> u32 {
        0
    }
    /// The CPU is spinning in a loop that cannot make progress before the next
    /// event: jump ahead to it.
    fn skip_idle(&mut self) {}
}

pub enum Swi {
    /// Take the real exception (vector 0x08).
    Exception,
    /// Handled; continue after the SWI.
    Done,
    /// Handled, but run the SWI again when the CPU resumes (IntrWait).
    Repeat,
    /// The hook set r15 and CPSR itself (SoftReset); refill the pipeline.
    Jump,
}

pub const MODE_USR: u32 = 0x10;
pub const MODE_FIQ: u32 = 0x11;
pub const MODE_IRQ: u32 = 0x12;
pub const MODE_SVC: u32 = 0x13;
pub const MODE_ABT: u32 = 0x17;
pub const MODE_UND: u32 = 0x1b;
pub const MODE_SYS: u32 = 0x1f;

const BANK_USR: usize = 0;
const BANK_FIQ: usize = 1;
const BANK_INVALID: usize = 6;

#[inline(always)]
fn bank_of(mode: u32) -> usize {
    match mode {
        MODE_USR | MODE_SYS => 0,
        MODE_FIQ => 1,
        MODE_SVC => 2,
        MODE_ABT => 3,
        MODE_IRQ => 4,
        MODE_UND => 5,
        _ => BANK_INVALID,
    }
}

#[derive(Clone)]
pub struct Cpu {
    pub r: [u32; 16],
    pub n: bool,
    pub z: bool,
    pub c: bool,
    pub v: bool,
    /// CPSR bits 0..27 (mode, T, F, I and the reserved bits). NZCV live above.
    pub cpsr: u32,
    /// Indexed by bank: 1 fiq, 2 svc, 3 abt, 4 irq, 5 und, 6 invalid mode.
    pub spsr: [u32; 7],
    /// Banked r8..r14 per bank (r8..r12 are only banked for FIQ).
    pub bank: [[u32; 7]; 7],
    pub pipe: [u32; 2],
    /// Whether the next code fetch is sequential.
    pub seq: bool,
    // Idle-loop detection (see idle_check).
    idle_pc: u32,
    idle_pure: bool,
    idle_seen: bool,
    idle_snap: [u32; 16],
    /// Instructions executed (counted only with the `stats` feature).
    pub insns: u64,
}

// ---- shifter ----

/// Shift by an immediate amount (LSR/ASR #0 mean #32, ROR #0 is RRX).
#[inline(always)]
fn shift_imm(kind: u32, v: u32, amt: u32, c: &mut bool) -> u32 {
    match kind {
        0 => {
            if amt == 0 {
                v
            } else {
                *c = (v >> (32 - amt)) & 1 != 0;
                v << amt
            }
        }
        1 => {
            if amt == 0 {
                *c = v >> 31 != 0;
                0
            } else {
                *c = (v >> (amt - 1)) & 1 != 0;
                v >> amt
            }
        }
        2 => {
            if amt == 0 {
                *c = v >> 31 != 0;
                ((v as i32) >> 31) as u32
            } else {
                *c = ((v as i32) >> (amt - 1)) & 1 != 0;
                ((v as i32) >> amt) as u32
            }
        }
        _ => {
            if amt == 0 {
                let r = (v >> 1) | ((*c as u32) << 31);
                *c = v & 1 != 0;
                r
            } else {
                let r = v.rotate_right(amt);
                *c = r >> 31 != 0;
                r
            }
        }
    }
}

/// Shift by a register amount (bottom byte; 0 leaves value and carry alone).
#[inline(always)]
fn shift_reg(kind: u32, v: u32, amt: u32, c: &mut bool) -> u32 {
    if amt == 0 {
        return v;
    }
    match kind {
        0 => {
            if amt < 32 {
                *c = (v >> (32 - amt)) & 1 != 0;
                v << amt
            } else {
                *c = amt == 32 && v & 1 != 0;
                0
            }
        }
        1 => {
            if amt < 32 {
                *c = (v >> (amt - 1)) & 1 != 0;
                v >> amt
            } else {
                *c = amt == 32 && v >> 31 != 0;
                0
            }
        }
        2 => {
            if amt < 32 {
                *c = ((v as i32) >> (amt - 1)) & 1 != 0;
                ((v as i32) >> amt) as u32
            } else {
                *c = v >> 31 != 0;
                ((v as i32) >> 31) as u32
            }
        }
        _ => {
            let r = v.rotate_right(amt & 31);
            *c = r >> 31 != 0;
            r
        }
    }
}

// ---- multiply carry ----
// The ARM7TDMI's multiplier leaves a deterministic value in C. This follows the
// carry-save Booth model published by zaydlang and calc84maniac (zlib license).

fn mul_carry_lo(multiplicand: u32, multiplier: u32, accum: u32) -> bool {
    let multiplicand = multiplicand | 1;
    let mut accum = accum;
    let mut booth = ((multiplier << 31) as i32 >> 31) as u32;
    let mut carry = multiplicand.wrapping_mul(booth);
    let mut sum = carry.wrapping_add(accum);
    let mut shift: i32 = 29;
    loop {
        for _ in 0..4 {
            let next = ((multiplier << shift) as i32 >> shift) as u32;
            let factor = next.wrapping_sub(booth);
            booth = next;
            let addend = multiplicand.wrapping_mul(factor);
            accum ^= carry ^ addend;
            sum = sum.wrapping_add(addend);
            carry = sum.wrapping_sub(accum);
            shift -= 2;
        }
        if booth == multiplier {
            break;
        }
    }
    carry >> 31 != 0
}

fn mul_carry_hi(multiplicand: u32, multiplier: u32, accum_hi: u32, signed: bool) -> bool {
    let (mut md, mr) = if signed {
        (((multiplicand as i32) >> 6) as u32, ((multiplier as i32) >> 26) as u32)
    } else {
        (multiplicand >> 6, multiplier >> 26)
    };
    md |= 1;
    let carry = !accum_hi & 0x2000_0000;
    let mut accum = accum_hi.wrapping_sub(0x0800_0000);
    let booth0 = ((mr << 27) as i32 >> 27) as u32;
    let booth1 = ((mr << 29) as i32 >> 29) as u32;
    let booth2 = ((mr << 31) as i32 >> 31) as u32;
    let factor0 = mr.wrapping_sub(booth0);
    let factor1 = booth0.wrapping_sub(booth1);
    let factor2 = booth1.wrapping_sub(booth2);
    let mut addend = md.wrapping_mul(factor2);
    accum = accum.wrapping_sub(addend & 0x1000_0000);
    addend = md.wrapping_mul(factor1);
    accum = accum.wrapping_sub(addend & 0x4000_0000);
    let mut sum = accum.wrapping_add(addend & 0x2000_0000);
    accum = accum.wrapping_sub(carry);
    addend = md.wrapping_mul(factor0);
    sum = sum.wrapping_add(addend & 0x4000_0000);
    (sum ^ accum) >> 31 != 0
}

// ---- decode tables ----

const A_DP: u8 = 0;
const A_PSR: u8 = 1;
const A_BX: u8 = 2;
const A_MUL: u8 = 3;
const A_MULL: u8 = 4;
const A_SWP: u8 = 5;
const A_HW: u8 = 6;
const A_SDT: u8 = 7;
const A_BLOCK: u8 = 8;
const A_B: u8 = 9;
const A_SWI: u8 = 10;
const A_UND: u8 = 11;

const fn arm_kind(i: u32) -> u8 {
    // i = bits 27..20 << 4 | bits 7..4
    let hi = i >> 4;
    let lo = i & 0xF;
    match hi >> 6 {
        0 => {
            if hi & 0x20 != 0 {
                let opc = (hi >> 1) & 0xF;
                if hi & 1 == 0 && opc >= 8 && opc <= 11 {
                    A_PSR
                } else {
                    A_DP
                }
            } else if hi == 0x12 && lo == 1 {
                A_BX
            } else if hi & 0x10 == 0 && lo == 9 {
                if hi & 0x08 != 0 {
                    A_MULL
                } else {
                    A_MUL
                }
            } else if hi & 0x10 != 0 && lo == 9 {
                A_SWP
            } else if lo == 0xB || lo == 0xD || lo == 0xF {
                A_HW
            } else {
                let opc = (hi >> 1) & 0xF;
                if hi & 1 == 0 && opc >= 8 && opc <= 11 {
                    A_PSR
                } else {
                    A_DP
                }
            }
        }
        1 => {
            if hi & 0x20 != 0 && lo & 1 != 0 {
                A_UND
            } else {
                A_SDT
            }
        }
        2 => {
            if hi & 0x20 != 0 {
                A_B
            } else {
                A_BLOCK
            }
        }
        _ => {
            if hi & 0x30 == 0x30 {
                A_SWI
            } else {
                A_UND
            }
        }
    }
}

const fn arm_table() -> [u8; 4096] {
    let mut t = [0u8; 4096];
    let mut i = 0;
    while i < 4096 {
        t[i] = arm_kind(i as u32);
        i += 1;
    }
    t
}

static ARM_TABLE: [u8; 4096] = arm_table();

const T_SHIFT: u8 = 0;
const T_ADDSUB: u8 = 1;
const T_IMM: u8 = 2;
const T_ALU: u8 = 3;
const T_HI: u8 = 4;
const T_LDRPC: u8 = 5;
const T_LSREG: u8 = 6;
const T_LSSIGN: u8 = 7;
const T_LSIMM: u8 = 8;
const T_LSH: u8 = 9;
const T_LSSP: u8 = 10;
const T_ADDR: u8 = 11;
const T_SPADD: u8 = 12;
const T_PUSHPOP: u8 = 13;
const T_LDMSTM: u8 = 14;
const T_BCC: u8 = 15;
const T_SWI: u8 = 16;
const T_B: u8 = 17;
const T_BL1: u8 = 18;
const T_BL2: u8 = 19;
const T_UND: u8 = 20;

const fn thumb_kind(i: u32) -> u8 {
    let op = i << 6;
    if op & 0xF800 < 0x1800 {
        T_SHIFT
    } else if op & 0xF800 == 0x1800 {
        T_ADDSUB
    } else if op & 0xE000 == 0x2000 {
        T_IMM
    } else if op & 0xFC00 == 0x4000 {
        T_ALU
    } else if op & 0xFC00 == 0x4400 {
        T_HI
    } else if op & 0xF800 == 0x4800 {
        T_LDRPC
    } else if op & 0xF200 == 0x5000 {
        T_LSREG
    } else if op & 0xF200 == 0x5200 {
        T_LSSIGN
    } else if op & 0xE000 == 0x6000 {
        T_LSIMM
    } else if op & 0xF000 == 0x8000 {
        T_LSH
    } else if op & 0xF000 == 0x9000 {
        T_LSSP
    } else if op & 0xF000 == 0xA000 {
        T_ADDR
    } else if op & 0xFF00 == 0xB000 {
        T_SPADD
    } else if op & 0xF600 == 0xB400 {
        T_PUSHPOP
    } else if op & 0xF000 == 0xC000 {
        T_LDMSTM
    } else if op & 0xFF00 < 0xDF00 && op & 0xF000 == 0xD000 {
        T_BCC
    } else if op & 0xFF00 == 0xDF00 {
        T_SWI
    } else if op & 0xF800 == 0xE000 {
        T_B
    } else if op & 0xF800 == 0xF000 {
        T_BL1
    } else if op & 0xF800 == 0xF800 {
        T_BL2
    } else {
        T_UND
    }
}

const fn thumb_table() -> [u8; 1024] {
    let mut t = [0u8; 1024];
    let mut i = 0;
    while i < 1024 {
        t[i] = thumb_kind(i as u32);
        i += 1;
    }
    t
}

static THUMB_TABLE: [u8; 1024] = thumb_table();

/// cond (4 bits) << 4 | NZCV -> passes
const fn cond_table() -> [bool; 256] {
    let mut t = [false; 256];
    let mut i = 0;
    while i < 256 {
        let cond = i >> 4;
        let n = i & 8 != 0;
        let z = i & 4 != 0;
        let c = i & 2 != 0;
        let v = i & 1 != 0;
        t[i] = match cond {
            0 => z,
            1 => !z,
            2 => c,
            3 => !c,
            4 => n,
            5 => !n,
            6 => v,
            7 => !v,
            8 => c && !z,
            9 => !c || z,
            10 => n == v,
            11 => n != v,
            12 => !z && n == v,
            13 => z || n != v,
            14 => true,
            _ => false,
        };
        i += 1;
    }
    t
}

static COND_TABLE: [bool; 256] = cond_table();

impl Default for Cpu {
    fn default() -> Self {
        Self::new()
    }
}

impl Cpu {
    pub fn new() -> Cpu {
        Cpu {
            r: [0; 16],
            n: false,
            z: false,
            c: false,
            v: false,
            cpsr: MODE_SVC | 0xC0,
            spsr: [0; 7],
            bank: [[0; 7]; 7],
            pipe: [0xF000_0000; 2],
            seq: false,
            idle_pc: 0,
            idle_pure: false,
            idle_seen: false,
            idle_snap: [0; 16],
            insns: 0,
        }
    }

    #[inline(always)]
    pub fn thumb(&self) -> bool {
        self.cpsr & 0x20 != 0
    }

    #[inline(always)]
    pub fn mode(&self) -> u32 {
        self.cpsr & 0x1F
    }

    #[inline(always)]
    pub fn irq_disabled(&self) -> bool {
        self.cpsr & 0x80 != 0
    }

    #[inline(always)]
    fn nzcv(&self) -> u32 {
        ((self.n as u32) << 3) | ((self.z as u32) << 2) | ((self.c as u32) << 1) | (self.v as u32)
    }

    #[inline(always)]
    fn check(&self, cond: u32) -> bool {
        COND_TABLE[((cond << 4) | self.nzcv()) as usize & 0xFF]
    }

    pub fn get_cpsr(&self) -> u32 {
        (self.cpsr & 0x0FFF_FFFF) | (self.nzcv() << 28)
    }

    /// Replace CPSR wholesale. The caller has already switched register banks.
    pub fn set_cpsr_raw(&mut self, v: u32) {
        self.cpsr = v & 0x0FFF_FFFF;
        self.n = v & (1 << 31) != 0;
        self.z = v & (1 << 30) != 0;
        self.c = v & (1 << 29) != 0;
        self.v = v & (1 << 28) != 0;
    }

    /// Write CPSR, switching register banks for the new mode.
    pub fn set_cpsr(&mut self, v: u32) {
        self.switch_mode(v & 0x1F);
        self.set_cpsr_raw(v);
    }

    fn get_spsr(&self) -> u32 {
        let b = bank_of(self.mode());
        if b == BANK_USR {
            self.get_cpsr() | 0x10
        } else {
            self.spsr[b] | 0x10
        }
    }

    pub fn switch_mode(&mut self, mode: u32) {
        let old = bank_of(self.mode());
        let new = bank_of(mode);
        self.cpsr = (self.cpsr & !0x1F) | mode;
        if old == new {
            return;
        }
        if old == BANK_FIQ {
            self.bank[BANK_FIQ][..5].copy_from_slice(&self.r[8..13]);
            self.r[8..13].copy_from_slice(&self.bank[BANK_USR][..5]);
        } else if new == BANK_FIQ {
            self.bank[BANK_USR][..5].copy_from_slice(&self.r[8..13]);
            self.r[8..13].copy_from_slice(&self.bank[BANK_FIQ][..5]);
        }
        self.bank[old][5] = self.r[13];
        self.bank[old][6] = self.r[14];
        if new != BANK_INVALID {
            self.r[13] = self.bank[new][5];
            self.r[14] = self.bank[new][6];
        } else {
            for i in 8..15 {
                self.r[i] = 0;
            }
            self.spsr[BANK_INVALID] = 0;
        }
    }

    /// Set up as the BIOS leaves things before jumping to the cartridge.
    pub fn skip_bios(&mut self, entry: u32) {
        self.set_cpsr(MODE_IRQ | 0xC0);
        self.r[13] = 0x0300_7FA0;
        self.set_cpsr(MODE_SVC | 0xC0);
        self.r[13] = 0x0300_7FE0;
        self.set_cpsr(MODE_SYS);
        self.r[13] = 0x0300_7F00;
        self.r[15] = entry;
    }

    // ---- pipeline ----

    pub fn reload<B: Bus>(&mut self, bus: &mut B) {
        if self.thumb() {
            self.reload16(bus);
        } else {
            self.reload32(bus);
        }
    }

    #[inline]
    fn reload32<B: Bus>(&mut self, bus: &mut B) {
        let pc = self.r[15];
        self.pipe[0] = bus.fetch32(pc, false);
        self.pipe[1] = bus.fetch32(pc.wrapping_add(4), true);
        self.r[15] = pc.wrapping_add(8);
        self.seq = true;
    }

    #[inline]
    fn reload16<B: Bus>(&mut self, bus: &mut B) {
        let pc = self.r[15];
        self.pipe[0] = bus.fetch16(pc, false);
        self.pipe[1] = bus.fetch16(pc.wrapping_add(2), true);
        self.r[15] = pc.wrapping_add(4);
        self.seq = true;
    }

    /// Address of the next instruction to execute.
    pub fn next_pc(&self) -> u32 {
        if self.thumb() {
            self.r[15].wrapping_sub(4)
        } else {
            self.r[15].wrapping_sub(8)
        }
    }

    fn exception<B: Bus>(&mut self, bus: &mut B, mode: u32, vector: u32, lr: u32) {
        let cpsr = self.get_cpsr();
        self.spsr[bank_of(mode)] = cpsr;
        self.switch_mode(mode);
        self.cpsr = (self.cpsr | 0x80) & !0x20;
        self.r[14] = lr;
        self.r[15] = vector;
        self.reload32(bus);
    }

    /// Take an IRQ (the caller checks IME/IE/IF and the I flag).
    pub fn irq<B: Bus>(&mut self, bus: &mut B) {
        let pc = self.r[15];
        let lr = if self.thumb() {
            bus.fetch16(pc, self.seq);
            pc
        } else {
            bus.fetch32(pc, self.seq);
            pc.wrapping_sub(4)
        };
        self.exception(bus, MODE_IRQ, 0x18, lr);
    }

    // ---- execution ----

    #[inline(always)]
    pub fn step<B: Bus>(&mut self, bus: &mut B) {
        #[cfg(feature = "stats")]
        {
            self.insns += 1;
        }
        self.r[15] &= !1;
        let op = self.pipe[0];
        self.pipe[0] = self.pipe[1];
        if self.cpsr & 0x20 != 0 {
            self.pipe[1] = bus.fetch16(self.r[15], self.seq);
            self.exec_thumb(bus, op);
        } else {
            self.pipe[1] = bus.fetch32(self.r[15], self.seq);
            let cond = op >> 28;
            if cond == 0xE || self.check(cond) {
                self.exec_arm(bus, op);
            } else {
                self.seq = true;
                self.r[15] = self.r[15].wrapping_add(4);
            }
        }
    }

    #[inline(always)]
    fn set_nz(&mut self, v: u32) {
        self.n = v >> 31 != 0;
        self.z = v == 0;
    }

    #[inline(always)]
    fn add(&mut self, a: u32, b: u32, s: bool) -> u32 {
        let r = a.wrapping_add(b);
        if s {
            self.set_nz(r);
            self.c = r < a;
            self.v = (!(a ^ b) & (b ^ r)) >> 31 != 0;
        }
        r
    }

    #[inline(always)]
    fn adc(&mut self, a: u32, b: u32, s: bool) -> u32 {
        let wide = a as u64 + b as u64 + self.c as u64;
        let r = wide as u32;
        if s {
            self.set_nz(r);
            self.c = wide >> 32 != 0;
            self.v = (!(a ^ b) & (b ^ r)) >> 31 != 0;
        }
        r
    }

    #[inline(always)]
    fn sub(&mut self, a: u32, b: u32, s: bool) -> u32 {
        let r = a.wrapping_sub(b);
        if s {
            self.set_nz(r);
            self.c = a >= b;
            self.v = ((a ^ b) & (a ^ r)) >> 31 != 0;
        }
        r
    }

    #[inline(always)]
    fn sbc(&mut self, a: u32, b: u32, s: bool) -> u32 {
        let borrow = !self.c as u32;
        let r = a.wrapping_sub(b).wrapping_sub(borrow);
        if s {
            self.set_nz(r);
            self.c = a as u64 >= b as u64 + borrow as u64;
            self.v = ((a ^ b) & (a ^ r)) >> 31 != 0;
        }
        r
    }

    fn tick_multiply<B: Bus>(bus: &mut B, multiplier: u32, signed: bool) -> bool {
        let mut m = multiplier;
        let mut mask: u32 = 0xFFFF_FF00;
        bus.idle();
        loop {
            m &= mask;
            if m == 0 || (signed && m == mask) {
                break;
            }
            mask <<= 8;
            bus.idle();
        }
        mask == 0
    }

    // ---- ARM ----

    #[inline(always)]
    fn exec_arm<B: Bus>(&mut self, bus: &mut B, op: u32) {
        let idx = (((op >> 16) & 0xFF0) | ((op >> 4) & 0xF)) as usize;
        match ARM_TABLE[idx] {
            A_DP => self.arm_dp(bus, op),
            A_PSR => self.arm_psr(op),
            A_BX => self.arm_bx(bus, op),
            A_MUL => self.arm_mul(bus, op),
            A_MULL => self.arm_mull(bus, op),
            A_SWP => self.arm_swp(bus, op),
            A_HW => self.arm_hw(bus, op),
            A_SDT => self.arm_sdt(bus, op),
            A_BLOCK => self.arm_block(bus, op),
            A_B => self.arm_b(bus, op),
            A_SWI => self.arm_swi(bus, op),
            _ => self.arm_und(bus),
        }
    }

    fn arm_dp<B: Bus>(&mut self, bus: &mut B, op: u32) {
        let opc = (op >> 21) & 0xF;
        let s = op & (1 << 20) != 0;
        let rd = ((op >> 12) & 0xF) as usize;
        let rn = ((op >> 16) & 0xF) as usize;
        let mut carry = self.c;
        let op1;
        let op2;
        let reg_shift = op & (1 << 25) == 0 && op & 0x10 != 0;
        self.seq = true;
        if op & (1 << 25) != 0 {
            let v = op & 0xFF;
            let rot = ((op >> 8) & 0xF) * 2;
            if rot != 0 {
                op2 = v.rotate_right(rot);
                carry = op2 >> 31 != 0;
            } else {
                op2 = v;
            }
            op1 = self.r[rn];
        } else if reg_shift {
            let amt = self.r[((op >> 8) & 0xF) as usize] & 0xFF;
            self.r[15] = self.r[15].wrapping_add(4);
            bus.idle();
            self.seq = false;
            op1 = self.r[rn];
            op2 = shift_reg((op >> 5) & 3, self.r[(op & 0xF) as usize], amt, &mut carry);
        } else {
            op1 = self.r[rn];
            op2 = shift_imm((op >> 5) & 3, self.r[(op & 0xF) as usize], (op >> 7) & 0x1F, &mut carry);
        }

        let result = match opc {
            0 => op1 & op2,
            1 => op1 ^ op2,
            2 => self.sub(op1, op2, s),
            3 => self.sub(op2, op1, s),
            4 => self.add(op1, op2, s),
            5 => self.adc(op1, op2, s),
            6 => self.sbc(op1, op2, s),
            7 => self.sbc(op2, op1, s),
            8 => op1 & op2,
            9 => op1 ^ op2,
            10 => self.sub(op1, op2, true),
            11 => self.add(op1, op2, true),
            12 => op1 | op2,
            13 => op2,
            14 => op1 & !op2,
            _ => !op2,
        };
        let logical = matches!(opc, 0 | 1 | 8 | 9 | 12..=15);
        if logical && (s || opc == 8 || opc == 9) {
            self.set_nz(result);
            self.c = carry;
        }
        let test = (8..=11).contains(&opc);
        if !test {
            self.r[rd] = result;
        }

        if rd == 15 {
            if s {
                let spsr = self.get_spsr();
                self.set_cpsr(spsr);
            }
            if !test {
                self.reload(bus);
            } else if !reg_shift {
                self.r[15] = self.r[15].wrapping_add(4);
            }
        } else if !reg_shift {
            self.r[15] = self.r[15].wrapping_add(4);
        }
    }

    fn arm_psr(&mut self, op: u32) {
        let use_spsr = op & (1 << 22) != 0;
        if op & (1 << 21) != 0 {
            let mut mask = 0u32;
            if op & (1 << 16) != 0 {
                mask |= 0x0000_00FF;
            }
            if op & (1 << 17) != 0 {
                mask |= 0x0000_FF00;
            }
            if op & (1 << 18) != 0 {
                mask |= 0x00FF_0000;
            }
            if op & (1 << 19) != 0 {
                mask |= 0xFF00_0000;
            }
            let mut val = if op & (1 << 25) != 0 {
                (op & 0xFF).rotate_right(((op >> 8) & 0xF) * 2)
            } else {
                self.r[(op & 0xF) as usize]
            };
            if !use_spsr {
                if self.mode() == MODE_USR {
                    mask &= 0xFF00_0000;
                }
                if mask & 0xFF != 0 {
                    val |= 0x10;
                    self.switch_mode(val & 0x1F);
                }
                let cur = self.get_cpsr();
                self.set_cpsr_raw((cur & !mask) | (val & mask));
            } else {
                let b = bank_of(self.mode());
                if b != BANK_USR && b != BANK_INVALID {
                    self.spsr[b] = (self.get_spsr() & !mask) | (val & mask);
                }
            }
        } else {
            let rd = ((op >> 12) & 0xF) as usize;
            self.r[rd] = if use_spsr { self.get_spsr() } else { self.get_cpsr() };
        }
        self.seq = true;
        self.r[15] = self.r[15].wrapping_add(4);
    }

    fn arm_bx<B: Bus>(&mut self, bus: &mut B, op: u32) {
        let addr = self.r[(op & 0xF) as usize];
        if addr & 1 != 0 {
            self.r[15] = addr & !1;
            self.cpsr |= 0x20;
            self.reload16(bus);
        } else {
            self.r[15] = addr;
            self.reload32(bus);
        }
    }

    fn arm_mul<B: Bus>(&mut self, bus: &mut B, op: u32) {
        let rm = (op & 0xF) as usize;
        let rs = ((op >> 8) & 0xF) as usize;
        let rn = ((op >> 12) & 0xF) as usize;
        let rd = ((op >> 16) & 0xF) as usize;
        self.seq = false;
        self.r[15] = self.r[15].wrapping_add(4);
        let lhs = self.r[rm];
        let rhs = self.r[rs];
        let mut result = lhs.wrapping_mul(rhs);
        let full = Self::tick_multiply(bus, rhs, true);
        let mut accum = 0;
        if op & (1 << 21) != 0 {
            accum = self.r[rn];
            result = result.wrapping_add(accum);
            bus.idle();
        }
        if op & (1 << 20) != 0 {
            self.set_nz(result);
            self.c = if full { rhs >> 30 == 2 } else { mul_carry_lo(lhs, rhs, accum) };
        }
        self.r[rd] = result;
        if rd == 15 {
            self.reload32(bus);
        }
    }

    fn arm_mull<B: Bus>(&mut self, bus: &mut B, op: u32) {
        let rm = (op & 0xF) as usize;
        let rs = ((op >> 8) & 0xF) as usize;
        let rlo = ((op >> 12) & 0xF) as usize;
        let rhi = ((op >> 16) & 0xF) as usize;
        let signed = op & (1 << 22) != 0;
        self.seq = false;
        self.r[15] = self.r[15].wrapping_add(4);
        let lhs = self.r[rm];
        let rhs = self.r[rs];
        let mut result = if signed {
            (lhs as i32 as i64).wrapping_mul(rhs as i32 as i64) as u64
        } else {
            (lhs as u64) * (rhs as u64)
        };
        let full = Self::tick_multiply(bus, rhs, signed);
        bus.idle();
        let mut alo = 0;
        let mut ahi = 0;
        if op & (1 << 21) != 0 {
            alo = self.r[rlo];
            ahi = self.r[rhi];
            result = result.wrapping_add(((ahi as u64) << 32) | alo as u64);
            bus.idle();
        }
        let hi = (result >> 32) as u32;
        if op & (1 << 20) != 0 {
            self.n = hi >> 31 != 0;
            self.z = result == 0;
            self.c = if full {
                mul_carry_hi(lhs, rhs, ahi, signed)
            } else {
                mul_carry_lo(lhs, rhs, alo)
            };
        }
        self.r[rlo] = result as u32;
        self.r[rhi] = hi;
        if rlo == 15 || rhi == 15 {
            self.reload32(bus);
        }
    }

    fn arm_swp<B: Bus>(&mut self, bus: &mut B, op: u32) {
        let rm = (op & 0xF) as usize;
        let rd = ((op >> 12) & 0xF) as usize;
        let rn = ((op >> 16) & 0xF) as usize;
        self.seq = false;
        self.r[15] = self.r[15].wrapping_add(4);
        let addr = self.r[rn];
        let tmp = if op & (1 << 22) != 0 {
            let v = bus.read8(addr, false);
            bus.write8(self.r[rn], self.r[rm] as u8, false);
            v
        } else {
            let v = bus.read32(addr, false).rotate_right((addr & 3) * 8);
            bus.write32(self.r[rn], self.r[rm], false);
            v
        };
        bus.idle();
        self.r[rd] = tmp;
        if rd == 15 {
            self.reload32(bus);
        }
    }

    #[inline(always)]
    fn load_half_rotate<B: Bus>(bus: &mut B, addr: u32) -> u32 {
        let v = bus.read16(addr, false);
        if addr & 1 != 0 {
            v.rotate_right(8)
        } else {
            v
        }
    }

    #[inline(always)]
    fn load_half_signed<B: Bus>(bus: &mut B, addr: u32) -> u32 {
        if addr & 1 != 0 {
            bus.read8(addr, false) as u8 as i8 as i32 as u32
        } else {
            bus.read16(addr, false) as u16 as i16 as i32 as u32
        }
    }

    fn arm_hw<B: Bus>(&mut self, bus: &mut B, op: u32) {
        let rd = ((op >> 12) & 0xF) as usize;
        let rn = ((op >> 16) & 0xF) as usize;
        let pre = op & (1 << 24) != 0;
        let up = op & (1 << 23) != 0;
        let wb = op & (1 << 21) != 0 || !pre;
        let load = op & (1 << 20) != 0;
        let mut addr = self.r[rn];
        let mut offset = if op & (1 << 22) != 0 {
            (op & 0xF) | ((op >> 4) & 0xF0)
        } else {
            self.r[(op & 0xF) as usize]
        };
        self.seq = false;
        self.r[15] = self.r[15].wrapping_add(4);
        if !up {
            offset = offset.wrapping_neg();
        }
        if pre {
            addr = addr.wrapping_add(offset);
        }
        match (op >> 5) & 3 {
            1 => {
                if load {
                    let v = Self::load_half_rotate(bus, addr);
                    if wb {
                        self.r[rn] = self.r[rn].wrapping_add(offset);
                    }
                    bus.idle();
                    self.r[rd] = v;
                } else {
                    bus.write16(addr, self.r[rd] as u16, false);
                    if wb {
                        self.r[rn] = self.r[rn].wrapping_add(offset);
                    }
                }
            }
            2 => {
                if load {
                    let v = bus.read8(addr, false) as u8 as i8 as i32 as u32;
                    if wb {
                        self.r[rn] = self.r[rn].wrapping_add(offset);
                    }
                    bus.idle();
                    self.r[rd] = v;
                } else {
                    bus.idle();
                    if wb {
                        self.r[rn] = self.r[rn].wrapping_add(offset);
                    }
                    bus.idle();
                }
            }
            3 => {
                if load {
                    let v = Self::load_half_signed(bus, addr);
                    if wb {
                        self.r[rn] = self.r[rn].wrapping_add(offset);
                    }
                    bus.idle();
                    self.r[rd] = v;
                } else {
                    bus.idle();
                    if wb {
                        self.r[rn] = self.r[rn].wrapping_add(offset);
                    }
                }
            }
            _ => {}
        }
        if (load && rd == 15) || (wb && rn == 15) {
            self.reload32(bus);
        }
    }

    fn arm_sdt<B: Bus>(&mut self, bus: &mut B, op: u32) {
        let rd = ((op >> 12) & 0xF) as usize;
        let rn = ((op >> 16) & 0xF) as usize;
        let pre = op & (1 << 24) != 0;
        let up = op & (1 << 23) != 0;
        let byte = op & (1 << 22) != 0;
        let wb = op & (1 << 21) != 0 || !pre;
        let load = op & (1 << 20) != 0;
        let mut addr = self.r[rn];
        let mut offset = if op & (1 << 25) == 0 {
            op & 0xFFF
        } else {
            let mut c = self.c;
            shift_imm((op >> 5) & 3, self.r[(op & 0xF) as usize], (op >> 7) & 0x1F, &mut c)
        };
        self.seq = false;
        self.r[15] = self.r[15].wrapping_add(4);
        if !up {
            offset = offset.wrapping_neg();
        }
        if pre {
            addr = addr.wrapping_add(offset);
        }
        if load {
            let v = if byte {
                bus.read8(addr, false)
            } else {
                bus.read32(addr, false).rotate_right((addr & 3) * 8)
            };
            if wb {
                self.r[rn] = self.r[rn].wrapping_add(offset);
            }
            bus.idle();
            self.r[rd] = v;
            if rd == 15 {
                self.reload32(bus);
            }
        } else {
            if byte {
                bus.write8(addr, self.r[rd] as u8, false);
            } else {
                bus.write32(addr, self.r[rd], false);
            }
            if wb {
                self.r[rn] = self.r[rn].wrapping_add(offset);
            }
        }
        if wb && rn == 15 && !(load && rd == 15) {
            self.reload32(bus);
        }
    }

    fn arm_block<B: Bus>(&mut self, bus: &mut B, op: u32) {
        let rn = ((op >> 16) & 0xF) as usize;
        let mut list = op & 0xFFFF;
        let mut pre = op & (1 << 24) != 0;
        let up = op & (1 << 23) != 0;
        let user = op & (1 << 22) != 0;
        let wb = op & (1 << 21) != 0;
        let load = op & (1 << 20) != 0;
        let mode = self.mode();
        let mut transfer_pc = list & 0x8000 != 0;
        let bytes;
        let first;
        if list != 0 {
            bytes = list.count_ones() * 4;
            first = list.trailing_zeros() as usize;
        } else {
            list = 0x8000;
            first = 15;
            transfer_pc = true;
            bytes = 64;
        }
        let switch = user && (!load || !transfer_pc) && mode != MODE_USR && mode != MODE_SYS;
        let mut addr = self.r[rn];
        if switch {
            self.switch_mode(MODE_USR);
        }
        let base_new;
        if !up {
            pre = !pre;
            addr = addr.wrapping_sub(bytes);
            base_new = addr;
        } else {
            base_new = addr.wrapping_add(bytes);
        }
        self.seq = false;
        self.r[15] = self.r[15].wrapping_add(4);
        let mut seq = false;
        let mut i = first;
        while i < 16 {
            if list & (1 << i) != 0 {
                if pre {
                    addr = addr.wrapping_add(4);
                }
                if load {
                    let v = bus.read32(addr, seq);
                    if wb && i == first {
                        self.r[rn] = base_new;
                    }
                    self.r[i] = v;
                } else {
                    bus.write32(addr, self.r[i], seq);
                    if wb && i == first {
                        self.r[rn] = base_new;
                    }
                }
                if !pre {
                    addr = addr.wrapping_add(4);
                }
                seq = true;
            }
            i += 1;
        }
        if load {
            bus.idle();
            if transfer_pc {
                if user {
                    let spsr = self.get_spsr();
                    self.set_cpsr(spsr);
                }
                self.reload(bus);
            }
        }
        if switch {
            self.switch_mode(mode);
        }
        if wb && rn == 15 && !(load && transfer_pc) {
            self.reload32(bus);
        }
    }

    fn arm_b<B: Bus>(&mut self, bus: &mut B, op: u32) {
        let off = ((op << 8) as i32 >> 6) as u32;
        if op & (1 << 24) != 0 {
            self.r[14] = self.r[15].wrapping_sub(4);
        }
        self.r[15] = self.r[15].wrapping_add(off);
        self.reload32(bus);
    }

    fn arm_swi<B: Bus>(&mut self, bus: &mut B, op: u32) {
        match bus.swi(self, (op >> 16) & 0xFF) {
            Swi::Exception => {
                let lr = self.r[15].wrapping_sub(4);
                self.exception(bus, MODE_SVC, 0x08, lr);
            }
            Swi::Done => {
                self.seq = false;
                self.r[15] = self.r[15].wrapping_add(4);
            }
            Swi::Repeat => {
                self.r[15] = self.r[15].wrapping_sub(8);
                self.reload32(bus);
            }
            Swi::Jump => self.reload(bus),
        }
    }

    fn arm_und<B: Bus>(&mut self, bus: &mut B) {
        let lr = self.r[15].wrapping_sub(4);
        self.exception(bus, MODE_UND, 0x04, lr);
    }

    // ---- Thumb ----

    #[inline(always)]
    fn exec_thumb<B: Bus>(&mut self, bus: &mut B, op: u32) {
        match THUMB_TABLE[(op >> 6) as usize & 0x3FF] {
            T_SHIFT => {
                let rd = (op & 7) as usize;
                let mut c = self.c;
                let r = shift_imm((op >> 11) & 3, self.r[((op >> 3) & 7) as usize], (op >> 6) & 0x1F, &mut c);
                self.c = c;
                self.set_nz(r);
                self.r[rd] = r;
                self.seq = true;
                self.r[15] = self.r[15].wrapping_add(2);
            }
            T_ADDSUB => {
                let rd = (op & 7) as usize;
                let a = self.r[((op >> 3) & 7) as usize];
                let f = (op >> 6) & 7;
                let b = if op & (1 << 10) != 0 { f } else { self.r[f as usize] };
                self.r[rd] = if op & (1 << 9) != 0 { self.sub(a, b, true) } else { self.add(a, b, true) };
                self.seq = true;
                self.r[15] = self.r[15].wrapping_add(2);
            }
            T_IMM => {
                let rd = ((op >> 8) & 7) as usize;
                let imm = op & 0xFF;
                match (op >> 11) & 3 {
                    0 => {
                        self.r[rd] = imm;
                        self.n = false;
                        self.z = imm == 0;
                    }
                    1 => {
                        self.sub(self.r[rd], imm, true);
                    }
                    2 => self.r[rd] = self.add(self.r[rd], imm, true),
                    _ => self.r[rd] = self.sub(self.r[rd], imm, true),
                }
                self.seq = true;
                self.r[15] = self.r[15].wrapping_add(2);
            }
            T_ALU => self.thumb_alu(bus, op),
            T_HI => self.thumb_hi(bus, op),
            T_LDRPC => {
                let addr = (self.r[15] & !2).wrapping_add((op & 0xFF) << 2);
                self.seq = false;
                self.r[15] = self.r[15].wrapping_add(2);
                self.r[((op >> 8) & 7) as usize] = bus.read32(addr, false);
                bus.idle();
            }
            T_LSREG => {
                let rd = (op & 7) as usize;
                let addr = self.r[((op >> 3) & 7) as usize].wrapping_add(self.r[((op >> 6) & 7) as usize]);
                self.seq = false;
                self.r[15] = self.r[15].wrapping_add(2);
                match (op >> 10) & 3 {
                    0 => bus.write32(addr, self.r[rd], false),
                    1 => bus.write8(addr, self.r[rd] as u8, false),
                    2 => {
                        self.r[rd] = bus.read32(addr, false).rotate_right((addr & 3) * 8);
                        bus.idle();
                    }
                    _ => {
                        self.r[rd] = bus.read8(addr, false);
                        bus.idle();
                    }
                }
            }
            T_LSSIGN => {
                let rd = (op & 7) as usize;
                let addr = self.r[((op >> 3) & 7) as usize].wrapping_add(self.r[((op >> 6) & 7) as usize]);
                self.seq = false;
                self.r[15] = self.r[15].wrapping_add(2);
                match (op >> 10) & 3 {
                    0 => bus.write16(addr, self.r[rd] as u16, false),
                    1 => {
                        self.r[rd] = bus.read8(addr, false) as u8 as i8 as i32 as u32;
                        bus.idle();
                    }
                    2 => {
                        self.r[rd] = Self::load_half_rotate(bus, addr);
                        bus.idle();
                    }
                    _ => {
                        self.r[rd] = Self::load_half_signed(bus, addr);
                        bus.idle();
                    }
                }
            }
            T_LSIMM => {
                let rd = (op & 7) as usize;
                let base = self.r[((op >> 3) & 7) as usize];
                let imm = (op >> 6) & 0x1F;
                self.seq = false;
                self.r[15] = self.r[15].wrapping_add(2);
                match (op >> 11) & 3 {
                    0 => bus.write32(base.wrapping_add(imm * 4), self.r[rd], false),
                    1 => {
                        let addr = base.wrapping_add(imm * 4);
                        self.r[rd] = bus.read32(addr, false).rotate_right((addr & 3) * 8);
                        bus.idle();
                    }
                    2 => bus.write8(base.wrapping_add(imm), self.r[rd] as u8, false),
                    _ => {
                        self.r[rd] = bus.read8(base.wrapping_add(imm), false);
                        bus.idle();
                    }
                }
            }
            T_LSH => {
                let rd = (op & 7) as usize;
                let addr = self.r[((op >> 3) & 7) as usize].wrapping_add(((op >> 6) & 0x1F) * 2);
                self.seq = false;
                self.r[15] = self.r[15].wrapping_add(2);
                if op & (1 << 11) != 0 {
                    self.r[rd] = Self::load_half_rotate(bus, addr);
                    bus.idle();
                } else {
                    bus.write16(addr, self.r[rd] as u16, false);
                }
            }
            T_LSSP => {
                let rd = ((op >> 8) & 7) as usize;
                let addr = self.r[13].wrapping_add((op & 0xFF) * 4);
                self.seq = false;
                self.r[15] = self.r[15].wrapping_add(2);
                if op & (1 << 11) != 0 {
                    self.r[rd] = bus.read32(addr, false).rotate_right((addr & 3) * 8);
                    bus.idle();
                } else {
                    bus.write32(addr, self.r[rd], false);
                }
            }
            T_ADDR => {
                let rd = ((op >> 8) & 7) as usize;
                let off = (op & 0xFF) << 2;
                self.r[rd] = if op & (1 << 11) != 0 {
                    self.r[13].wrapping_add(off)
                } else {
                    (self.r[15] & !2).wrapping_add(off)
                };
                self.seq = true;
                self.r[15] = self.r[15].wrapping_add(2);
            }
            T_SPADD => {
                let off = (op & 0x7F) * 4;
                self.r[13] = if op & 0x80 != 0 {
                    self.r[13].wrapping_sub(off)
                } else {
                    self.r[13].wrapping_add(off)
                };
                self.seq = true;
                self.r[15] = self.r[15].wrapping_add(2);
            }
            T_PUSHPOP => self.thumb_pushpop(bus, op),
            T_LDMSTM => self.thumb_ldmstm(bus, op),
            T_BCC => {
                if self.check((op >> 8) & 0xF) {
                    let off = ((op << 24) as i32 >> 23) as u32;
                    if (off as i32) < 0 && (off as i32) >= -64 {
                        self.idle_check(bus, self.r[15].wrapping_sub(4), self.r[15].wrapping_add(off));
                    }
                    self.r[15] = self.r[15].wrapping_add(off);
                    self.reload16(bus);
                } else {
                    self.seq = true;
                    self.r[15] = self.r[15].wrapping_add(2);
                }
            }
            T_SWI => match bus.swi(self, op & 0xFF) {
                Swi::Exception => {
                    let lr = self.r[15].wrapping_sub(2);
                    self.exception(bus, MODE_SVC, 0x08, lr);
                }
                Swi::Done => {
                    self.seq = false;
                    self.r[15] = self.r[15].wrapping_add(2);
                }
                Swi::Repeat => {
                    self.r[15] = self.r[15].wrapping_sub(4);
                    self.reload16(bus);
                }
                Swi::Jump => self.reload(bus),
            },
            T_B => {
                let off = ((op << 21) as i32 >> 20) as u32;
                if (off as i32) < 0 && (off as i32) >= -64 {
                    self.idle_check(bus, self.r[15].wrapping_sub(4), self.r[15].wrapping_add(off));
                }
                self.r[15] = self.r[15].wrapping_add(off);
                self.reload16(bus);
            }
            T_BL1 => {
                let off = ((op << 21) as i32 >> 9) as u32;
                self.r[14] = self.r[15].wrapping_add(off);
                self.seq = true;
                self.r[15] = self.r[15].wrapping_add(2);
            }
            T_BL2 => {
                let next = self.r[15].wrapping_sub(2);
                self.r[15] = self.r[14].wrapping_add((op & 0x7FF) << 1) & !1;
                self.r[14] = next | 1;
                self.reload16(bus);
            }
            _ => {}
        }
    }

    /// Idle-loop detection, for games that busy-wait (e.g. on a RAM flag their
    /// VBlank handler sets) instead of halting. Called on short backward Thumb
    /// branches. If the loop body only reads memory and computes, and two
    /// consecutive iterations end with identical registers and flags, nothing
    /// can change until the next event (interrupt, DMA, timer), so time skips
    /// ahead to it.
    #[cold]
    #[inline(never)]
    fn idle_check<B: Bus>(&mut self, bus: &mut B, branch: u32, target: u32) {
        if branch != self.idle_pc {
            self.idle_pc = branch;
            self.idle_pure = Self::loop_is_pure(bus, target, branch);
            self.idle_seen = false;
        }
        if !self.idle_pure {
            return;
        }
        let mut snap = [0u32; 16];
        snap[..15].copy_from_slice(&self.r[..15]);
        snap[15] = self.nzcv();
        if self.idle_seen && snap == self.idle_snap {
            bus.skip_idle();
        }
        self.idle_snap = snap;
        self.idle_seen = true;
    }

    /// True if the Thumb code in [start, end) only loads, computes and branches.
    fn loop_is_pure<B: Bus>(bus: &mut B, start: u32, end: u32) -> bool {
        let mut a = start;
        while a < end {
            let op = bus.peek16(a);
            let ok = match THUMB_TABLE[(op >> 6) as usize & 0x3FF] {
                T_SHIFT | T_ADDSUB | T_IMM | T_ALU | T_LDRPC | T_ADDR | T_BCC => true,
                T_HI => (op >> 8) & 3 != 3 && ((op & 7) | ((op >> 4) & 8)) != 15,
                T_LSREG => op & (1 << 11) != 0,
                T_LSSIGN => (op >> 10) & 3 != 0,
                T_LSIMM | T_LSH | T_LSSP => op & (1 << 11) != 0,
                _ => false,
            };
            if !ok {
                return false;
            }
            a += 2;
        }
        true
    }

    fn thumb_alu<B: Bus>(&mut self, bus: &mut B, op: u32) {
        let rd = (op & 7) as usize;
        let rs = ((op >> 3) & 7) as usize;
        self.seq = true;
        self.r[15] = self.r[15].wrapping_add(2);
        let a = self.r[rd];
        let b = self.r[rs];
        match (op >> 6) & 0xF {
            0 => {
                self.r[rd] = a & b;
                self.set_nz(a & b);
            }
            1 => {
                self.r[rd] = a ^ b;
                self.set_nz(a ^ b);
            }
            k @ (2 | 3 | 4 | 7) => {
                bus.idle();
                self.seq = false;
                let mut c = self.c;
                let kind = match k {
                    2 => 0,
                    3 => 1,
                    4 => 2,
                    _ => 3,
                };
                let r = shift_reg(kind, a, b & 0xFF, &mut c);
                self.r[rd] = r;
                self.set_nz(r);
                self.c = c;
            }
            5 => self.r[rd] = self.adc(a, b, true),
            6 => self.r[rd] = self.sbc(a, b, true),
            8 => self.set_nz(a & b),
            9 => self.r[rd] = self.sub(0, b, true),
            10 => {
                self.sub(a, b, true);
            }
            11 => {
                self.add(a, b, true);
            }
            12 => {
                self.r[rd] = a | b;
                self.set_nz(a | b);
            }
            13 => {
                let full = Self::tick_multiply(bus, a, true);
                self.seq = false;
                let r = b.wrapping_mul(a);
                self.r[rd] = r;
                self.set_nz(r);
                self.c = if full { a >> 30 == 2 } else { mul_carry_lo(b, a, 0) };
            }
            14 => {
                self.r[rd] = a & !b;
                self.set_nz(a & !b);
            }
            _ => {
                self.r[rd] = !b;
                self.set_nz(!b);
            }
        }
    }

    fn thumb_hi<B: Bus>(&mut self, bus: &mut B, op: u32) {
        let rd = ((op & 7) | ((op >> 4) & 8)) as usize;
        let rs = ((op >> 3) & 0xF) as usize;
        let mut v = self.r[rs];
        if rs == 15 {
            v &= !1;
        }
        match (op >> 8) & 3 {
            3 => {
                if v & 1 != 0 {
                    self.r[15] = v & !1;
                    self.reload16(bus);
                } else {
                    self.cpsr &= !0x20;
                    self.r[15] = v;
                    self.reload32(bus);
                }
            }
            1 => {
                self.sub(self.r[rd], v, true);
                self.seq = true;
                self.r[15] = self.r[15].wrapping_add(2);
            }
            k => {
                if k == 0 {
                    self.r[rd] = self.r[rd].wrapping_add(v);
                } else {
                    self.r[rd] = v;
                }
                if rd == 15 {
                    self.r[15] &= !1;
                    self.reload16(bus);
                } else {
                    self.seq = true;
                    self.r[15] = self.r[15].wrapping_add(2);
                }
            }
        }
    }

    fn thumb_pushpop<B: Bus>(&mut self, bus: &mut B, op: u32) {
        let list = op & 0xFF;
        let pop = op & (1 << 11) != 0;
        let rbit = op & (1 << 8) != 0;
        self.seq = false;
        self.r[15] = self.r[15].wrapping_add(2);
        if list == 0 && !rbit {
            if pop {
                self.r[15] = bus.read32(self.r[13], false);
                self.reload16(bus);
                self.r[13] = self.r[13].wrapping_add(0x40);
            } else {
                self.r[13] = self.r[13].wrapping_sub(0x40);
                bus.write32(self.r[13], self.r[15], false);
            }
            return;
        }
        let mut addr = self.r[13];
        let mut seq = false;
        if pop {
            for i in 0..8 {
                if list & (1 << i) != 0 {
                    self.r[i] = bus.read32(addr, seq);
                    seq = true;
                    addr = addr.wrapping_add(4);
                }
            }
            if rbit {
                self.r[15] = bus.read32(addr, seq) & !1;
                self.r[13] = addr.wrapping_add(4);
                bus.idle();
                self.reload16(bus);
                return;
            }
            bus.idle();
            self.r[13] = addr;
        } else {
            addr = addr.wrapping_sub((list.count_ones() + rbit as u32) * 4);
            self.r[13] = addr;
            for i in 0..8 {
                if list & (1 << i) != 0 {
                    bus.write32(addr, self.r[i], seq);
                    seq = true;
                    addr = addr.wrapping_add(4);
                }
            }
            if rbit {
                bus.write32(addr, self.r[14], seq);
            }
        }
    }

    fn thumb_ldmstm<B: Bus>(&mut self, bus: &mut B, op: u32) {
        let list = op & 0xFF;
        let rb = ((op >> 8) & 7) as usize;
        let load = op & (1 << 11) != 0;
        self.seq = false;
        self.r[15] = self.r[15].wrapping_add(2);
        if list == 0 {
            if load {
                self.r[15] = bus.read32(self.r[rb], false);
                self.reload16(bus);
            } else {
                bus.write32(self.r[rb], self.r[15], false);
            }
            self.r[rb] = self.r[rb].wrapping_add(0x40);
            return;
        }
        let mut addr = self.r[rb];
        if load {
            let mut seq = false;
            for i in 0..8 {
                if list & (1 << i) != 0 {
                    self.r[i] = bus.read32(addr, seq);
                    seq = true;
                    addr = addr.wrapping_add(4);
                }
            }
            bus.idle();
            if list & (1 << rb) == 0 {
                self.r[rb] = addr;
            }
        } else {
            let first = list.trailing_zeros() as usize;
            let base_new = addr.wrapping_add(list.count_ones() * 4);
            bus.write32(addr, self.r[first], false);
            self.r[rb] = base_new;
            addr = addr.wrapping_add(4);
            for i in first + 1..8 {
                if list & (1 << i) != 0 {
                    bus.write32(addr, self.r[i], true);
                    addr = addr.wrapping_add(4);
                }
            }
        }
    }
}

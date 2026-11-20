// Everything on the GBA's bus except the CPU: memory map and waitstates, IO
// registers, DMA, timers, interrupts, keypad, the cartridge (ROM, save chip,
// GPIO real-time clock) and the event scheduler that drives the PPU.
//
// The whole struct is plain data (no pointers except the ROM, which lives
// outside it), so a save state is a byte copy of `Gba`.

use crate::apu::Apu;
use crate::cpu::{Bus, Cpu, Swi};
use crate::ppu::Ppu;
use crate::rtc::Rtc;
use crate::save::Save;

pub const IRQ_VBLANK: u16 = 1;
pub const IRQ_HBLANK: u16 = 2;
pub const IRQ_VCOUNT: u16 = 4;
pub const IRQ_TIMER0: u16 = 8;
pub const IRQ_DMA0: u16 = 0x100;
pub const IRQ_KEYPAD: u16 = 0x1000;

pub const CYCLES_PER_LINE: u64 = 1232;
pub const HDRAW_CYCLES: u64 = 960;
pub const LINES: u32 = 228;
pub const CYCLES_PER_FRAME: u64 = CYCLES_PER_LINE * LINES as u64;

// Scheduler slots.
pub const EV_PPU: usize = 0;
pub const EV_TIMER: usize = 1; // 1..=4
pub const EV_APU: usize = 5;
const NEV: usize = 6;
const NEVER: u64 = u64::MAX;

#[derive(Clone, Copy)]
pub struct Timer {
    pub reload: u16,
    pub ctrl: u16,
    /// Counter value at `start`.
    pub counter: u16,
    pub start: u64,
}

#[derive(Clone, Copy)]
pub struct Dma {
    pub src: u32,
    pub dst: u32,
    pub count: u32,
    pub ctrl: u16,
    // Internal (latched) registers.
    pub isrc: u32,
    pub idst: u32,
    pub icount: u32,
}

pub const DMA_IMMEDIATE: u16 = 0;
pub const DMA_VBLANK: u16 = 1;
pub const DMA_HBLANK: u16 = 2;
pub const DMA_SPECIAL: u16 = 3;

pub struct Sys {
    pub now: u64,
    pub next_event: u64,
    pub events: [u64; NEV],

    pub ewram: [u8; 0x40000],
    pub iwram: [u8; 0x8000],
    pub palette: [u8; 0x400],
    pub vram: [u8; 0x18000],
    pub oam: [u8; 0x400],
    /// Raw IO register storage, by halfword.
    pub io: [u16; 0x200],
    pub bios: [u8; 0x4000],
    /// Last opcode fetched from the BIOS (what BIOS reads return from outside it).
    pub bios_latch: u32,

    pub ie: u16,
    pub if_: u16,
    pub ime: bool,
    /// IME && (IE & IF) != 0.
    pub irq_line: bool,
    pub halted: bool,
    /// Inside an HLE IntrWait.
    pub intr_wait: bool,
    pub keys: u16,

    /// Waitstates by [seq][region] for 8/16-bit and 32-bit accesses.
    pub wait16: [[u32; 16]; 2],
    pub wait32: [[u32; 16]; 2],
    pub prefetch: bool,

    pub timers: [Timer; 4],
    pub dmas: [Dma; 4],
    pub dma_active: bool,

    pub ppu: Ppu,
    pub apu: Apu,
    pub save: Save,
    pub rtc: Rtc,
    pub frame_done: bool,
    pub frames: u32,
    /// Cycles spent halted (waiting for an interrupt).
    pub idle_cycles: u64,
    /// Draw scanlines (off for CPU-only benchmarking).
    pub render: bool,

    // ROM: outside the saved state; restored by the host-side loader.
    pub rom: *const u8,
    pub rom_len: u32,
}

#[inline(always)]
fn rd16(m: &[u8], i: usize) -> u32 {
    debug_assert!(i + 1 < m.len());
    unsafe { core::ptr::read_unaligned(m.as_ptr().add(i) as *const u16) as u32 }
}

#[inline(always)]
fn rd32(m: &[u8], i: usize) -> u32 {
    debug_assert!(i + 3 < m.len());
    unsafe { core::ptr::read_unaligned(m.as_ptr().add(i) as *const u32) }
}

#[inline(always)]
fn wr16(m: &mut [u8], i: usize, v: u16) {
    debug_assert!(i + 1 < m.len());
    unsafe { core::ptr::write_unaligned(m.as_mut_ptr().add(i) as *mut u16, v) }
}

#[inline(always)]
fn wr32(m: &mut [u8], i: usize, v: u32) {
    debug_assert!(i + 3 < m.len());
    unsafe { core::ptr::write_unaligned(m.as_mut_ptr().add(i) as *mut u32, v) }
}

#[inline(always)]
fn vram_index(addr: u32) -> usize {
    let a = addr & 0x1FFFF;
    (if a >= 0x18000 { a - 0x8000 } else { a }) as usize
}

/// Minimal BIOS: the IRQ dispatcher at the real BIOS's addresses (so BIOS
/// open-bus reads match hardware). SWIs are handled in Rust (bios.rs).
fn build_bios(b: &mut [u8; 0x4000]) {
    let mut put = |addr: usize, op: u32| b[addr..addr + 4].copy_from_slice(&op.to_le_bytes());
    // Vectors: reset -> cartridge, undefined/swi/abort -> return, irq -> dispatcher.
    put(0x00, 0xEA00_0000 | ((0x20 - 0x08) >> 2)); // b 0x20
    put(0x04, 0xE1B0_F00E); // movs pc, lr
    put(0x08, 0xE1B0_F00E); // movs pc, lr
    put(0x0C, 0xE25E_F004); // subs pc, lr, #4
    put(0x10, 0xE25E_F008); // subs pc, lr, #8
    put(0x14, 0xE1B0_F00E);
    put(0x18, 0xEA00_0000 | ((0x128 - 0x20) >> 2)); // b 0x128
    put(0x1C, 0xE25E_F004);
    // 0x20: jump to the cartridge.
    put(0x20, 0xE3A0_E302); // mov lr, #0x08000000
    put(0x24, 0xE12F_FF1E); // bx lr
    // IRQ dispatcher.
    put(0x128, 0xE92D_500F); // stmfd sp!, {r0-r3, r12, lr}
    put(0x12C, 0xE3A0_0301); // mov r0, #0x04000000
    put(0x130, 0xE28F_E000); // add lr, pc, #0
    put(0x134, 0xE510_F004); // ldr pc, [r0, #-4]
    put(0x138, 0xE8BD_500F); // ldmfd sp!, {r0-r3, r12, lr}
    put(0x13C, 0xE25E_F004); // subs pc, lr, #4
    put(0x140, 0xE59D_0000);
    put(0x144, 0xE55E_C002); // what the real BIOS has here
}

impl Sys {
    /// Initialise a zeroed Sys in place.
    pub fn init(&mut self, rom: *const u8, rom_len: u32) {
        self.rom = rom;
        self.rom_len = rom_len;
        self.render = true;
        build_bios(&mut self.bios);
        self.bios_latch = 0xE129_F000;
        self.events = [NEVER; NEV];
        self.keys = 0;
        self.write_waitcnt(0);
        self.io[0x130 >> 1] = 0x3FF;
        self.io[0x088 >> 1] = 0x200; // SOUNDBIAS
        // The BIOS leaves the affine BG matrices as identity.
        for r in [0x20, 0x26, 0x30, 0x36] {
            self.io[r >> 1] = 0x100;
        }
        for t in &mut self.timers {
            t.start = 0;
        }
        self.ppu.init();
        self.apu.init();
        self.save.init(self.rom_slice());
        self.rtc.init(self.rom_slice());
        // First line: HDraw starts now.
        self.ppu.vcount = 0;
        self.schedule(EV_PPU, HDRAW_CYCLES);
        self.apu_schedule();
    }

    pub fn rom_slice(&self) -> &'static [u8] {
        if self.rom.is_null() {
            &[]
        } else {
            unsafe { core::slice::from_raw_parts(self.rom, self.rom_len as usize) }
        }
    }

    // ---- scheduler ----

    #[inline]
    pub fn schedule(&mut self, ev: usize, delay: u64) {
        self.schedule_at(ev, self.now + delay);
    }

    #[inline]
    pub fn schedule_at(&mut self, ev: usize, at: u64) {
        self.events[ev] = at;
        self.update_next();
    }

    pub fn cancel(&mut self, ev: usize) {
        self.events[ev] = NEVER;
        self.update_next();
    }

    #[inline]
    fn update_next(&mut self) {
        let mut m = self.events[0];
        for &e in &self.events[1..] {
            m = m.min(e);
        }
        self.next_event = m;
    }

    /// Run every event that is due.
    pub fn run_events(&mut self) {
        while self.next_event <= self.now {
            let mut ev = 0;
            for i in 1..NEV {
                if self.events[i] < self.events[ev] {
                    ev = i;
                }
            }
            let at = self.events[ev];
            self.events[ev] = NEVER;
            self.update_next();
            match ev {
                EV_PPU => self.ppu_event(at),
                EV_APU => self.apu_event(at),
                _ => self.timer_overflow(ev - EV_TIMER, at),
            }
        }
    }

    // ---- interrupts ----

    pub fn request_irq(&mut self, bits: u16) {
        self.if_ |= bits;
        self.update_irq();
    }

    #[inline]
    pub fn update_irq(&mut self) {
        let pending = self.ie & self.if_ & 0x3FFF != 0;
        self.irq_line = self.ime && pending;
        if pending {
            self.halted = false;
        }
    }

    // ---- PPU timing ----

    fn ppu_event(&mut self, at: u64) {
        if !self.ppu.in_hblank {
            // HBlank starts.
            self.ppu.in_hblank = true;
            let line = self.ppu.vcount;
            if line < 160 && self.render {
                self.render_line(line);
            }
            self.io[0x004 >> 1] |= 2;
            if self.io[0x004 >> 1] & 0x10 != 0 {
                self.request_irq(IRQ_HBLANK);
            }
            if line < 160 {
                self.dma_trigger(DMA_HBLANK);
            }
            self.schedule_at(EV_PPU, at + (CYCLES_PER_LINE - HDRAW_CYCLES));
        } else {
            // Next line.
            self.ppu.in_hblank = false;
            self.io[0x004 >> 1] &= !2;
            let line = (self.ppu.vcount + 1) % LINES;
            self.ppu.vcount = line;
            self.io[0x006 >> 1] = line as u16;
            let stat = self.io[0x004 >> 1];
            if line == 160 {
                self.io[0x004 >> 1] |= 1;
                if stat & 0x08 != 0 {
                    self.request_irq(IRQ_VBLANK);
                }
                self.ppu.latch_affine(&self.io);
                self.dma_trigger(DMA_VBLANK);
                self.frame_done = true;
                self.frames = self.frames.wrapping_add(1);
            } else if line == 227 {
                self.io[0x004 >> 1] &= !1;
            }
            let lyc = (stat >> 8) as u32;
            if line == lyc {
                self.io[0x004 >> 1] |= 4;
                if stat & 0x20 != 0 {
                    self.request_irq(IRQ_VCOUNT);
                }
            } else {
                self.io[0x004 >> 1] &= !4;
            }
            self.schedule_at(EV_PPU, at + HDRAW_CYCLES);
        }
    }

    // ---- waitstates ----

    pub fn write_waitcnt(&mut self, v: u16) {
        self.io[0x204 >> 1] = v & 0x5FFF;
        const N: [u32; 4] = [4, 3, 2, 8];
        let sram = 1 + N[(v & 3) as usize];
        let ws = [
            (N[((v >> 2) & 3) as usize], if v & 0x10 != 0 { 1 } else { 2 }),
            (N[((v >> 5) & 3) as usize], if v & 0x80 != 0 { 1 } else { 4 }),
            (N[((v >> 8) & 3) as usize], if v & 0x400 != 0 { 1 } else { 8 }),
        ];
        // Defaults for the internal regions: BIOS, -, EWRAM, IWRAM, IO, PAL, VRAM, OAM.
        let base16 = [1, 1, 3, 1, 1, 1, 1, 1];
        let base32 = [1, 1, 6, 1, 1, 2, 2, 1];
        for seq in 0..2 {
            for r in 0..8 {
                self.wait16[seq][r] = base16[r];
                self.wait32[seq][r] = base32[r];
            }
            for (i, &(n, s)) in ws.iter().enumerate() {
                let first = if seq == 1 { 1 + s } else { 1 + n };
                for r in [8 + i * 2, 9 + i * 2] {
                    self.wait16[seq][r] = first;
                    self.wait32[seq][r] = first + 1 + s;
                }
            }
            self.wait16[seq][14] = sram;
            self.wait16[seq][15] = sram;
            self.wait32[seq][14] = sram;
            self.wait32[seq][15] = sram;
        }
        self.prefetch = v & 0x4000 != 0;
    }

    // ---- ROM ----

    #[inline(always)]
    fn rom16(&self, addr: u32) -> u32 {
        let off = addr & 0x01FF_FFFE;
        if off < self.rom_len {
            unsafe { core::ptr::read_unaligned(self.rom.add(off as usize) as *const u16) as u32 }
        } else {
            (addr >> 1) & 0xFFFF
        }
    }

    #[inline(always)]
    fn rom32(&self, addr: u32) -> u32 {
        let off = addr & 0x01FF_FFFC;
        if off + 3 < self.rom_len {
            unsafe { core::ptr::read_unaligned(self.rom.add(off as usize) as *const u32) }
        } else {
            self.rom16(addr) | (self.rom16(addr + 2) << 16)
        }
    }

    /// ROM read with the GPIO (RTC) window at 0x080000C4..C9.
    #[inline(always)]
    fn rom16_gpio(&mut self, addr: u32) -> u32 {
        if self.rtc.readable && (addr & 0x01FF_FFFE).wrapping_sub(0xC4) < 6 {
            return self.rtc.read(addr & 0x01FF_FFFE) as u32;
        }
        self.rom16(addr)
    }

    // ---- generic access ----

    fn open_bus(&self) -> u32 {
        0
    }

    pub fn read8_raw(&mut self, addr: u32) -> u32 {
        match addr >> 24 {
            0x00 => {
                if addr < 0x4000 {
                    (self.bios_latch >> ((addr & 3) * 8)) & 0xFF
                } else {
                    self.open_bus() & 0xFF
                }
            }
            0x02 => self.ewram[(addr & 0x3FFFF) as usize] as u32,
            0x03 => self.iwram[(addr & 0x7FFF) as usize] as u32,
            0x04 => {
                let v = self.io_read16(addr & !1) as u32;
                (v >> ((addr & 1) * 8)) & 0xFF
            }
            0x05 => self.palette[(addr & 0x3FF) as usize] as u32,
            0x06 => self.vram[vram_index(addr)] as u32,
            0x07 => self.oam[(addr & 0x3FF) as usize] as u32,
            0x08..=0x0D => (self.rom16_gpio(addr) >> ((addr & 1) * 8)) & 0xFF,
            0x0E | 0x0F => self.save.read(addr) as u32,
            _ => self.open_bus() & 0xFF,
        }
    }

    pub fn read16_raw(&mut self, addr: u32) -> u32 {
        let addr = addr & !1;
        match addr >> 24 {
            0x00 => {
                if addr < 0x4000 {
                    (self.bios_latch >> ((addr & 2) * 8)) & 0xFFFF
                } else {
                    self.open_bus() & 0xFFFF
                }
            }
            0x02 => rd16(&self.ewram, (addr & 0x3FFFE) as usize),
            0x03 => rd16(&self.iwram, (addr & 0x7FFE) as usize),
            0x04 => self.io_read16(addr) as u32,
            0x05 => rd16(&self.palette, (addr & 0x3FE) as usize),
            0x06 => rd16(&self.vram, vram_index(addr)),
            0x07 => rd16(&self.oam, (addr & 0x3FE) as usize),
            0x08..=0x0D => self.rom16_gpio(addr),
            0x0E | 0x0F => self.save.read(addr) as u32 * 0x0101,
            _ => self.open_bus() & 0xFFFF,
        }
    }

    pub fn read32_raw(&mut self, addr: u32) -> u32 {
        let addr = addr & !3;
        match addr >> 24 {
            0x00 => {
                if addr < 0x4000 {
                    self.bios_latch
                } else {
                    self.open_bus()
                }
            }
            0x02 => rd32(&self.ewram, (addr & 0x3FFFC) as usize),
            0x03 => rd32(&self.iwram, (addr & 0x7FFC) as usize),
            0x04 => self.io_read16(addr) as u32 | ((self.io_read16(addr + 2) as u32) << 16),
            0x05 => rd32(&self.palette, (addr & 0x3FC) as usize),
            0x06 => rd32(&self.vram, vram_index(addr)),
            0x07 => rd32(&self.oam, (addr & 0x3FC) as usize),
            0x08..=0x0D if addr & 0x01FF_FF00 != 0 || !self.rtc.readable => self.rom32(addr),
            0x08..=0x0D => self.rom16_gpio(addr) | (self.rom16_gpio(addr + 2) << 16),
            0x0E | 0x0F => self.save.read(addr) as u32 * 0x0101_0101,
            _ => self.open_bus(),
        }
    }

    pub fn write8_raw(&mut self, addr: u32, v: u8) {
        match addr >> 24 {
            0x02 => self.ewram[(addr & 0x3FFFF) as usize] = v,
            0x03 => self.iwram[(addr & 0x7FFF) as usize] = v,
            0x04 => self.io_write8(addr, v),
            0x05 => wr16(&mut self.palette, (addr & 0x3FE) as usize, v as u16 * 0x101),
            0x06 => {
                // Byte writes hit BG VRAM as a doubled halfword; OBJ VRAM ignores them.
                let i = vram_index(addr);
                let bg_end = if self.io[0] & 7 >= 3 { 0x14000 } else { 0x10000 };
                if i < bg_end {
                    wr16(&mut self.vram, i & !1, v as u16 * 0x101);
                }
            }
            0x07 => {}
            0x08..=0x0D => self.rom_write(addr, v as u16),
            0x0E | 0x0F => self.save.write(addr, v),
            _ => {}
        }
    }

    pub fn write16_raw(&mut self, addr: u32, v: u16) {
        if addr >> 25 == 7 {
            // The save chip has an 8-bit bus: the address picks the byte lane.
            return self.save.write(addr, (v >> ((addr & 1) * 8)) as u8);
        }
        let addr = addr & !1;
        match addr >> 24 {
            0x02 => wr16(&mut self.ewram, (addr & 0x3FFFE) as usize, v),
            0x03 => wr16(&mut self.iwram, (addr & 0x7FFE) as usize, v),
            0x04 => self.io_write16(addr, v),
            0x05 => wr16(&mut self.palette, (addr & 0x3FE) as usize, v),
            0x06 => wr16(&mut self.vram, vram_index(addr), v),
            0x07 => wr16(&mut self.oam, (addr & 0x3FE) as usize, v),
            0x08..=0x0D => self.rom_write(addr, v),
            0x0E | 0x0F => self.save.write(addr, (v >> ((addr & 1) * 8)) as u8),
            _ => {}
        }
    }

    pub fn write32_raw(&mut self, addr: u32, v: u32) {
        if addr >> 25 == 7 {
            return self.save.write(addr, (v >> ((addr & 3) * 8)) as u8);
        }
        let addr = addr & !3;
        match addr >> 24 {
            0x02 => wr32(&mut self.ewram, (addr & 0x3FFFC) as usize, v),
            0x03 => wr32(&mut self.iwram, (addr & 0x7FFC) as usize, v),
            0x04 => {
                self.io_write16(addr, v as u16);
                self.io_write16(addr + 2, (v >> 16) as u16);
            }
            0x05 => wr32(&mut self.palette, (addr & 0x3FC) as usize, v),
            0x06 => wr32(&mut self.vram, vram_index(addr), v),
            0x07 => wr32(&mut self.oam, (addr & 0x3FC) as usize, v),
            0x08..=0x0D => {
                self.rom_write(addr, v as u16);
                self.rom_write(addr + 2, (v >> 16) as u16);
            }
            0x0E | 0x0F => self.save.write(addr, (v >> ((addr & 3) * 8)) as u8),
            _ => {}
        }
    }

    fn rom_write(&mut self, addr: u32, v: u16) {
        let off = addr & 0x01FF_FFFE;
        if (0xC4..0xCA).contains(&off) {
            self.rtc.write(off, v);
        }
    }

    // ---- IO registers ----

    pub fn io_read16(&mut self, addr: u32) -> u16 {
        let a = addr & 0x00FF_FFFE;
        if a >= 0x400 {
            // 0x04000800 (memory control) mirrors every 64K; nothing else is mapped.
            return if a & 0xFFFF == 0x800 { 0x0D00 } else if a & 0xFFFF == 0x802 { 0x0D00 } else { 0 };
        }
        match a {
            0x100 | 0x104 | 0x108 | 0x10C => self.timer_counter(((a - 0x100) >> 2) as usize),
            0x130 => !self.keys & 0x3FF,
            0x200 => self.ie,
            0x202 => self.if_,
            0x208 => self.ime as u16,
            0x060..=0x0A6 => self.apu.read16(a),
            // Write-only registers read as 0.
            0x010..=0x01E | 0x020..=0x03E | 0x04C..=0x04E | 0x054 | 0x0B0..=0x0B8 | 0x0BC..=0x0C4 | 0x0C8..=0x0D0
            | 0x0D4..=0x0DC => 0,
            0x0BA | 0x0C6 | 0x0D2 | 0x0DE => self.io[(a >> 1) as usize],
            _ => self.io[(a >> 1) as usize],
        }
    }

    fn io_write8(&mut self, addr: u32, v: u8) {
        let a = addr & 0x00FF_FFFF;
        if a >= 0x400 {
            return;
        }
        match a {
            0x202 => {
                self.if_ &= !(v as u16);
                self.update_irq();
            }
            0x203 => {
                self.if_ &= !((v as u16) << 8);
                self.update_irq();
            }
            0x301 => self.halted = true,
            0x300 => self.io[0x300 >> 1] = (self.io[0x300 >> 1] & 0xFF00) | v as u16,
            0x0A0..=0x0A7 => self.apu.fifo_write8(a, v),
            _ => {
                let i = (a >> 1) as usize;
                let cur = if (0x060..0x0B0).contains(&a) { self.apu.raw16(a & !1) } else { self.io[i] };
                let merged = if a & 1 != 0 { (cur & 0xFF) | ((v as u16) << 8) } else { (cur & 0xFF00) | v as u16 };
                self.io_write16(a & !1, merged);
            }
        }
    }

    pub fn io_write16(&mut self, addr: u32, v: u16) {
        let a = addr & 0x00FF_FFFE;
        if a >= 0x400 {
            return;
        }
        let i = (a >> 1) as usize;
        match a {
            0x004 => self.io[i] = (self.io[i] & 0x0007) | (v & 0xFFB8),
            0x006 => {}
            0x028..=0x02E | 0x038..=0x03E => {
                self.io[i] = v;
                self.ppu.write_ref(a, &self.io);
            }
            0x060..=0x0A6 => {
                if (0x0A0..0x0A8).contains(&a) {
                    self.apu.fifo_write8(a, v as u8);
                    self.apu.fifo_write8(a + 1, (v >> 8) as u8);
                } else {
                    self.apu.write16(a, v);
                }
            }
            0x0B0..=0x0DE => {
                self.io[i] = v;
                let ch = ((a - 0x0B0) / 12) as usize;
                if (a - 0x0B0) % 12 == 10 {
                    self.dma_write_ctrl(ch, v);
                }
            }
            0x100 | 0x104 | 0x108 | 0x10C => self.timers[((a - 0x100) >> 2) as usize].reload = v,
            0x102 | 0x106 | 0x10A | 0x10E => self.timer_write_ctrl(((a - 0x102) >> 2) as usize, v),
            0x130 => {}
            0x132 => {
                self.io[i] = v;
                self.check_keypad_irq();
            }
            0x200 => {
                self.ie = v;
                self.update_irq();
            }
            0x202 => {
                self.if_ &= !v;
                self.update_irq();
            }
            0x204 => self.write_waitcnt(v),
            0x208 => {
                self.ime = v & 1 != 0;
                self.update_irq();
            }
            0x300 => {
                self.io[i] = v & 0xFF;
                if v & 0x8000 == 0 {
                    self.halted = true;
                }
            }
            _ => self.io[i] = v,
        }
    }

    // ---- keypad ----

    pub fn set_keys(&mut self, mask: u16) {
        self.keys = mask & 0x3FF;
        self.check_keypad_irq();
    }

    fn check_keypad_irq(&mut self) {
        let cnt = self.io[0x132 >> 1];
        if cnt & 0x4000 == 0 {
            return;
        }
        let sel = cnt & 0x3FF;
        let hit = if cnt & 0x8000 != 0 { self.keys & sel == sel } else { self.keys & sel != 0 };
        if hit {
            self.request_irq(IRQ_KEYPAD);
        }
    }

    // ---- timers ----

    #[inline]
    fn timer_shift(ctrl: u16) -> u32 {
        [0, 6, 8, 10][(ctrl & 3) as usize]
    }

    fn timer_running(&self, i: usize) -> bool {
        let c = self.timers[i].ctrl;
        c & 0x80 != 0 && !(i > 0 && c & 4 != 0)
    }

    pub fn timer_counter(&self, i: usize) -> u16 {
        let t = &self.timers[i];
        if self.timer_running(i) {
            let ticks = (self.now.saturating_sub(t.start)) >> Self::timer_shift(t.ctrl);
            (t.counter as u64 + ticks).min(0xFFFF) as u16
        } else {
            t.counter
        }
    }

    fn timer_schedule(&mut self, i: usize) {
        if self.timer_running(i) {
            let t = &self.timers[i];
            let at = t.start + ((0x10000 - t.counter as u64) << Self::timer_shift(t.ctrl));
            self.schedule_at(EV_TIMER + i, at);
        } else {
            self.cancel(EV_TIMER + i);
        }
    }

    fn timer_write_ctrl(&mut self, i: usize, v: u16) {
        let was_enabled = self.timers[i].ctrl & 0x80 != 0;
        // Latch the running count before changing anything.
        self.timers[i].counter = self.timer_counter(i);
        self.timers[i].start = self.now;
        self.timers[i].ctrl = v & 0xC7;
        if !was_enabled && v & 0x80 != 0 {
            self.timers[i].counter = self.timers[i].reload;
        }
        self.io[(0x102 >> 1) + i * 2] = v & 0xC7;
        self.timer_schedule(i);
    }

    fn timer_overflow(&mut self, i: usize, at: u64) {
        let t = &mut self.timers[i];
        t.counter = t.reload;
        t.start = at;
        self.timer_overflowed(i);
        self.timer_schedule(i);
    }

    /// Effects of timer `i` wrapping: IRQ, sound FIFOs, cascade.
    fn timer_overflowed(&mut self, i: usize) {
        if self.timers[i].ctrl & 0x40 != 0 {
            self.request_irq(IRQ_TIMER0 << i);
        }
        if i < 2 {
            let req = self.apu.timer_overflow(i, self.now);
            for f in 0..2 {
                if req & (1 << f) != 0 {
                    self.dma_fifo(f);
                }
            }
        }
        if i < 3 {
            let n = i + 1;
            let c = self.timers[n].ctrl;
            if c & 0x80 != 0 && c & 4 != 0 {
                let t = &mut self.timers[n];
                if t.counter == 0xFFFF {
                    t.counter = t.reload;
                    self.timer_overflowed(n);
                } else {
                    t.counter += 1;
                }
            }
        }
    }

    // ---- DMA ----

    fn dma_write_ctrl(&mut self, ch: usize, v: u16) {
        let base = 0x0B0 / 2 + ch * 6;
        let was = self.dmas[ch].ctrl & 0x8000 != 0;
        self.dmas[ch].ctrl = v;
        if !was && v & 0x8000 != 0 {
            let d = &mut self.dmas[ch];
            d.src = self.io[base] as u32 | (self.io[base + 1] as u32) << 16;
            d.dst = self.io[base + 2] as u32 | (self.io[base + 3] as u32) << 16;
            d.count = self.io[base + 4] as u32;
            let src_mask = if ch == 0 { 0x07FF_FFFF } else { 0x0FFF_FFFF };
            let dst_mask = if ch == 3 { 0x0FFF_FFFF } else { 0x07FF_FFFF };
            d.isrc = d.src & src_mask;
            d.idst = d.dst & dst_mask;
            d.icount = Self::dma_count(ch, d.count);
            if (v >> 12) & 3 == DMA_IMMEDIATE {
                self.dma_run(ch);
            }
        }
    }

    fn dma_count(ch: usize, count: u32) -> u32 {
        let max = if ch == 3 { 0x10000 } else { 0x4000 };
        let c = count & (max - 1);
        if c == 0 {
            max
        } else {
            c
        }
    }

    pub fn dma_trigger(&mut self, timing: u16) {
        for ch in 0..4 {
            let c = self.dmas[ch].ctrl;
            if c & 0x8000 != 0 && (c >> 12) & 3 == timing {
                self.dma_run(ch);
            }
        }
    }

    /// FIFO A or B wants data: run the sound DMA pointed at it.
    fn dma_fifo(&mut self, fifo: usize) {
        let target = 0x0400_00A0 + fifo as u32 * 4;
        for ch in 1..3 {
            let d = &self.dmas[ch];
            if d.ctrl & 0x8000 != 0 && (d.ctrl >> 12) & 3 == DMA_SPECIAL && d.idst == target {
                self.dma_run(ch);
                return;
            }
        }
    }

    fn dma_run(&mut self, ch: usize) {
        let d = self.dmas[ch];
        let ctrl = d.ctrl;
        let fifo = (ch == 1 || ch == 2) && (ctrl >> 12) & 3 == DMA_SPECIAL;
        let word = ctrl & 0x400 != 0 || fifo;
        let size = if word { 4 } else { 2 };
        let count = if fifo { 4 } else { d.icount };
        let src_step: i32 = match (ctrl >> 7) & 3 {
            0 => size,
            1 => -size,
            2 => 0,
            _ => size,
        };
        let dst_step: i32 = if fifo {
            0
        } else {
            match (ctrl >> 5) & 3 {
                0 | 3 => size,
                1 => -size,
                _ => 0,
            }
        };
        let mut src = d.isrc;
        let mut dst = d.idst;
        self.now += 2;
        let mut seq = false;
        for _ in 0..count {
            if word {
                let v = self.read32(src & !3, seq);
                self.write32(dst & !3, v, seq);
            } else {
                let v = self.read16(src & !1, seq);
                self.write16(dst & !1, v as u16, seq);
            }
            seq = true;
            src = src.wrapping_add(src_step as u32);
            dst = dst.wrapping_add(dst_step as u32);
        }
        let d = &mut self.dmas[ch];
        d.isrc = src;
        d.idst = dst;
        if ctrl & 0x4000 != 0 {
            self.request_irq(IRQ_DMA0 << ch);
        }
        let d = &mut self.dmas[ch];
        if ctrl & 0x200 != 0 && (ctrl >> 12) & 3 != DMA_IMMEDIATE {
            // Repeat: reload count (and destination for mode 3).
            d.icount = Self::dma_count(ch, d.count);
            if (ctrl >> 5) & 3 == 3 {
                let dst_mask = if ch == 3 { 0x0FFF_FFFF } else { 0x07FF_FFFF };
                d.idst = d.dst & dst_mask;
            }
        } else {
            d.ctrl &= !0x8000;
            self.io[0x0B0 / 2 + ch * 6 + 5] &= !0x8000;
        }
    }

    // ---- APU scheduling ----

    fn apu_schedule(&mut self) {
        let period = self.apu.sample_period();
        self.schedule(EV_APU, period);
    }

    fn apu_event(&mut self, at: u64) {
        self.apu.sample(at);
        let period = self.apu.sample_period();
        self.schedule_at(EV_APU, at + period);
    }
}

impl Bus for Sys {
    #[inline(always)]
    fn read8(&mut self, addr: u32, seq: bool) -> u32 {
        self.now += self.wait16[seq as usize][((addr >> 24) & 0xF) as usize] as u64;
        self.read8_raw(addr)
    }

    #[inline(always)]
    fn read16(&mut self, addr: u32, seq: bool) -> u32 {
        let r = ((addr >> 24) & 0xF) as usize;
        self.now += self.wait16[seq as usize][r] as u64;
        match addr >> 24 {
            0x02 => rd16(&self.ewram, (addr & 0x3FFFE) as usize),
            0x03 => rd16(&self.iwram, (addr & 0x7FFE) as usize),
            0x08..=0x0D if addr & 0x01FF_FF00 != 0 || !self.rtc.readable => self.rom16(addr),
            _ => self.read16_raw(addr),
        }
    }

    #[inline(always)]
    fn read32(&mut self, addr: u32, seq: bool) -> u32 {
        let r = ((addr >> 24) & 0xF) as usize;
        self.now += self.wait32[seq as usize][r] as u64;
        match addr >> 24 {
            0x02 => rd32(&self.ewram, (addr & 0x3FFFC) as usize),
            0x03 => rd32(&self.iwram, (addr & 0x7FFC) as usize),
            0x08..=0x0D if addr & 0x01FF_FF00 != 0 || !self.rtc.readable => self.rom32(addr),
            _ => self.read32_raw(addr),
        }
    }

    #[inline(always)]
    fn write8(&mut self, addr: u32, v: u8, seq: bool) {
        self.now += self.wait16[seq as usize][((addr >> 24) & 0xF) as usize] as u64;
        self.write8_raw(addr, v);
    }

    #[inline(always)]
    fn write16(&mut self, addr: u32, v: u16, seq: bool) {
        let r = ((addr >> 24) & 0xF) as usize;
        self.now += self.wait16[seq as usize][r] as u64;
        match addr >> 24 {
            0x02 => wr16(&mut self.ewram, (addr & 0x3FFFE) as usize, v),
            0x03 => wr16(&mut self.iwram, (addr & 0x7FFE) as usize, v),
            _ => self.write16_raw(addr, v),
        }
    }

    #[inline(always)]
    fn write32(&mut self, addr: u32, v: u32, seq: bool) {
        let r = ((addr >> 24) & 0xF) as usize;
        self.now += self.wait32[seq as usize][r] as u64;
        match addr >> 24 {
            0x02 => wr32(&mut self.ewram, (addr & 0x3FFFC) as usize, v),
            0x03 => wr32(&mut self.iwram, (addr & 0x7FFC) as usize, v),
            _ => self.write32_raw(addr, v),
        }
    }

    #[inline(always)]
    fn fetch16(&mut self, addr: u32, seq: bool) -> u32 {
        match addr >> 24 {
            0x08..=0x0D => {
                // With the prefetch buffer on, sequential ROM code mostly costs one cycle.
                self.now += if seq && self.prefetch { 1 } else { self.wait16[seq as usize][((addr >> 24) & 0xF) as usize] as u64 };
                self.rom16(addr)
            }
            0x03 => {
                self.now += 1;
                rd16(&self.iwram, (addr & 0x7FFE) as usize)
            }
            0x02 => {
                self.now += 3;
                rd16(&self.ewram, (addr & 0x3FFFE) as usize)
            }
            0x00 if addr < 0x4000 => {
                self.now += 1;
                let a = (addr & 0x3FFE) as usize;
                self.bios_latch = rd32(&self.bios, a & !3);
                rd16(&self.bios, a)
            }
            _ => self.read16(addr, seq),
        }
    }

    #[inline(always)]
    fn fetch32(&mut self, addr: u32, seq: bool) -> u32 {
        match addr >> 24 {
            0x08..=0x0D => {
                self.now += if seq && self.prefetch { 2 } else { self.wait32[seq as usize][((addr >> 24) & 0xF) as usize] as u64 };
                self.rom32(addr)
            }
            0x03 => {
                self.now += 1;
                rd32(&self.iwram, (addr & 0x7FFC) as usize)
            }
            0x02 => {
                self.now += 6;
                rd32(&self.ewram, (addr & 0x3FFFC) as usize)
            }
            0x00 if addr < 0x4000 => {
                self.now += 1;
                let v = rd32(&self.bios, (addr & 0x3FFC) as usize);
                self.bios_latch = v;
                v
            }
            _ => self.read32(addr, seq),
        }
    }

    #[inline(always)]
    fn idle(&mut self) {
        self.now += 1;
    }

    fn swi(&mut self, cpu: &mut Cpu, n: u32) -> Swi {
        self.hle_swi(cpu, n)
    }
}

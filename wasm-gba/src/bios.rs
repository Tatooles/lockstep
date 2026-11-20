// High-level emulation of the BIOS's SWI calls, so no BIOS image is needed.
// The IRQ dispatcher is real ARM code in the stub BIOS (see sys.rs).

use crate::cpu::{Cpu, Swi, MODE_SYS};
use crate::sys::Sys;

impl Sys {
    pub fn hle_swi(&mut self, cpu: &mut Cpu, n: u32) -> Swi {
        // What the BIOS's last prefetch leaves visible after an SWI returns.
        self.bios_latch = 0xE3A0_2004;
        let r = &mut cpu.r;
        match n {
            0x00 => {
                // SoftReset
                let ram_flag = self.iwram[0x7FFA];
                self.iwram[0x7E00..].fill(0);
                cpu.skip_bios(if ram_flag != 0 { 0x0200_0000 } else { 0x0800_0000 });
                return Swi::Jump;
            }
            0x01 => self.register_ram_reset(r[0]),
            0x02 => self.halted = true,
            0x03 => self.halted = true,
            0x04 => return self.intr_wait(cpu, cpu.r[0] != 0, cpu.r[1] as u16),
            0x05 => return self.intr_wait(cpu, true, 1),
            0x06 => {
                let (q, m) = div(r[0] as i32, r[1] as i32);
                r[0] = q as u32;
                r[1] = m as u32;
                r[3] = q.unsigned_abs();
                self.now += 30;
            }
            0x07 => {
                let (q, m) = div(r[1] as i32, r[0] as i32);
                r[0] = q as u32;
                r[1] = m as u32;
                r[3] = q.unsigned_abs();
                self.now += 30;
            }
            0x08 => {
                r[0] = isqrt(r[0]);
                self.now += 40;
            }
            0x09 => r[0] = arctan(r[0] as i32) as u32,
            0x0A => r[0] = arctan2(r[0] as i16 as i32, r[1] as i16 as i32),
            0x0B => self.cpu_set(r[0], r[1], r[2]),
            0x0C => self.cpu_fast_set(r[0], r[1], r[2]),
            0x0D => r[0] = 0xBAAE_187F,
            0x0E => self.bg_affine_set(r[0], r[1], r[2]),
            0x0F => self.obj_affine_set(r[0], r[1], r[2], r[3]),
            0x10 => self.bit_unpack(r[0], r[1], r[2]),
            0x11 => self.lz77(r[0], r[1], false),
            0x12 => self.lz77(r[0], r[1], true),
            0x13 => self.huffman(r[0], r[1]),
            0x14 => self.rl(r[0], r[1], false),
            0x15 => self.rl(r[0], r[1], true),
            0x16 => self.diff8(r[0], r[1], false),
            0x17 => self.diff8(r[0], r[1], true),
            0x18 => self.diff16(r[0], r[1]),
            0x19 => {
                let bias = if r[0] != 0 { 0x200 } else { 0 };
                let cur = self.apu.read16(0x88);
                self.apu.write16(0x88, (cur & !0x3FF) | bias);
            }
            0x1F => {
                // MidiKey2Freq
                let freq = self.read32_raw(r[0] + 4) as f64;
                let key = 180.0 - r[1] as f64 - (r[2] & 0xFF) as f64 / 256.0;
                r[0] = (freq / 2f64.powf(key / 12.0)) as u32;
            }
            _ => {}
        }
        Swi::Done
    }

    fn intr_wait(&mut self, cpu: &mut Cpu, discard: bool, mask: u16) -> Swi {
        self.ime = true;
        self.io[0x208 >> 1] = 1;
        if !self.intr_wait {
            self.intr_wait = true;
            if discard {
                let f = self.read16_raw(0x0300_7FF8) as u16;
                self.write16_raw(0x0300_7FF8, f & !mask);
            }
        }
        let f = self.read16_raw(0x0300_7FF8) as u16;
        if f & mask != 0 {
            self.write16_raw(0x0300_7FF8, f & !mask);
            self.intr_wait = false;
            self.update_irq();
            return Swi::Done;
        }
        // Sleep; the IRQ returns to this SWI, which checks again.
        let _ = cpu;
        self.halted = true;
        self.update_irq();
        Swi::Repeat
    }

    fn register_ram_reset(&mut self, flags: u32) {
        self.io_write16(0x0400_0000, 0x0080);
        if flags & 1 != 0 {
            self.ewram.fill(0);
        }
        if flags & 2 != 0 {
            self.iwram[..0x7E00].fill(0);
        }
        if flags & 4 != 0 {
            self.palette.fill(0);
        }
        if flags & 8 != 0 {
            self.vram.fill(0);
        }
        if flags & 16 != 0 {
            self.oam.fill(0);
        }
        if flags & 0x80 != 0 {
            for a in (0x0400_0004..0x0400_0060).step_by(2) {
                self.io_write16(a, 0);
            }
            for a in (0x0400_00B0..0x0400_0120).step_by(2) {
                self.io_write16(a, 0);
            }
            self.io_write16(0x0400_0200, 0);
            self.io_write16(0x0400_0202, 0xFFFF);
            self.io_write16(0x0400_0208, 0);
        }
        // The affine matrices come back as identity.
        if flags & 0x80 != 0 {
            for a in [0x0400_0020, 0x0400_0026, 0x0400_0030, 0x0400_0036] {
                self.io_write16(a, 0x100);
            }
        }
    }

    fn cpu_set(&mut self, src: u32, dst: u32, ctrl: u32) {
        let count = ctrl & 0x1F_FFFF;
        let fill = ctrl & (1 << 24) != 0;
        let (mut s, mut d) = (src, dst);
        if ctrl & (1 << 26) != 0 {
            s &= !3;
            d &= !3;
            let v0 = self.read32_raw(s);
            for _ in 0..count {
                let v = if fill { v0 } else { self.read32_raw(s) };
                self.write32_raw(d, v);
                if !fill {
                    s = s.wrapping_add(4);
                }
                d = d.wrapping_add(4);
            }
            self.now += count as u64 * 6;
        } else {
            s &= !1;
            d &= !1;
            let v0 = self.read16_raw(s);
            for _ in 0..count {
                let v = if fill { v0 } else { self.read16_raw(s) };
                self.write16_raw(d, v as u16);
                if !fill {
                    s = s.wrapping_add(2);
                }
                d = d.wrapping_add(2);
            }
            self.now += count as u64 * 5;
        }
    }

    fn cpu_fast_set(&mut self, src: u32, dst: u32, ctrl: u32) {
        let count = ((ctrl & 0x1F_FFFF) + 7) & !7;
        let fill = ctrl & (1 << 24) != 0;
        let (mut s, mut d) = (src & !3, dst & !3);
        let v0 = self.read32_raw(s);
        for _ in 0..count {
            let v = if fill { v0 } else { self.read32_raw(s) };
            self.write32_raw(d, v);
            if !fill {
                s = s.wrapping_add(4);
            }
            d = d.wrapping_add(4);
        }
        self.now += count as u64 * 2;
    }

    fn bg_affine_set(&mut self, mut src: u32, mut dst: u32, count: u32) {
        for _ in 0..count {
            let ox = self.read32_raw(src) as i32 as f64 / 256.0;
            let oy = self.read32_raw(src + 4) as i32 as f64 / 256.0;
            let cx = self.read16_raw(src + 8) as i16 as f64;
            let cy = self.read16_raw(src + 10) as i16 as f64;
            let sx = self.read16_raw(src + 12) as i16 as f64 / 256.0;
            let sy = self.read16_raw(src + 14) as i16 as f64 / 256.0;
            let theta = (self.read16_raw(src + 16) >> 8) as f64 / 128.0 * core::f64::consts::PI;
            src += 20;
            let (sin, cos) = theta.sin_cos();
            let a = cos * sx;
            let b = -sin * sx;
            let c = sin * sy;
            let d = cos * sy;
            let rx = ox - (a * cx + b * cy);
            let ry = oy - (c * cx + d * cy);
            self.write16_raw(dst, (a * 256.0) as i32 as u16);
            self.write16_raw(dst + 2, (b * 256.0) as i32 as u16);
            self.write16_raw(dst + 4, (c * 256.0) as i32 as u16);
            self.write16_raw(dst + 6, (d * 256.0) as i32 as u16);
            self.write32_raw(dst + 8, (rx * 256.0) as i32 as u32);
            self.write32_raw(dst + 12, (ry * 256.0) as i32 as u32);
            dst += 16;
        }
        self.now += count as u64 * 50;
    }

    fn obj_affine_set(&mut self, mut src: u32, mut dst: u32, count: u32, stride: u32) {
        for _ in 0..count {
            let sx = self.read16_raw(src) as i16 as f64 / 256.0;
            let sy = self.read16_raw(src + 2) as i16 as f64 / 256.0;
            let theta = (self.read16_raw(src + 4) >> 8) as f64 / 128.0 * core::f64::consts::PI;
            src += 8;
            let (sin, cos) = theta.sin_cos();
            let vals = [cos * sx, -sin * sx, sin * sy, cos * sy];
            for v in vals {
                self.write16_raw(dst, (v * 256.0) as i32 as u16);
                dst = dst.wrapping_add(stride);
            }
        }
        self.now += count as u64 * 40;
    }

    fn bit_unpack(&mut self, mut src: u32, mut dst: u32, info: u32) {
        let len = self.read16_raw(info);
        let sw = self.read8_raw(info + 2);
        let dw = self.read8_raw(info + 3);
        let offset = self.read32_raw(info + 4);
        let zero_flag = offset & 0x8000_0000 != 0;
        let offset = offset & 0x7FFF_FFFF;
        if !matches!(sw, 1 | 2 | 4 | 8) || !matches!(dw, 1 | 2 | 4 | 8 | 16 | 32) {
            return;
        }
        let mut out: u32 = 0;
        let mut out_bits = 0;
        for _ in 0..len {
            let b = self.read8_raw(src);
            src += 1;
            let mut bit = 0;
            while bit < 8 {
                let v = (b >> bit) & ((1 << sw) - 1);
                let v = if v != 0 || zero_flag { v + offset } else { 0 };
                out |= (v & ((1u64 << dw) - 1) as u32) << out_bits;
                out_bits += dw;
                if out_bits >= 32 {
                    self.write32_raw(dst, out);
                    dst += 4;
                    out = 0;
                    out_bits = 0;
                }
                bit += sw;
            }
        }
        self.now += len as u64 * 10;
    }

    /// Write decompressed bytes, in halfwords if the target is VRAM.
    fn emit(&mut self, dst: u32, i: u32, b: u8, vram: bool, pending: &mut u16) {
        if vram {
            if i & 1 == 0 {
                *pending = b as u16;
            } else {
                self.write16_raw(dst + i - 1, *pending | (b as u16) << 8);
            }
        } else {
            self.write8_raw(dst + i, b);
        }
    }

    fn lz77(&mut self, mut src: u32, dst: u32, vram: bool) {
        let header = self.read32_raw(src);
        src += 4;
        let size = header >> 8;
        let mut out = 0u32;
        let mut pending = 0u16;
        let mut window = [0u8; 0x1000];
        while out < size {
            let flags = self.read8_raw(src) as u8;
            src += 1;
            for k in 0..8 {
                if out >= size {
                    break;
                }
                if flags & (0x80 >> k) != 0 {
                    let b1 = self.read8_raw(src);
                    let b2 = self.read8_raw(src + 1);
                    src += 2;
                    let len = (b1 >> 4) + 3;
                    let disp = (((b1 & 0xF) << 8) | b2) + 1;
                    for _ in 0..len {
                        if out >= size {
                            break;
                        }
                        let b = if disp <= out { window[((out - disp) & 0xFFF) as usize] } else { 0 };
                        window[(out & 0xFFF) as usize] = b;
                        self.emit(dst, out, b, vram, &mut pending);
                        out += 1;
                    }
                } else {
                    let b = self.read8_raw(src) as u8;
                    src += 1;
                    window[(out & 0xFFF) as usize] = b;
                    self.emit(dst, out, b, vram, &mut pending);
                    out += 1;
                }
            }
        }
        if vram && out & 1 != 0 {
            self.write16_raw(dst + out - 1, pending);
        }
        self.now += size as u64 * 4;
    }

    fn rl(&mut self, mut src: u32, dst: u32, vram: bool) {
        let header = self.read32_raw(src);
        src += 4;
        let size = header >> 8;
        let mut out = 0;
        let mut pending = 0u16;
        while out < size {
            let flag = self.read8_raw(src);
            src += 1;
            if flag & 0x80 != 0 {
                let len = (flag & 0x7F) + 3;
                let b = self.read8_raw(src) as u8;
                src += 1;
                for _ in 0..len {
                    if out >= size {
                        break;
                    }
                    self.emit(dst, out, b, vram, &mut pending);
                    out += 1;
                }
            } else {
                let len = (flag & 0x7F) + 1;
                for _ in 0..len {
                    if out >= size {
                        break;
                    }
                    let b = self.read8_raw(src) as u8;
                    src += 1;
                    self.emit(dst, out, b, vram, &mut pending);
                    out += 1;
                }
            }
        }
        if vram && out & 1 != 0 {
            self.write16_raw(dst + out - 1, pending);
        }
        self.now += size as u64 * 3;
    }

    fn huffman(&mut self, src: u32, dst: u32) {
        let header = self.read32_raw(src);
        let bits = header & 0xF;
        let size = header >> 8;
        let tree_size = self.read8_raw(src + 4);
        let tree = src + 5;
        let mut stream = src + 4 + (tree_size + 1) * 2;
        let mut out = 0u32;
        let mut acc = 0u32;
        let mut acc_bits = 0;
        let mut node = tree;
        let mut node_val = self.read8_raw(node);
        while out < size {
            let word = self.read32_raw(stream);
            stream += 4;
            for bit in (0..32).rev() {
                let dir = (word >> bit) & 1;
                let next = (node & !1) + ((node_val & 0x3F) + 1) * 2 + dir;
                let leaf = node_val & (if dir == 0 { 0x80 } else { 0x40 }) != 0;
                node = next;
                node_val = self.read8_raw(node);
                if leaf {
                    acc |= node_val << acc_bits;
                    acc_bits += bits;
                    node = tree;
                    node_val = self.read8_raw(node);
                    if acc_bits == 32 {
                        self.write32_raw(dst + out, acc);
                        out += 4;
                        acc = 0;
                        acc_bits = 0;
                        if out >= size {
                            break;
                        }
                    }
                }
            }
        }
        self.now += size as u64 * 8;
    }

    fn diff8(&mut self, mut src: u32, dst: u32, vram: bool) {
        let header = self.read32_raw(src);
        src += 4;
        let size = header >> 8;
        let mut acc = 0u8;
        let mut pending = 0u16;
        for i in 0..size {
            acc = acc.wrapping_add(self.read8_raw(src + i) as u8);
            self.emit(dst, i, acc, vram, &mut pending);
        }
    }

    fn diff16(&mut self, mut src: u32, dst: u32) {
        let header = self.read32_raw(src);
        src += 4;
        let size = header >> 8;
        let mut acc = 0u16;
        let mut i = 0;
        while i < size {
            acc = acc.wrapping_add(self.read16_raw(src + i) as u16);
            self.write16_raw(dst + i, acc);
            i += 2;
        }
    }
}

fn div(n: i32, d: i32) -> (i32, i32) {
    if d == 0 {
        // What the BIOS's loop produces for division by zero.
        return (if n < 0 { -1 } else { 1 }, n);
    }
    if n == i32::MIN && d == -1 {
        return (i32::MIN, 0);
    }
    (n / d, n % d)
}

fn isqrt(v: u32) -> u32 {
    let mut r = (v as f64).sqrt() as u32;
    while (r as u64) * (r as u64) > v as u64 {
        r -= 1;
    }
    while ((r + 1) as u64) * ((r + 1) as u64) <= v as u64 {
        r += 1;
    }
    r
}

fn arctan(x: i32) -> i32 {
    let a = -((x * x) >> 14);
    let mut b = ((0xA9 * a) >> 14) + 0x390;
    b = ((b * a) >> 14) + 0x91C;
    b = ((b * a) >> 14) + 0xFB6;
    b = ((b * a) >> 14) + 0x16AA;
    b = ((b * a) >> 14) + 0x2081;
    b = ((b * a) >> 14) + 0x3651;
    b = ((b * a) >> 14) + 0xA2F9;
    (x * b) >> 16
}

fn arctan2(x: i32, y: i32) -> u32 {
    if x == 0 && y == 0 {
        return 0;
    }
    let t = (y as f64).atan2(x as f64);
    let t = if t < 0.0 { t + 2.0 * core::f64::consts::PI } else { t };
    ((t / (2.0 * core::f64::consts::PI) * 65536.0) as u32) & 0xFFFF
}

#[allow(dead_code)]
const _: u32 = MODE_SYS;

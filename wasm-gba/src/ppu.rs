// Scanline renderer. Each visible line is drawn in one go at the start of its
// HBlank: backgrounds and sprites into line buffers, then windows, priorities
// and color effects per pixel.

use crate::sys::Sys;

pub const W: usize = 240;
pub const H: usize = 160;
const TRANSPARENT: u16 = 0x8000;

const LAYER_OBJ: u8 = 4;
const LAYER_BD: u8 = 5;

pub struct Ppu {
    pub vcount: u32,
    pub in_hblank: bool,
    /// Internal affine reference points: BG2X, BG2Y, BG3X, BG3Y (20.8 fixed).
    pub refs: [i32; 4],
    /// RGBA8888, as the canvas wants it.
    pub frame: [u32; W * H],
    bg: [[u16; W]; 4],
    obj: [u16; W],
    obj_prio: [u8; W],
    /// bit0 semi-transparent, bit1 inside the OBJ window
    obj_flags: [u8; W],
    win: [u8; W],
}

#[inline(always)]
fn rgba(c: u16) -> u32 {
    let r = (c & 31) as u32;
    let g = ((c >> 5) & 31) as u32;
    let b = ((c >> 10) & 31) as u32;
    0xFF00_0000 | ((b << 3 | b >> 2) << 16) | ((g << 3 | g >> 2) << 8) | (r << 3 | r >> 2)
}

#[inline(always)]
fn sext28(v: u32) -> i32 {
    ((v << 4) as i32) >> 4
}

#[inline(always)]
fn blend(a: u16, b: u16, eva: u32, evb: u32) -> u16 {
    let ch = |s: u32| -> u32 {
        let x = ((a as u32 >> s) & 31) * eva + ((b as u32 >> s) & 31) * evb;
        (x >> 4).min(31)
    };
    (ch(0) | ch(5) << 5 | ch(10) << 10) as u16
}

#[inline(always)]
fn brighten(a: u16, evy: u32) -> u16 {
    let ch = |s: u32| -> u32 {
        let c = (a as u32 >> s) & 31;
        c + (((31 - c) * evy) >> 4)
    };
    (ch(0) | ch(5) << 5 | ch(10) << 10) as u16
}

#[inline(always)]
fn darken(a: u16, evy: u32) -> u16 {
    let ch = |s: u32| -> u32 {
        let c = (a as u32 >> s) & 31;
        c - ((c * evy) >> 4)
    };
    (ch(0) | ch(5) << 5 | ch(10) << 10) as u16
}

const OBJ_SIZES: [[(u32, u32); 4]; 3] = [
    [(8, 8), (16, 16), (32, 32), (64, 64)],
    [(16, 8), (32, 8), (32, 16), (64, 32)],
    [(8, 16), (8, 32), (16, 32), (32, 64)],
];

impl Ppu {
    pub fn init(&mut self) {
        self.frame.fill(0xFF00_0000);
    }

    pub fn latch_affine(&mut self, io: &[u16; 0x200]) {
        for k in 0..4 {
            let base = (0x28 + (k / 2) * 0x10 + (k % 2) * 4) >> 1;
            self.refs[k] = sext28(io[base] as u32 | (io[base + 1] as u32) << 16);
        }
    }

    /// A write to BGxX/BGxY reloads the internal reference point.
    pub fn write_ref(&mut self, addr: u32, io: &[u16; 0x200]) {
        let k = match addr & !3 {
            0x28 => 0,
            0x2C => 1,
            0x38 => 2,
            _ => 3,
        };
        let base = ((addr & !3) >> 1) as usize;
        self.refs[k] = sext28(io[base] as u32 | (io[base + 1] as u32) << 16);
    }
}

impl Sys {
    #[inline(always)]
    fn pal(&self, i: usize) -> u16 {
        u16::from_le_bytes([self.palette[i * 2 & 0x3FF], self.palette[(i * 2 + 1) & 0x3FF]]) & 0x7FFF
    }

    #[inline(always)]
    fn vram16(&self, a: usize) -> u16 {
        u16::from_le_bytes([self.vram[a], self.vram[a + 1]])
    }

    pub fn render_line(&mut self, y: u32) {
        let dispcnt = self.io[0];
        let row = y as usize * W;
        if dispcnt & 0x80 != 0 {
            self.ppu.frame[row..row + W].fill(0xFFFF_FFFF);
            self.advance_affine();
            return;
        }
        let mode = dispcnt & 7;
        let bg_mask = match mode {
            0 => 0xF,
            1 => 0x7,
            2 => 0xC,
            3..=5 => 0x4,
            _ => 0,
        };
        let enabled = (dispcnt >> 8) as u8 & (bg_mask | 0x10);

        for i in 0..4 {
            if enabled & (1 << i) == 0 {
                continue;
            }
            match mode {
                0 => self.render_text(i, y),
                1 if i < 2 => self.render_text(i, y),
                1 | 2 => self.render_affine(i),
                _ => self.render_bitmap(mode),
            }
            self.apply_mosaic(i, y);
        }
        let obj_on = enabled & 0x10 != 0;
        if obj_on || dispcnt & 0x8000 != 0 {
            self.render_obj(y, mode >= 3);
        }
        self.compose(y, enabled);
        self.advance_affine();
    }

    fn advance_affine(&mut self) {
        // PB and PD step the reference point once per line.
        self.ppu.refs[0] = self.ppu.refs[0].wrapping_add(self.io[0x22 >> 1] as i16 as i32);
        self.ppu.refs[1] = self.ppu.refs[1].wrapping_add(self.io[0x26 >> 1] as i16 as i32);
        self.ppu.refs[2] = self.ppu.refs[2].wrapping_add(self.io[0x32 >> 1] as i16 as i32);
        self.ppu.refs[3] = self.ppu.refs[3].wrapping_add(self.io[0x36 >> 1] as i16 as i32);
    }

    fn apply_mosaic(&mut self, i: usize, _y: u32) {
        let cnt = self.io[4 + i];
        if cnt & 0x40 == 0 {
            return;
        }
        let mh = (self.io[0x4C >> 1] & 0xF) as usize + 1;
        if mh == 1 {
            return;
        }
        let line = &mut self.ppu.bg[i];
        for x in 0..W {
            line[x] = line[x - x % mh];
        }
    }

    fn render_text(&mut self, i: usize, y: u32) {
        let cnt = self.io[4 + i];
        let hofs = (self.io[8 + i * 2] & 0x1FF) as u32;
        let vofs = (self.io[9 + i * 2] & 0x1FF) as u32;
        let char_base = ((cnt >> 2) & 3) as usize * 0x4000;
        let screen_base = ((cnt >> 8) & 0x1F) as usize * 0x800;
        let bpp8 = cnt & 0x80 != 0;
        let size = cnt >> 14;
        let wmask = if size & 1 != 0 { 511 } else { 255 };
        let hmask = if size & 2 != 0 { 511 } else { 255 };
        let mut yy = y;
        if cnt & 0x40 != 0 {
            let mv = ((self.io[0x4C >> 1] >> 4) & 0xF) as u32 + 1;
            yy -= yy % mv;
        }
        let ty = (yy + vofs) & hmask;
        let block_y = if ty >= 256 { if size & 1 != 0 { 2 } else { 1 } } else { 0 };
        let map_row = screen_base + ((ty as usize >> 3) & 31) * 64;

        let mut line = [TRANSPARENT; W];
        let mut x = 0usize;
        let mut tx = (hofs) & wmask;
        while x < W {
            let block = block_y + (tx >> 8) as usize;
            let map_addr = map_row + block * 0x800 + ((tx as usize >> 3) & 31) * 2;
            let entry = self.vram16(map_addr & 0xFFFF);
            let tile = (entry & 0x3FF) as usize;
            let hflip = entry & 0x400 != 0;
            let vflip = entry & 0x800 != 0;
            let row = if vflip { 7 - (ty & 7) } else { ty & 7 } as usize;
            let start = (tx & 7) as usize;
            let n = (8 - start).min(W - x);
            if bpp8 {
                let addr = char_base + tile * 64 + row * 8;
                if addr + 8 <= 0x10000 {
                    for k in 0..n {
                        let col = start + k;
                        let col = if hflip { 7 - col } else { col };
                        let p = self.vram[addr + col];
                        if p != 0 {
                            line[x + k] = self.pal(p as usize);
                        }
                    }
                }
            } else {
                let addr = char_base + tile * 32 + row * 4;
                let pal = ((entry >> 12) as usize) << 4;
                if addr + 4 <= 0x10000 {
                    let bits = u32::from_le_bytes([self.vram[addr], self.vram[addr + 1], self.vram[addr + 2], self.vram[addr + 3]]);
                    for k in 0..n {
                        let col = start + k;
                        let col = if hflip { 7 - col } else { col };
                        let p = (bits >> (col * 4)) & 0xF;
                        if p != 0 {
                            line[x + k] = self.pal(pal | p as usize);
                        }
                    }
                }
            }
            x += n;
            tx = (tx + n as u32) & wmask;
        }
        self.ppu.bg[i] = line;
    }

    fn render_affine(&mut self, i: usize) {
        let cnt = self.io[4 + i];
        let p = if i == 2 { 0x20 >> 1 } else { 0x30 >> 1 };
        let pa = self.io[p] as i16 as i32;
        let pc = self.io[p + 2] as i16 as i32;
        let (mut x, mut y) = if i == 2 { (self.ppu.refs[0], self.ppu.refs[1]) } else { (self.ppu.refs[2], self.ppu.refs[3]) };
        let char_base = ((cnt >> 2) & 3) as usize * 0x4000;
        let screen_base = ((cnt >> 8) & 0x1F) as usize * 0x800;
        let size = 128i32 << (cnt >> 14);
        let tiles = (size >> 3) as usize;
        let wrap = cnt & 0x2000 != 0;
        let mut line = [TRANSPARENT; W];
        for px in line.iter_mut() {
            let mut tx = x >> 8;
            let mut ty = y >> 8;
            x = x.wrapping_add(pa);
            y = y.wrapping_add(pc);
            if wrap {
                tx &= size - 1;
                ty &= size - 1;
            } else if tx < 0 || ty < 0 || tx >= size || ty >= size {
                continue;
            }
            let (tx, ty) = (tx as usize, ty as usize);
            let tile = self.vram[(screen_base + (ty >> 3) * tiles + (tx >> 3)) & 0xFFFF] as usize;
            let c = self.vram[(char_base + tile * 64 + (ty & 7) * 8 + (tx & 7)) & 0xFFFF];
            if c != 0 {
                *px = self.pal(c as usize);
            }
        }
        self.ppu.bg[i] = line;
    }

    fn render_bitmap(&mut self, mode: u16) {
        let pa = self.io[0x20 >> 1] as i16 as i32;
        let pc = self.io[0x24 >> 1] as i16 as i32;
        let (mut x, mut y) = (self.ppu.refs[0], self.ppu.refs[1]);
        let page = if self.io[0] & 0x10 != 0 { 0xA000 } else { 0 };
        let mut line = [TRANSPARENT; W];
        for px in line.iter_mut() {
            let tx = x >> 8;
            let ty = y >> 8;
            x = x.wrapping_add(pa);
            y = y.wrapping_add(pc);
            match mode {
                3 => {
                    if (0..240).contains(&tx) && (0..160).contains(&ty) {
                        *px = self.vram16((ty as usize * 240 + tx as usize) * 2) & 0x7FFF;
                    }
                }
                4 => {
                    if (0..240).contains(&tx) && (0..160).contains(&ty) {
                        let c = self.vram[page + ty as usize * 240 + tx as usize];
                        if c != 0 {
                            *px = self.pal(c as usize);
                        }
                    }
                }
                _ => {
                    if (0..160).contains(&tx) && (0..128).contains(&ty) {
                        *px = self.vram16(page + (ty as usize * 160 + tx as usize) * 2) & 0x7FFF;
                    }
                }
            }
        }
        self.ppu.bg[2] = line;
    }

    fn render_obj(&mut self, y: u32, bitmap: bool) {
        self.ppu.obj.fill(TRANSPARENT);
        self.ppu.obj_prio.fill(4);
        self.ppu.obj_flags.fill(0);
        let one_d = self.io[0] & 0x40 != 0;
        let oam16 = |s: &Sys, a: usize| u16::from_le_bytes([s.oam[a], s.oam[a + 1]]);
        for i in 0..128 {
            let a0 = oam16(self, i * 8);
            let affine = a0 & 0x100 != 0;
            if !affine && a0 & 0x200 != 0 {
                continue;
            }
            let mode = (a0 >> 10) & 3;
            if mode == 3 {
                continue;
            }
            let shape = (a0 >> 14) as usize;
            if shape == 3 {
                continue;
            }
            let a1 = oam16(self, i * 8 + 2);
            let a2 = oam16(self, i * 8 + 4);
            let (w, h) = OBJ_SIZES[shape][(a1 >> 14) as usize];
            let double = affine && a0 & 0x200 != 0;
            let (bw, bh) = if double { (w * 2, h * 2) } else { (w, h) };
            let sy = (a0 & 0xFF) as u32;
            let dy = (y.wrapping_sub(sy)) & 0xFF;
            if dy >= bh {
                continue;
            }
            let mut sx = (a1 & 0x1FF) as i32;
            if sx >= 240 {
                sx -= 512;
            }
            let tile = (a2 & 0x3FF) as u32;
            if bitmap && tile < 512 {
                continue;
            }
            let prio = ((a2 >> 10) & 3) as u8;
            let bpp8 = a0 & 0x2000 != 0;
            let pal = ((a2 >> 12) as usize) << 4;
            let stride = if one_d { if bpp8 { w / 8 * 2 } else { w / 8 } } else { 32 };
            let (pa, pb, pc, pd) = if affine {
                let g = ((a1 >> 9) & 0x1F) as usize * 32;
                (
                    oam16(self, g + 6) as i16 as i32,
                    oam16(self, g + 14) as i16 as i32,
                    oam16(self, g + 22) as i16 as i32,
                    oam16(self, g + 30) as i16 as i32,
                )
            } else {
                (0, 0, 0, 0)
            };
            let hflip = !affine && a1 & 0x1000 != 0;
            let vflip = !affine && a1 & 0x2000 != 0;
            for bx in 0..bw as i32 {
                let px = sx + bx;
                if !(0..240).contains(&px) {
                    continue;
                }
                let (tx, ty) = if affine {
                    let rx = bx - bw as i32 / 2;
                    let ry = dy as i32 - bh as i32 / 2;
                    let tx = ((pa * rx + pb * ry) >> 8) + w as i32 / 2;
                    let ty = ((pc * rx + pd * ry) >> 8) + h as i32 / 2;
                    if tx < 0 || ty < 0 || tx >= w as i32 || ty >= h as i32 {
                        continue;
                    }
                    (tx as u32, ty as u32)
                } else {
                    (if hflip { w - 1 - bx as u32 } else { bx as u32 }, if vflip { h - 1 - dy } else { dy })
                };
                let idx = if bpp8 {
                    let t = ((tile & !1) + (ty >> 3) * stride + (tx >> 3) * 2) & 0x3FF;
                    let c = self.vram[0x10000 + (t as usize) * 32 + (ty as usize & 7) * 8 + (tx as usize & 7)];
                    if c == 0 {
                        continue;
                    }
                    c as usize
                } else {
                    let t = (tile + (ty >> 3) * stride + (tx >> 3)) & 0x3FF;
                    let b = self.vram[0x10000 + (t as usize) * 32 + (ty as usize & 7) * 4 + (tx as usize & 7) / 2];
                    let c = if tx & 1 != 0 { b >> 4 } else { b & 0xF };
                    if c == 0 {
                        continue;
                    }
                    pal | c as usize
                };
                let px = px as usize;
                if mode == 2 {
                    self.ppu.obj_flags[px] |= 2;
                    continue;
                }
                if self.ppu.obj[px] != TRANSPARENT && prio >= self.ppu.obj_prio[px] {
                    continue;
                }
                self.ppu.obj[px] = self.pal(0x100 + idx);
                self.ppu.obj_prio[px] = prio;
                self.ppu.obj_flags[px] = (self.ppu.obj_flags[px] & 2) | (mode == 1) as u8;
            }
        }
    }

    fn compute_windows(&mut self, y: u32) -> bool {
        let dispcnt = self.io[0];
        if dispcnt & 0xE000 == 0 {
            return false;
        }
        let winin = self.io[0x48 >> 1];
        let winout = self.io[0x4A >> 1];
        self.ppu.win.fill((winout & 0x3F) as u8);
        if dispcnt & 0x8000 != 0 {
            let objwin = ((winout >> 8) & 0x3F) as u8;
            for x in 0..W {
                if self.ppu.obj_flags[x] & 2 != 0 {
                    self.ppu.win[x] = objwin;
                }
            }
        }
        // Window 1 then window 0, so window 0 wins.
        for w in [1usize, 0] {
            if dispcnt & (0x2000 << w) == 0 {
                continue;
            }
            let hv = self.io[(0x40 >> 1) + w];
            let vv = self.io[(0x44 >> 1) + w];
            let (x1, x2) = ((hv >> 8) as u32, (hv & 0xFF) as u32);
            let (y1, y2) = ((vv >> 8) as u32, (vv & 0xFF) as u32);
            let inside_y = if y1 <= y2 { y >= y1 && y < y2 } else { y >= y1 || y < y2 };
            if !inside_y {
                continue;
            }
            let bits = ((winin >> (w * 8)) & 0x3F) as u8;
            for x in 0..W as u32 {
                let inside = if x1 <= x2 { x >= x1 && x < x2 } else { x >= x1 || x < x2 };
                if inside {
                    self.ppu.win[x as usize] = bits;
                }
            }
        }
        true
    }

    fn compose(&mut self, y: u32, enabled: u8) {
        let windows = self.compute_windows(y);
        let bldcnt = self.io[0x50 >> 1];
        let effect = (bldcnt >> 6) & 3;
        let alpha = self.io[0x52 >> 1];
        let eva = ((alpha & 0x1F) as u32).min(16);
        let evb = (((alpha >> 8) & 0x1F) as u32).min(16);
        let evy = ((self.io[0x54 >> 1] & 0x1F) as u32).min(16);
        let backdrop = self.pal(0);

        // Layer order: for each priority, OBJ first, then BGs by index.
        let mut order = [0u8; 8];
        let mut n = 0;
        for p in 0..4u16 {
            if enabled & 0x10 != 0 {
                order[n] = LAYER_OBJ | ((p as u8) << 4);
                n += 1;
            }
            for i in 0..4 {
                if enabled & (1 << i) != 0 && self.io[4 + i] & 3 == p {
                    order[n] = i as u8;
                    n += 1;
                }
            }
        }
        let order = &order[..n];
        let row = y as usize * W;
        let simple = !windows && effect == 0;

        for x in 0..W {
            let mask = if windows { self.ppu.win[x] } else { 0x3F };
            let mut top = backdrop;
            let mut top_layer = LAYER_BD;
            let mut second = backdrop;
            let mut second_layer = LAYER_BD;
            let mut found = 0;
            for &l in order {
                let (layer, c) = if l & 0xF == LAYER_OBJ {
                    let c = self.ppu.obj[x];
                    if c == TRANSPARENT || self.ppu.obj_prio[x] != l >> 4 || mask & 0x10 == 0 {
                        continue;
                    }
                    (LAYER_OBJ, c)
                } else {
                    let c = self.ppu.bg[l as usize][x];
                    if c == TRANSPARENT || mask & (1 << l) == 0 {
                        continue;
                    }
                    (l, c)
                };
                if found == 0 {
                    top = c;
                    top_layer = layer;
                    found = 1;
                    if simple && !(layer == LAYER_OBJ && self.ppu.obj_flags[x] & 1 != 0) {
                        break;
                    }
                } else {
                    second = c;
                    second_layer = layer;
                    break;
                }
            }
            let mut out = top;
            if !simple || (top_layer == LAYER_OBJ && self.ppu.obj_flags[x] & 1 != 0) {
                let semi = top_layer == LAYER_OBJ && self.ppu.obj_flags[x] & 1 != 0;
                let first_t = bldcnt & (1 << top_layer) != 0;
                let second_t = bldcnt & (1 << (8 + second_layer)) != 0;
                if semi && second_t {
                    out = blend(top, second, eva, evb);
                } else if mask & 0x20 != 0 && first_t {
                    out = match effect {
                        1 if second_t => blend(top, second, eva, evb),
                        2 => brighten(top, evy),
                        3 => darken(top, evy),
                        _ => top,
                    };
                }
            }
            self.ppu.frame[row + x] = rgba(out);
        }
    }
}

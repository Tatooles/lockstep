// Scanline renderer. Each visible line is drawn in one go at the start of its
// HBlank: backgrounds and sprites into line buffers, then the layers are
// painted back to front (tracking the top two per pixel for blending), then
// color effects and conversion to RGBA.

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
    any_semi: bool,
    /// Bit p set if any sprite pixel on this line has priority p.
    obj_prios: u8,
    win: [u8; W],
    top: [u16; W],
    top_l: [u8; W],
    bot: [u16; W],
    bot_l: [u8; W],
}

const fn rgba_calc(c: u16) -> u32 {
    let r = (c & 31) as u32;
    let g = ((c >> 5) & 31) as u32;
    let b = ((c >> 10) & 31) as u32;
    0xFF00_0000 | ((b << 3 | b >> 2) << 16) | ((g << 3 | g >> 2) << 8) | (r << 3 | r >> 2)
}

// BGR555 -> RGBA8888 for every color. Filled at start-up (zero-initialized
// memory, so it costs nothing in the Wasm binary).
static mut RGBA: [u32; 32768] = [0; 32768];

fn init_rgba() {
    let t = unsafe { &mut *core::ptr::addr_of_mut!(RGBA) };
    if t[32767] == 0 {
        for (i, v) in t.iter_mut().enumerate() {
            *v = rgba_calc(i as u16);
        }
    }
}

#[inline(always)]
fn rgba(c: u16) -> u32 {
    unsafe { *core::ptr::addr_of!(RGBA).cast::<u32>().add((c & 0x7FFF) as usize) }
}

#[inline(always)]
fn sext28(v: u32) -> i32 {
    ((v << 4) as i32) >> 4
}

// Color math on 15-bit BGR with the channels spread into 10-bit lanes of a
// u32 (r | g << 10 | b << 20), so one multiply handles all three.
const LANES5: u32 = 0x1F | 0x1F << 10 | 0x1F << 20;

#[inline(always)]
fn spread(c: u16) -> u32 {
    let c = c as u32;
    (c & 0x1F) | (c & 0x3E0) << 5 | (c & 0x7C00) << 10
}

#[inline(always)]
fn pack(s: u32) -> u16 {
    ((s & 0x1F) | (s >> 5) & 0x3E0 | (s >> 10) & 0x7C00) as u16
}

#[inline(always)]
fn blend(a: u16, b: u16, eva: u32, evb: u32) -> u16 {
    // Each lane is at most 31 * 16 * 2 = 992, so lanes don't overflow.
    let s = ((spread(a) * eva + spread(b) * evb) >> 4) & (0x3F | 0x3F << 10 | 0x3F << 20);
    // Saturate lanes above 31.
    let over = (s >> 5) & (1 | 1 << 10 | 1 << 20);
    pack((s | over * 31) & LANES5)
}

#[inline(always)]
fn brighten(a: u16, evy: u32) -> u16 {
    let s = spread(a);
    pack(s + ((((LANES5 - s) * evy) >> 4) & LANES5))
}

#[inline(always)]
fn darken(a: u16, evy: u32) -> u16 {
    let s = spread(a);
    pack(s - (((s * evy) >> 4) & LANES5))
}

/// Palette entry `i` (0..511; 256+ are sprite colors).
#[inline(always)]
fn pal(palette: &[u8; 0x400], i: usize) -> u16 {
    let i = (i & 0x1FF) * 2;
    unsafe { core::ptr::read_unaligned(palette.as_ptr().add(i) as *const u16) & 0x7FFF }
}

/// VRAM reads at indices the caller has masked into range (< 0x18000).
#[inline(always)]
fn v8(vram: &[u8; 0x18000], a: usize) -> u8 {
    debug_assert!(a < 0x18000);
    unsafe { *vram.get_unchecked(a) }
}

#[inline(always)]
fn v16(vram: &[u8; 0x18000], a: usize) -> u16 {
    debug_assert!(a + 1 < 0x18000);
    unsafe { core::ptr::read_unaligned(vram.as_ptr().add(a) as *const u16) }
}

#[inline(always)]
fn v32(vram: &[u8; 0x18000], a: usize) -> u32 {
    debug_assert!(a + 3 < 0x18000);
    unsafe { core::ptr::read_unaligned(vram.as_ptr().add(a) as *const u32) }
}

const OBJ_SIZES: [[(u32, u32); 4]; 3] = [
    [(8, 8), (16, 16), (32, 32), (64, 64)],
    [(16, 8), (32, 8), (32, 16), (64, 32)],
    [(8, 16), (8, 32), (16, 32), (32, 64)],
];

impl Ppu {
    pub fn init(&mut self) {
        init_rgba();
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

        self.ppu.any_semi = false;
        self.ppu.obj_prios = 0;
        if enabled & 0x10 != 0 || dispcnt & 0x8000 != 0 {
            self.render_obj(y, mode >= 3);
        }
        let windows = self.compute_windows(y);
        let effect = (self.io[0x50 >> 1] >> 6) & 3;
        // Track the top two layers per pixel only when something blends.
        let two = effect != 0 || self.ppu.any_semi;
        let backdrop = pal(&self.palette, 0);
        self.ppu.top.fill(backdrop);
        if two {
            self.ppu.top_l.fill(LAYER_BD);
            self.ppu.bot.fill(backdrop);
            self.ppu.bot_l.fill(LAYER_BD);
        }
        match (two, windows) {
            (false, false) => self.paint_layers::<false, false>(y, mode, enabled),
            (false, true) => self.paint_layers::<false, true>(y, mode, enabled),
            (true, false) => self.paint_layers::<true, false>(y, mode, enabled),
            (true, true) => self.paint_layers::<true, true>(y, mode, enabled),
        }
        self.finish_line(y, two, windows);
        self.advance_affine();
    }

    fn advance_affine(&mut self) {
        // PB and PD step the reference point once per line.
        self.ppu.refs[0] = self.ppu.refs[0].wrapping_add(self.io[0x22 >> 1] as i16 as i32);
        self.ppu.refs[1] = self.ppu.refs[1].wrapping_add(self.io[0x26 >> 1] as i16 as i32);
        self.ppu.refs[2] = self.ppu.refs[2].wrapping_add(self.io[0x32 >> 1] as i16 as i32);
        self.ppu.refs[3] = self.ppu.refs[3].wrapping_add(self.io[0x36 >> 1] as i16 as i32);
    }

    fn apply_mosaic(&mut self, i: usize) {
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

        let vram = &self.vram;
        let palette = &self.palette;
        let line = &mut self.ppu.bg[i];
        line.fill(TRANSPARENT);
        let mut x = 0usize;
        let mut tx = hofs & wmask;
        while x < W {
            let block = block_y + (tx >> 8) as usize;
            let map_addr = (map_row + block * 0x800 + ((tx as usize >> 3) & 31) * 2) & 0xFFFE;
            let entry = v16(vram, map_addr);
            let tile = (entry & 0x3FF) as usize;
            let row = if entry & 0x800 != 0 { 7 - (ty & 7) } else { ty & 7 } as usize;
            let start = (tx & 7) as usize;
            let n = (8 - start).min(W - x);
            let out = &mut line[x..x + n];
            if bpp8 {
                let addr = char_base + tile * 64 + row * 8;
                if addr + 8 <= 0x10000 {
                    let mut bits = v32(vram, addr) as u64 | (v32(vram, addr + 4) as u64) << 32;
                    if entry & 0x400 != 0 {
                        bits = bits.swap_bytes();
                    }
                    bits >>= start * 8;
                    if bits != 0 {
                        for (k, px) in out.iter_mut().enumerate() {
                            let p = (bits >> (k * 8)) as u8;
                            if p != 0 {
                                *px = pal(palette, p as usize);
                            }
                        }
                    }
                }
            } else {
                let addr = char_base + tile * 32 + row * 4;
                if addr + 4 <= 0x10000 {
                    let mut bits = v32(vram, addr);
                    if entry & 0x400 != 0 {
                        bits = bits.swap_bytes();
                        bits = ((bits & 0x0F0F_0F0F) << 4) | ((bits >> 4) & 0x0F0F_0F0F);
                    }
                    bits >>= start * 4;
                    if bits != 0 {
                        let pb = ((entry >> 12) as usize) << 4;
                        for (k, px) in out.iter_mut().enumerate() {
                            let p = (bits >> (k * 4)) & 0xF;
                            if p != 0 {
                                *px = pal(palette, pb | p as usize);
                            }
                        }
                    }
                }
            }
            x += n;
            tx = (tx + n as u32) & wmask;
        }
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
        let vram = &self.vram;
        let palette = &self.palette;
        let line = &mut self.ppu.bg[i];
        for px in line.iter_mut() {
            let mut tx = x >> 8;
            let mut ty = y >> 8;
            x = x.wrapping_add(pa);
            y = y.wrapping_add(pc);
            if wrap {
                tx &= size - 1;
                ty &= size - 1;
            } else if tx < 0 || ty < 0 || tx >= size || ty >= size {
                *px = TRANSPARENT;
                continue;
            }
            let (tx, ty) = (tx as usize, ty as usize);
            let tile = v8(vram, (screen_base + (ty >> 3) * tiles + (tx >> 3)) & 0xFFFF) as usize;
            let c = v8(vram, (char_base + tile * 64 + (ty & 7) * 8 + (tx & 7)) & 0xFFFF);
            *px = if c != 0 { pal(palette, c as usize) } else { TRANSPARENT };
        }
    }

    fn render_bitmap(&mut self, mode: u16) {
        let pa = self.io[0x20 >> 1] as i16 as i32;
        let pc = self.io[0x24 >> 1] as i16 as i32;
        let (mut x, mut y) = (self.ppu.refs[0], self.ppu.refs[1]);
        let page = if self.io[0] & 0x10 != 0 { 0xA000 } else { 0 };
        let vram = &self.vram;
        let palette = &self.palette;
        let line = &mut self.ppu.bg[2];
        for px in line.iter_mut() {
            let tx = x >> 8;
            let ty = y >> 8;
            x = x.wrapping_add(pa);
            y = y.wrapping_add(pc);
            *px = TRANSPARENT;
            match mode {
                3 => {
                    if (0..240).contains(&tx) && (0..160).contains(&ty) {
                        *px = v16(vram, (ty as usize * 240 + tx as usize) * 2) & 0x7FFF;
                    }
                }
                4 => {
                    if (0..240).contains(&tx) && (0..160).contains(&ty) {
                        let c = v8(vram, page + ty as usize * 240 + tx as usize);
                        if c != 0 {
                            *px = pal(palette, c as usize);
                        }
                    }
                }
                _ => {
                    if (0..160).contains(&tx) && (0..128).contains(&ty) {
                        *px = v16(vram, page + (ty as usize * 160 + tx as usize) * 2) & 0x7FFF;
                    }
                }
            }
        }
    }

    fn render_obj(&mut self, y: u32, bitmap: bool) {
        let ppu = &mut self.ppu;
        ppu.obj.fill(TRANSPARENT);
        ppu.obj_prio.fill(4);
        ppu.obj_flags.fill(0);
        let one_d = self.io[0] & 0x40 != 0;
        let oam = &self.oam;
        let vram = &self.vram;
        let palette = &self.palette;
        let oam16 = |a: usize| u16::from_le_bytes([oam[a & 0x3FF], oam[(a + 1) & 0x3FF]]);
        for i in 0..128 {
            let a0 = oam16(i * 8);
            let affine = a0 & 0x100 != 0;
            if !affine && a0 & 0x200 != 0 {
                continue;
            }
            let mode = (a0 >> 10) & 3;
            let shape = (a0 >> 14) as usize;
            if mode == 3 || shape == 3 {
                continue;
            }
            let a1 = oam16(i * 8 + 2);
            let (w, h) = OBJ_SIZES[shape][(a1 >> 14) as usize];
            let double = affine && a0 & 0x200 != 0;
            let (bw, bh) = if double { (w * 2, h * 2) } else { (w, h) };
            let dy = (y.wrapping_sub((a0 & 0xFF) as u32)) & 0xFF;
            if dy >= bh {
                continue;
            }
            let a2 = oam16(i * 8 + 4);
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
            let pb = 0x100 | (((a2 >> 12) as usize) << 4);
            let stride = if one_d { if bpp8 { w / 8 * 2 } else { w / 8 } } else { 32 };
            let semi = (mode == 1) as u8;
            if semi != 0 {
                ppu.any_semi = true;
            }
            // Texel (tx, ty) of this sprite -> color index (0 = transparent).
            let texel = |tx: u32, ty: u32| -> usize {
                if bpp8 {
                    let t = ((tile & !1) + (ty >> 3) * stride + (tx >> 3) * 2) & 0x3FF;
                    v8(vram, 0x10000 + (t as usize) * 32 + (ty as usize & 7) * 8 + (tx as usize & 7)) as usize
                } else {
                    let t = (tile + (ty >> 3) * stride + (tx >> 3)) & 0x3FF;
                    let b = v8(vram, 0x10000 + (t as usize) * 32 + (ty as usize & 7) * 4 + (tx as usize & 7) / 2);
                    (if tx & 1 != 0 { b >> 4 } else { b & 0xF }) as usize
                }
            };
            let x0 = (-sx).max(0) as u32;
            let x1 = (240 - sx).min(bw as i32).max(0) as u32;
            if affine {
                let g = ((a1 >> 9) & 0x1F) as usize * 32;
                let pa = oam16(g + 6) as i16 as i32;
                let pb_ = oam16(g + 14) as i16 as i32;
                let pc = oam16(g + 22) as i16 as i32;
                let pd = oam16(g + 30) as i16 as i32;
                let ry = dy as i32 - bh as i32 / 2;
                for bx in x0..x1 {
                    let rx = bx as i32 - bw as i32 / 2;
                    let tx = ((pa * rx + pb_ * ry) >> 8) + w as i32 / 2;
                    let ty = ((pc * rx + pd * ry) >> 8) + h as i32 / 2;
                    if tx < 0 || ty < 0 || tx >= w as i32 || ty >= h as i32 {
                        continue;
                    }
                    let c = texel(tx as u32, ty as u32);
                    if c == 0 {
                        continue;
                    }
                    let px = (sx + bx as i32) as usize;
                    if mode == 2 {
                        ppu.obj_flags[px] |= 2;
                    } else if ppu.obj[px] == TRANSPARENT || prio < ppu.obj_prio[px] {
                        ppu.obj[px] = pal(palette, if bpp8 { 0x100 | c } else { pb | c });
                        ppu.obj_prio[px] = prio;
                        ppu.obj_prios |= 1 << prio;
                        ppu.obj_flags[px] = (ppu.obj_flags[px] & 2) | semi;
                    }
                }
            } else {
                let ty = if a1 & 0x2000 != 0 { h - 1 - dy } else { dy };
                let hflip = a1 & 0x1000 != 0;
                for bx in x0..x1 {
                    let tx = if hflip { w - 1 - bx } else { bx };
                    let c = texel(tx, ty);
                    if c == 0 {
                        continue;
                    }
                    let px = (sx + bx as i32) as usize;
                    if mode == 2 {
                        ppu.obj_flags[px] |= 2;
                    } else if ppu.obj[px] == TRANSPARENT || prio < ppu.obj_prio[px] {
                        ppu.obj[px] = pal(palette, if bpp8 { 0x100 | c } else { pb | c });
                        ppu.obj_prio[px] = prio;
                        ppu.obj_prios |= 1 << prio;
                        ppu.obj_flags[px] = (ppu.obj_flags[px] & 2) | semi;
                    }
                }
            }
        }
    }

    /// Fill `win` with the enabled-layer mask per pixel. Returns false (and
    /// leaves `win` alone) when no window is on.
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
            let (x1, x2) = ((hv >> 8) as usize, (hv & 0xFF) as usize);
            let (y1, y2) = ((vv >> 8) as u32, (vv & 0xFF) as u32);
            let inside_y = if y1 <= y2 { y >= y1 && y < y2 } else { y >= y1 || y < y2 };
            if !inside_y {
                continue;
            }
            let bits = ((winin >> (w * 8)) & 0x3F) as u8;
            if x1 <= x2 {
                self.ppu.win[x1.min(W)..x2.min(W)].fill(bits);
            } else {
                self.ppu.win[x1.min(W)..].fill(bits);
                self.ppu.win[..x2.min(W)].fill(bits);
            }
        }
        true
    }

    /// Paint every layer back to front: per priority, BGs by descending index,
    /// then that priority's sprites. Tile BGs are decoded straight into the
    /// compositing buffers; the rest go through their line buffer.
    fn paint_layers<const TWO: bool, const WIN: bool>(&mut self, y: u32, mode: u16, enabled: u8) {
        for p in (0..4u16).rev() {
            for i in (0..4usize).rev() {
                if enabled & (1 << i) == 0 || self.io[4 + i] & 3 != p {
                    continue;
                }
                let text = mode == 0 || (mode == 1 && i < 2);
                if text && self.io[4 + i] & 0x40 == 0 {
                    self.draw_text::<TWO, WIN>(i, y);
                    continue;
                }
                match mode {
                    0 | 1 if text => self.render_text(i, y),
                    1 | 2 => self.render_affine(i),
                    _ => self.render_bitmap(mode),
                }
                self.apply_mosaic(i);
                let ppu = &mut self.ppu;
                let mut paint = Paint { top: &mut ppu.top, top_l: &mut ppu.top_l, bot: &mut ppu.bot, bot_l: &mut ppu.bot_l, win: &ppu.win };
                let src = &ppu.bg[i];
                let bit = 1u8 << i;
                for x in 0..W {
                    if src[x] != TRANSPARENT {
                        paint.put::<TWO, WIN>(x, src[x], i as u8, bit);
                    }
                }
            }
            if enabled & 0x10 != 0 && self.ppu.obj_prios & (1 << p) != 0 {
                let p = p as u8;
                let ppu = &mut self.ppu;
                let mut paint = Paint { top: &mut ppu.top, top_l: &mut ppu.top_l, bot: &mut ppu.bot, bot_l: &mut ppu.bot_l, win: &ppu.win };
                for x in 0..W {
                    let c = ppu.obj[x];
                    if c != TRANSPARENT && ppu.obj_prio[x] == p {
                        paint.put::<TWO, WIN>(x, c, LAYER_OBJ, 0x10);
                    }
                }
            }
        }
    }

    /// A text BG decoded tile by tile straight into the compositing buffers.
    fn draw_text<const TWO: bool, const WIN: bool>(&mut self, i: usize, y: u32) {
        let cnt = self.io[4 + i];
        let hofs = (self.io[8 + i * 2] & 0x1FF) as u32;
        let vofs = (self.io[9 + i * 2] & 0x1FF) as u32;
        let char_base = ((cnt >> 2) & 3) as usize * 0x4000;
        let screen_base = ((cnt >> 8) & 0x1F) as usize * 0x800;
        let bpp8 = cnt & 0x80 != 0;
        let size = cnt >> 14;
        let wmask = if size & 1 != 0 { 511 } else { 255 };
        let hmask = if size & 2 != 0 { 511 } else { 255 };
        let ty = (y + vofs) & hmask;
        let block_y = if ty >= 256 { if size & 1 != 0 { 2 } else { 1 } } else { 0 };
        let map_row = screen_base + ((ty as usize >> 3) & 31) * 64;
        let layer = i as u8;
        let bit = 1u8 << i;

        let vram = &self.vram;
        let palette = &self.palette;
        let ppu = &mut self.ppu;
        let mut paint = Paint { top: &mut ppu.top, top_l: &mut ppu.top_l, bot: &mut ppu.bot, bot_l: &mut ppu.bot_l, win: &ppu.win };
        let mut x = 0usize;
        let mut tx = hofs & wmask;
        while x < W {
            let block = block_y + (tx >> 8) as usize;
            let map_addr = (map_row + block * 0x800 + ((tx as usize >> 3) & 31) * 2) & 0xFFFE;
            let entry = v16(vram, map_addr);
            let tile = (entry & 0x3FF) as usize;
            let row = if entry & 0x800 != 0 { 7 - (ty & 7) } else { ty & 7 } as usize;
            let start = (tx & 7) as usize;
            let n = (8 - start).min(W - x);
            if bpp8 {
                let addr = char_base + tile * 64 + row * 8;
                if addr + 8 <= 0x10000 {
                    let mut bits = v32(vram, addr) as u64 | (v32(vram, addr + 4) as u64) << 32;
                    if entry & 0x400 != 0 {
                        bits = bits.swap_bytes();
                    }
                    bits >>= start * 8;
                    if bits != 0 {
                        for k in 0..n {
                            let p = (bits >> (k * 8)) as u8;
                            if p != 0 {
                                paint.put::<TWO, WIN>(x + k, pal(palette, p as usize), layer, bit);
                            }
                        }
                    }
                }
            } else {
                let addr = char_base + tile * 32 + row * 4;
                if addr + 4 <= 0x10000 {
                    let mut bits = v32(vram, addr);
                    if entry & 0x400 != 0 {
                        bits = bits.swap_bytes();
                        bits = ((bits & 0x0F0F_0F0F) << 4) | ((bits >> 4) & 0x0F0F_0F0F);
                    }
                    bits >>= start * 4;
                    if bits != 0 {
                        let pb = ((entry >> 12) as usize) << 4;
                        for k in 0..n {
                            let p = (bits >> (k * 4)) & 0xF;
                            if p != 0 {
                                paint.put::<TWO, WIN>(x + k, pal(palette, pb | p as usize), layer, bit);
                            }
                        }
                    }
                }
            }
            x += n;
            tx = (tx + n as u32) & wmask;
        }
    }

    /// Color effects (when TWO) and conversion to RGBA.
    fn finish_line(&mut self, y: u32, two: bool, windows: bool) {
        let row = y as usize * W;
        let ppu = &mut self.ppu;
        let out = &mut ppu.frame[row..row + W];
        if !two {
            for x in 0..W {
                out[x] = rgba(ppu.top[x]);
            }
            return;
        }
        let bldcnt = self.io[0x50 >> 1] as u32;
        let effect = (bldcnt >> 6) & 3;
        let alpha = self.io[0x52 >> 1];
        let eva = ((alpha & 0x1F) as u32).min(16);
        let evb = (((alpha >> 8) & 0x1F) as u32).min(16);
        let evy = ((self.io[0x54 >> 1] & 0x1F) as u32).min(16);
        for x in 0..W {
            let top = ppu.top[x];
            let tl = ppu.top_l[x] as u32;
            let second_t = (bldcnt >> (8 + ppu.bot_l[x] as u32)) & 1 != 0;
            let semi = tl == LAYER_OBJ as u32 && ppu.obj_flags[x] & 1 != 0;
            let effects_on = !windows || ppu.win[x] & 0x20 != 0;
            let first_t = effects_on && (bldcnt >> tl) & 1 != 0;
            let c = if semi && second_t {
                blend(top, ppu.bot[x], eva, evb)
            } else if first_t {
                match effect {
                    1 if second_t => blend(top, ppu.bot[x], eva, evb),
                    2 => brighten(top, evy),
                    3 => darken(top, evy),
                    _ => top,
                }
            } else {
                top
            };
            out[x] = rgba(c);
        }
    }
}

/// The compositing buffers: the top layer's color per pixel and, when
/// blending, its layer id and the color and id of the layer beneath it.
struct Paint<'a> {
    top: &'a mut [u16; W],
    top_l: &'a mut [u8; W],
    bot: &'a mut [u16; W],
    bot_l: &'a mut [u8; W],
    win: &'a [u8; W],
}

impl Paint<'_> {
    #[inline(always)]
    fn put<const TWO: bool, const WIN: bool>(&mut self, x: usize, c: u16, layer: u8, bit: u8) {
        if WIN && self.win[x] & bit == 0 {
            return;
        }
        if TWO {
            self.bot[x] = self.top[x];
            self.bot_l[x] = self.top_l[x];
            self.top_l[x] = layer;
        }
        self.top[x] = c;
    }
}

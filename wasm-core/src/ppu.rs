// DMG PPU: a port of src/core/ppu.ts.

use crate::{INT_STAT, INT_VBLANK};

pub const W: usize = 160;
pub const H: usize = 144;

pub struct Ppu {
    pub vram: [u8; 0x2000],
    pub oam: [u8; 0xa0],
    pub frame: [u8; W * H],
    pub frame_ready: bool,
    pub frame_count: u32,
    lcdc: u8,
    stat: u8,
    scy: u8,
    scx: u8,
    ly: i32,
    lyc: i32,
    bgp: u8,
    obp0: u8,
    obp1: u8,
    wy: i32,
    wx: i32,
    mode: u8,
    dot: i32,
    mode3_len: i32,
    stat_line: bool,
    window_line: i32,
    wy_triggered: bool,
    bg_idx: [u8; W],
    sprite_buf: [u8; 10],
}

impl Ppu {
    pub fn new() -> Self {
        Ppu {
            vram: [0; 0x2000],
            oam: [0; 0xa0],
            frame: [0; W * H],
            frame_ready: false,
            frame_count: 0,
            lcdc: 0x91,
            stat: 0x85,
            scy: 0,
            scx: 0,
            ly: 0,
            lyc: 0,
            bgp: 0xfc,
            obp0: 0xff,
            obp1: 0xff,
            wy: 0,
            wx: 0,
            mode: 2,
            dot: 0,
            mode3_len: 172,
            stat_line: false,
            window_line: 0,
            wy_triggered: false,
            bg_idx: [0; W],
            sprite_buf: [0; 10],
        }
    }

    #[inline(always)]
    fn lcd_on(&self) -> bool {
        self.lcdc & 0x80 != 0
    }

    fn ly_value(&self) -> i32 {
        if self.ly == 153 && self.dot >= 4 { 0 } else { self.ly }
    }

    #[inline(always)]
    pub fn tick(&mut self, iflag: &mut u8) {
        if self.lcdc & 0x80 == 0 {
            return;
        }
        self.dot += 4;
        let d = self.dot;
        let mut changed = false;
        if self.ly < 144 {
            if self.mode == 2 {
                if d >= 80 {
                    self.mode = 3;
                    self.render_line();
                    changed = true;
                }
            } else if self.mode == 3 && d >= 80 + self.mode3_len {
                self.mode = 0;
                changed = true;
            }
            if d >= 456 {
                self.dot -= 456;
                self.ly += 1;
                changed = true;
                if self.ly == 144 {
                    self.mode = 1;
                    *iflag |= INT_VBLANK;
                    self.frame_ready = true;
                    self.frame_count = self.frame_count.wrapping_add(1);
                } else {
                    self.start_line();
                }
            }
        } else if d >= 456 {
            self.dot -= 456;
            self.ly += 1;
            changed = true;
            if self.ly > 153 {
                self.ly = 0;
                self.window_line = 0;
                self.wy_triggered = false;
                self.start_line();
            }
        } else if d == 4 && (self.ly == 144 || self.ly == 153) {
            changed = true;
        }
        if changed {
            self.update_stat(iflag);
        }
    }

    fn start_line(&mut self) {
        self.mode = 2;
        if self.ly == self.wy {
            self.wy_triggered = true;
        }
    }

    fn update_stat(&mut self, iflag: &mut u8) {
        let coincide = self.ly_value() == self.lyc;
        let s = self.stat;
        let line = (coincide && s & 0x40 != 0)
            || (self.mode == 0 && s & 0x08 != 0)
            || (self.mode == 1 && s & 0x10 != 0)
            || (self.mode == 2 && s & 0x20 != 0)
            || (self.mode == 1 && self.ly == 144 && self.dot < 4 && s & 0x20 != 0);
        if line && !self.stat_line {
            *iflag |= INT_STAT;
        }
        self.stat_line = line;
    }

    pub fn read(&self, addr: u16) -> u8 {
        match addr {
            0xff40 => self.lcdc,
            0xff41 => {
                if !self.lcd_on() {
                    return 0x80 | (self.stat & 0x78);
                }
                let coincide = if self.ly_value() == self.lyc { 4 } else { 0 };
                let mut mode = self.mode;
                if mode == 0 && self.ly < 144 && self.dot < 84 + self.mode3_len {
                    mode = 3;
                } else if mode == 3 && self.dot < 84 {
                    mode = 2;
                }
                0x80 | (self.stat & 0x78) | coincide | mode
            }
            0xff42 => self.scy,
            0xff43 => self.scx,
            0xff44 => {
                if self.lcd_on() { self.ly_value() as u8 } else { 0 }
            }
            0xff45 => self.lyc as u8,
            0xff47 => self.bgp,
            0xff48 => self.obp0,
            0xff49 => self.obp1,
            0xff4a => self.wy as u8,
            0xff4b => self.wx as u8,
            _ => 0xff,
        }
    }

    pub fn write(&mut self, addr: u16, val: u8, iflag: &mut u8) {
        match addr {
            0xff40 => {
                let was_on = self.lcd_on();
                self.lcdc = val;
                if was_on && !self.lcd_on() {
                    self.ly = 0;
                    self.dot = 0;
                    self.mode = 0;
                    self.window_line = 0;
                    self.wy_triggered = false;
                    self.frame.fill(0);
                } else if !was_on && self.lcd_on() {
                    self.ly = 0;
                    self.dot = 4;
                    self.start_line();
                    self.update_stat(iflag);
                }
            }
            0xff41 => {
                self.stat = (self.stat & 0x87) | (val & 0x78);
                if self.lcd_on() {
                    self.update_stat(iflag);
                }
            }
            0xff42 => self.scy = val,
            0xff43 => self.scx = val,
            0xff45 => {
                self.lyc = val as i32;
                if self.lcd_on() {
                    self.update_stat(iflag);
                }
            }
            0xff47 => self.bgp = val,
            0xff48 => self.obp0 = val,
            0xff49 => self.obp1 = val,
            0xff4a => self.wy = val as i32,
            0xff4b => self.wx = val as i32,
            _ => {}
        }
    }

    #[inline(always)]
    fn tile_addr(unsigned_tiles: bool, tile: u8) -> usize {
        if unsigned_tiles {
            (tile as usize) << 4
        } else {
            (0x1000 + ((tile as i8 as i32) << 4)) as usize
        }
    }

    fn render_line(&mut self) {
        let ly = self.ly;
        let lcdc = self.lcdc;
        let row_base = ly as usize * W;
        let bgp = self.bgp;
        let unsigned_tiles = lcdc & 0x10 != 0;

        if lcdc & 0x01 != 0 {
            let bg_map = if lcdc & 0x08 != 0 { 0x1c00 } else { 0x1800 };
            let y = ((ly + self.scy as i32) & 0xff) as usize;
            let tile_row = (y >> 3) << 5;
            let fine_y = (y & 7) << 1;
            let win_on = lcdc & 0x20 != 0 && self.wy_triggered && self.wx <= 166;
            let win_x = self.wx - 7;
            let bg_end = if win_on { win_x.clamp(0, W as i32) as usize } else { W };
            let scx = self.scx as usize;
            let mut x = 0usize;
            while x < bg_end {
                let px = (x + scx) & 0xff;
                let tile = self.vram[bg_map + tile_row + (px >> 3)];
                let addr = Self::tile_addr(unsigned_tiles, tile);
                let lo = self.vram[addr + fine_y];
                let hi = self.vram[addr + fine_y + 1];
                let bit = 7 - (px & 7);
                let c = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
                self.bg_idx[x] = c;
                self.frame[row_base + x] = (bgp >> (c << 1)) & 3;
                x += 1;
            }
            if win_on && x < W {
                let win_map = if lcdc & 0x40 != 0 { 0x1c00 } else { 0x1800 };
                let wy = self.window_line as usize;
                let w_row = (wy >> 3) << 5;
                let w_fine = (wy & 7) << 1;
                while x < W {
                    let px = (x as i32 - win_x) as usize;
                    let tile = self.vram[win_map + w_row + (px >> 3)];
                    let addr = Self::tile_addr(unsigned_tiles, tile);
                    let lo = self.vram[addr + w_fine];
                    let hi = self.vram[addr + w_fine + 1];
                    let bit = 7 - (px & 7);
                    let c = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
                    self.bg_idx[x] = c;
                    self.frame[row_base + x] = (bgp >> (c << 1)) & 3;
                    x += 1;
                }
                self.window_line += 1;
            }
        } else {
            self.bg_idx.fill(0);
            self.frame[row_base..row_base + W].fill(0);
        }

        // Sprites
        let mut count = 0usize;
        let height: i32 = if lcdc & 0x04 != 0 { 16 } else { 8 };
        let mut i = 0usize;
        while i < 40 && count < 10 {
            let sy = self.oam[i << 2] as i32 - 16;
            if ly >= sy && ly < sy + height {
                self.sprite_buf[count] = i as u8;
                count += 1;
            }
            i += 1;
        }
        self.mode3_len = 172 + (self.scx & 7) as i32 + count as i32 * 6;
        if lcdc & 0x02 == 0 || count == 0 {
            return;
        }

        let oam = &self.oam;
        let buf = &mut self.sprite_buf;
        for i in 1..count {
            let v = buf[i];
            let vx = oam[((v as usize) << 2) + 1];
            let mut j = i as isize - 1;
            while j >= 0 && oam[((buf[j as usize] as usize) << 2) + 1] > vx {
                buf[(j + 1) as usize] = buf[j as usize];
                j -= 1;
            }
            buf[(j + 1) as usize] = v;
        }

        for n in (0..count).rev() {
            let o = (self.sprite_buf[n] as usize) << 2;
            let sy = self.oam[o] as i32 - 16;
            let sx = self.oam[o + 1] as i32 - 8;
            let mut tile = self.oam[o + 2] as usize;
            let attr = self.oam[o + 3];
            let mut row = ly - sy;
            if attr & 0x40 != 0 {
                row = height - 1 - row;
            }
            if height == 16 {
                tile &= 0xfe;
            }
            let addr = (tile << 4) + ((row as usize) << 1);
            let lo = self.vram[addr];
            let hi = self.vram[addr + 1];
            let pal = if attr & 0x10 != 0 { self.obp1 } else { self.obp0 };
            let behind = attr & 0x80 != 0;
            let flip_x = attr & 0x20 != 0;
            for p in 0..8i32 {
                let x = sx + p;
                if x < 0 || x >= W as i32 {
                    continue;
                }
                let x = x as usize;
                let bit = if flip_x { p } else { 7 - p };
                let c = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
                if c == 0 {
                    continue;
                }
                if behind && (self.bg_idx[x] & 3) != 0 {
                    self.frame[row_base + x] = (self.bgp >> ((self.bg_idx[x] & 3) << 1)) & 3;
                    continue;
                }
                self.frame[row_base + x] = (pal >> (c << 1)) & 3;
            }
        }
    }
}

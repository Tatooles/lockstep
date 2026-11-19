// Memory bus: address decoding, IO registers, OAM DMA, joypad and serial.

use crate::apu::Apu;
use crate::cart::Cart;
use crate::ppu::Ppu;
use crate::state::State;
use crate::timer::Timer;
use crate::{INT_JOYPAD, INT_SERIAL};

pub struct Bus {
    pub wram: [u8; 0x2000],
    pub hram: [u8; 0x7f],
    pub ie: u8,
    pub iflag: u8,
    pub cart: Cart,
    pub ppu: Ppu,
    pub apu: Apu,
    pub timer: Timer,
    pub mcycles: u64,
    p1_select: u8,
    pub pressed: u8,
    sb: u8,
    sc: u8,
    serial_cycles: u32,
    dma_reg: u8,
    dma_active: bool,
    dma_src: usize,
    dma_index: usize,
    dma_delay: u8,
}

impl Bus {
    pub fn new(cart: Cart) -> Self {
        Bus {
            wram: [0; 0x2000],
            hram: [0; 0x7f],
            ie: 0,
            iflag: 0xe1,
            cart,
            ppu: Ppu::new(),
            apu: Apu::new(),
            timer: Timer::new(),
            mcycles: 0,
            p1_select: 0x30,
            pressed: 0,
            sb: 0,
            sc: 0x7e,
            serial_cycles: 0,
            dma_reg: 0xff,
            dma_active: false,
            dma_src: 0,
            dma_index: 0,
            dma_delay: 0,
        }
    }

    pub fn save(&self, s: &mut State) {
        s.put(self.ie as f64);
        s.put(self.iflag as f64);
        s.put(self.p1_select as f64);
        s.put(self.sb as f64);
        s.put(self.sc as f64);
        s.put(self.serial_cycles as f64);
        s.put(self.dma_reg as f64);
        s.flag(self.dma_active);
        s.put(self.dma_src as f64);
        s.put(self.dma_index as f64);
        s.put(self.dma_delay as f64);
        s.put(self.mcycles as f64);
    }

    pub fn load(&mut self, s: &mut State) {
        self.ie = s.get() as u8;
        self.iflag = s.get() as u8;
        self.p1_select = s.get() as u8;
        self.sb = s.get() as u8;
        self.sc = s.get() as u8;
        self.serial_cycles = s.get() as u32;
        self.dma_reg = s.get() as u8;
        self.dma_active = s.is();
        self.dma_src = s.get() as usize;
        self.dma_index = s.get() as usize;
        self.dma_delay = s.get() as u8;
        self.mcycles = s.get() as u64;
    }

    /// Advance every component by one M-cycle.
    #[inline(always)]
    pub fn tick(&mut self) {
        self.mcycles += 1;
        self.timer.tick(&mut self.iflag);
        self.ppu.tick(&mut self.iflag);
        self.apu.tick();
        if self.dma_active || self.dma_delay != 0 {
            self.step_dma();
        }
        if self.serial_cycles > 0 {
            self.serial_cycles -= 1;
            if self.serial_cycles == 0 {
                self.sb = 0xff;
                self.sc &= 0x7f;
                self.iflag |= INT_SERIAL;
            }
        }
    }

    #[inline(never)]
    fn step_dma(&mut self) {
        if self.dma_delay > 0 {
            self.dma_delay -= 1;
            if self.dma_delay > 0 {
                return;
            }
            self.dma_active = true;
            self.dma_index = 0;
        } else if self.dma_index >= 0xa0 {
            self.dma_active = false;
            return;
        }
        let v = self.read_dma_source(self.dma_src + self.dma_index);
        self.ppu.oam[self.dma_index] = v;
        self.dma_index += 1;
    }

    fn read_dma_source(&self, addr: usize) -> u8 {
        if addr < 0x8000 {
            self.cart.read_rom(addr as u16)
        } else if addr < 0xa000 {
            self.ppu.vram[addr - 0x8000]
        } else if addr < 0xc000 {
            self.cart.read_ram(addr as u16)
        } else {
            self.wram[(addr - 0xc000) & 0x1fff]
        }
    }

    pub fn set_button(&mut self, id: u32, down: bool) {
        let bit = 1u8 << id;
        if down {
            if self.pressed & bit == 0 {
                self.iflag |= INT_JOYPAD;
            }
            self.pressed |= bit;
        } else {
            self.pressed &= !bit;
        }
    }

    fn read_p1(&self) -> u8 {
        let mut low = 0x0f;
        if self.p1_select & 0x10 == 0 {
            low &= !(self.pressed & 0x0f);
        }
        if self.p1_select & 0x20 == 0 {
            low &= !((self.pressed >> 4) & 0x0f);
        }
        0xc0 | self.p1_select | low
    }

    #[inline(always)]
    pub fn read(&self, addr: u16) -> u8 {
        let a = addr as usize;
        if addr < 0x8000 {
            self.cart.read_rom(addr)
        } else if addr < 0xa000 {
            self.ppu.vram[a - 0x8000]
        } else if addr < 0xc000 {
            self.cart.read_ram(addr)
        } else if addr < 0xfe00 {
            self.wram[(a - 0xc000) & 0x1fff]
        } else if addr < 0xfea0 {
            if self.dma_active { 0xff } else { self.ppu.oam[a - 0xfe00] }
        } else if addr < 0xff00 {
            0
        } else if addr >= 0xff80 {
            if addr == 0xffff { self.ie } else { self.hram[a - 0xff80] }
        } else {
            self.read_io(addr)
        }
    }

    fn read_io(&self, addr: u16) -> u8 {
        match addr {
            0xff00 => self.read_p1(),
            0xff01 => self.sb,
            0xff02 => self.sc | 0x7e,
            0xff04..=0xff07 => self.timer.read(addr),
            0xff0f => self.iflag | 0xe0,
            0xff10..=0xff3f => self.apu.read(addr),
            0xff46 => self.dma_reg,
            0xff40..=0xff4b => self.ppu.read(addr),
            _ => 0xff,
        }
    }

    #[inline(always)]
    pub fn write(&mut self, addr: u16, val: u8) {
        let a = addr as usize;
        if addr < 0x8000 {
            self.cart.write_rom(addr, val);
        } else if addr < 0xa000 {
            self.ppu.vram[a - 0x8000] = val;
        } else if addr < 0xc000 {
            self.cart.write_ram(addr, val);
        } else if addr < 0xfe00 {
            self.wram[(a - 0xc000) & 0x1fff] = val;
        } else if addr < 0xfea0 {
            if !self.dma_active {
                self.ppu.oam[a - 0xfe00] = val;
            }
        } else if addr < 0xff00 {
            // unusable
        } else if addr >= 0xff80 {
            if addr == 0xffff {
                self.ie = val;
            } else {
                self.hram[a - 0xff80] = val;
            }
        } else {
            self.write_io(addr, val);
        }
    }

    fn write_io(&mut self, addr: u16, val: u8) {
        match addr {
            0xff00 => self.p1_select = val & 0x30,
            0xff01 => self.sb = val,
            0xff02 => {
                self.sc = val | 0x7e;
                if val & 0x81 == 0x81 {
                    crate::serial(self.sb);
                    self.serial_cycles = 1024;
                }
            }
            0xff04..=0xff07 => self.timer.write(addr, val),
            0xff0f => self.iflag = val | 0xe0,
            0xff10..=0xff3f => self.apu.write(addr, val),
            0xff46 => {
                self.dma_reg = val;
                self.dma_src = (val as usize) << 8;
                if self.dma_src >= 0xe000 {
                    self.dma_src -= 0x2000;
                }
                self.dma_delay = 2;
            }
            0xff40..=0xff4b => self.ppu.write(addr, val, &mut self.iflag),
            _ => {}
        }
    }
}

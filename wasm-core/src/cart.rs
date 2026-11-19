// Cartridge + MBC1/2/3/5: a port of src/core/cart.ts.

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mbc {
    None,
    Mbc1,
    Mbc2,
    Mbc3,
    Mbc5,
}

const RAM_SIZES: [usize; 6] = [0, 0x800, 0x2000, 0x8000, 0x20000, 0x10000];

pub struct Cart {
    rom: Box<[u8]>,
    pub ram: Vec<u8>,
    pub ram_dirty: bool,
    mbc: Mbc,
    rom_mask: usize,
    ram_enabled: bool,
    rom_bank: usize,
    bank2: usize,
    mode: u8,
    rom_bank0_offset: usize,
    rom_bank_offset: usize,
    ram_offset: usize,
    rtc_latched: [u8; 5],
    rtc_latch_prev: u8,
    rtc_base: f64,
    rtc_halted_at: f64,
    rtc_halted: bool,
    rtc_carry: bool,
}

impl Cart {
    pub fn new(rom: &[u8]) -> Self {
        let ct = rom[0x147];
        let mbc = match ct {
            0x01..=0x03 => Mbc::Mbc1,
            0x05 | 0x06 => Mbc::Mbc2,
            0x0f..=0x13 => Mbc::Mbc3,
            0x19..=0x1e => Mbc::Mbc5,
            _ => Mbc::None,
        };
        let mut ram_size = RAM_SIZES.get(rom[0x149] as usize).copied().unwrap_or(0);
        if mbc == Mbc::Mbc2 {
            ram_size = 512;
        }
        let mut banks = 2usize;
        while banks * 0x4000 < rom.len() {
            banks *= 2;
        }
        let mut padded = vec![0xffu8; banks * 0x4000];
        padded[..rom.len()].copy_from_slice(rom);
        let mut c = Cart {
            rom: padded.into_boxed_slice(),
            ram: vec![0; ram_size],
            ram_dirty: false,
            mbc,
            rom_mask: banks - 1,
            ram_enabled: false,
            rom_bank: 1,
            bank2: 0,
            mode: 0,
            rom_bank0_offset: 0,
            rom_bank_offset: 0x4000,
            ram_offset: 0,
            rtc_latched: [0; 5],
            rtc_latch_prev: 0xff,
            rtc_base: crate::now(),
            rtc_halted_at: 0.0,
            rtc_halted: false,
            rtc_carry: false,
        };
        c.update_offsets();
        c
    }

    fn update_offsets(&mut self) {
        match self.mbc {
            Mbc::Mbc1 => {
                let bank = ((self.bank2 << 5) | self.rom_bank) & self.rom_mask;
                self.rom_bank_offset = bank * 0x4000;
                self.rom_bank0_offset =
                    if self.mode == 1 { ((self.bank2 << 5) & self.rom_mask) * 0x4000 } else { 0 };
                self.ram_offset =
                    if self.mode == 1 && self.ram.len() > 0x2000 { (self.bank2 & 3) * 0x2000 } else { 0 };
            }
            Mbc::Mbc2 => self.rom_bank_offset = (self.rom_bank & self.rom_mask) * 0x4000,
            Mbc::Mbc3 => {
                self.rom_bank_offset = (self.rom_bank & self.rom_mask) * 0x4000;
                self.ram_offset = (self.bank2 & 3) * 0x2000;
            }
            Mbc::Mbc5 => {
                self.rom_bank_offset = (self.rom_bank & self.rom_mask) * 0x4000;
                self.ram_offset = (self.bank2 & 0xf) * 0x2000;
            }
            Mbc::None => self.rom_bank_offset = 0x4000,
        }
        if !self.ram.is_empty() && self.ram_offset >= self.ram.len() {
            self.ram_offset %= self.ram.len();
        }
    }

    #[inline(always)]
    pub fn read_rom(&self, addr: u16) -> u8 {
        let a = addr as usize;
        if a < 0x4000 {
            self.rom[self.rom_bank0_offset + a]
        } else {
            self.rom[self.rom_bank_offset + (a - 0x4000)]
        }
    }

    pub fn write_rom(&mut self, addr: u16, val: u8) {
        let v = val as usize;
        match self.mbc {
            Mbc::Mbc1 => {
                if addr < 0x2000 {
                    self.ram_enabled = val & 0x0f == 0x0a;
                } else if addr < 0x4000 {
                    self.rom_bank = v & 0x1f;
                    if self.rom_bank == 0 {
                        self.rom_bank = 1;
                    }
                } else if addr < 0x6000 {
                    self.bank2 = v & 3;
                } else {
                    self.mode = val & 1;
                }
            }
            Mbc::Mbc2 => {
                if addr < 0x4000 {
                    if addr & 0x100 != 0 {
                        self.rom_bank = v & 0x0f;
                        if self.rom_bank == 0 {
                            self.rom_bank = 1;
                        }
                    } else {
                        self.ram_enabled = val & 0x0f == 0x0a;
                    }
                }
            }
            Mbc::Mbc3 => {
                if addr < 0x2000 {
                    self.ram_enabled = val & 0x0f == 0x0a;
                } else if addr < 0x4000 {
                    self.rom_bank = v & 0x7f;
                    if self.rom_bank == 0 {
                        self.rom_bank = 1;
                    }
                } else if addr < 0x6000 {
                    self.bank2 = v & 0x0f;
                } else {
                    if self.rtc_latch_prev == 0 && val == 1 {
                        self.latch_rtc();
                    }
                    self.rtc_latch_prev = val;
                }
            }
            Mbc::Mbc5 => {
                if addr < 0x2000 {
                    self.ram_enabled = val & 0x0f == 0x0a;
                } else if addr < 0x3000 {
                    self.rom_bank = (self.rom_bank & 0x100) | v;
                } else if addr < 0x4000 {
                    self.rom_bank = (self.rom_bank & 0xff) | ((v & 1) << 8);
                } else if addr < 0x6000 {
                    self.bank2 = v & 0x0f;
                }
            }
            Mbc::None => {}
        }
        self.update_offsets();
    }

    pub fn read_ram(&self, addr: u16) -> u8 {
        if !self.ram_enabled {
            return 0xff;
        }
        let off = addr as usize - 0xa000;
        if self.mbc == Mbc::Mbc2 {
            return (self.ram[off & 0x1ff] & 0x0f) | 0xf0;
        }
        if self.mbc == Mbc::Mbc3 && (0x08..=0x0c).contains(&self.bank2) {
            return self.rtc_latched[self.bank2 - 0x08];
        }
        if self.ram.is_empty() {
            return 0xff;
        }
        self.ram[(self.ram_offset + off) % self.ram.len()]
    }

    pub fn write_ram(&mut self, addr: u16, val: u8) {
        if !self.ram_enabled {
            return;
        }
        let off = addr as usize - 0xa000;
        if self.mbc == Mbc::Mbc2 {
            self.ram[off & 0x1ff] = val & 0x0f;
            self.ram_dirty = true;
            return;
        }
        if self.mbc == Mbc::Mbc3 && (0x08..=0x0c).contains(&self.bank2) {
            self.write_rtc(self.bank2 - 0x08, val);
            return;
        }
        if self.ram.is_empty() {
            return;
        }
        let n = self.ram.len();
        self.ram[(self.ram_offset + off) % n] = val;
        self.ram_dirty = true;
    }

    fn rtc_seconds(&self) -> f64 {
        let now = if self.rtc_halted { self.rtc_halted_at } else { crate::now() };
        ((now - self.rtc_base) / 1000.0).floor().max(0.0)
    }

    fn latch_rtc(&mut self) {
        let mut s = self.rtc_seconds();
        let mut days = (s / 86400.0).floor();
        s %= 86400.0;
        if days > 511.0 {
            self.rtc_carry = true;
            days %= 512.0;
        }
        let d = days as u32;
        self.rtc_latched = [
            (s % 60.0) as u8,
            ((s / 60.0).floor() % 60.0) as u8,
            (s / 3600.0).floor() as u8,
            (d & 0xff) as u8,
            (((d >> 8) & 1) as u8) | if self.rtc_halted { 0x40 } else { 0 } | if self.rtc_carry { 0x80 } else { 0 },
        ];
    }

    fn write_rtc(&mut self, reg: usize, val: u8) {
        self.latch_rtc();
        let mut r = self.rtc_latched;
        r[reg] = val;
        let days = r[3] as f64 + ((r[4] & 1) as f64) * 256.0;
        let total = (((days * 24.0 + (r[2] & 0x1f) as f64) * 60.0 + (r[1] & 0x3f) as f64) * 60.0
            + (r[0] & 0x3f) as f64)
            * 1000.0;
        let now = crate::now();
        self.rtc_base = now - total;
        self.rtc_carry = r[4] & 0x80 != 0;
        self.rtc_halted = r[4] & 0x40 != 0;
        self.rtc_halted_at = now;
        self.rtc_latched = r;
    }
}

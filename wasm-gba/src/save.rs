// Cartridge save memory: SRAM and Flash (64K and 128K). The type is detected
// from the save library's ID string in the ROM, as Nintendo's SDK embeds it.

pub const NONE: u8 = 0;
pub const SRAM: u8 = 1;
pub const FLASH64: u8 = 2;
pub const FLASH128: u8 = 3;
pub const EEPROM: u8 = 4;

pub struct Save {
    pub kind: u8,
    pub dirty: bool,
    pub data: [u8; 0x20000],
    state: u8,
    erase_armed: bool,
    write_next: bool,
    bank_next: bool,
    id_mode: bool,
    bank: u8,
}

fn find(rom: &[u8], needle: &[u8]) -> bool {
    // The SDK's ID strings are word aligned.
    let mut i = 0;
    while i + needle.len() <= rom.len() {
        if rom[i] == needle[0] && &rom[i..i + needle.len()] == needle {
            return true;
        }
        i += 4;
    }
    false
}

impl Save {
    pub fn init(&mut self, rom: &[u8]) {
        self.data.fill(0xFF);
        self.kind = if find(rom, b"FLASH1M_V") {
            FLASH128
        } else if find(rom, b"FLASH_V") || find(rom, b"FLASH512_V") {
            FLASH64
        } else if find(rom, b"SRAM_V") || find(rom, b"SRAM_F_V") {
            SRAM
        } else if find(rom, b"EEPROM_V") {
            EEPROM
        } else {
            NONE
        };
    }

    pub fn len(&self) -> usize {
        match self.kind {
            SRAM => 0x8000,
            FLASH64 => 0x10000,
            FLASH128 => 0x20000,
            _ => 0,
        }
    }

    pub fn read(&self, addr: u32) -> u8 {
        let a = (addr & 0xFFFF) as usize;
        match self.kind {
            SRAM => self.data[a & 0x7FFF],
            FLASH64 | FLASH128 => {
                if self.id_mode && a < 2 {
                    // Macronix MX29L010 (128K) / SST 39VF512 (64K)
                    let id: [u8; 2] = if self.kind == FLASH128 { [0xC2, 0x09] } else { [0xBF, 0xD4] };
                    id[a]
                } else {
                    self.data[self.bank as usize * 0x10000 + a]
                }
            }
            _ => 0xFF,
        }
    }

    pub fn write(&mut self, addr: u32, v: u8) {
        let a = (addr & 0xFFFF) as usize;
        match self.kind {
            SRAM => {
                self.data[a & 0x7FFF] = v;
                self.dirty = true;
            }
            FLASH64 | FLASH128 => self.flash_write(a, v),
            _ => {}
        }
    }

    fn flash_write(&mut self, a: usize, v: u8) {
        if self.write_next {
            self.write_next = false;
            self.data[self.bank as usize * 0x10000 + a] &= v;
            self.dirty = true;
            return;
        }
        if self.bank_next {
            self.bank_next = false;
            if a == 0 && self.kind == FLASH128 {
                self.bank = v & 1;
            }
            return;
        }
        match self.state {
            0 => {
                if a == 0x5555 && v == 0xAA {
                    self.state = 1;
                }
            }
            1 => self.state = if a == 0x2AAA && v == 0x55 { 2 } else { 0 },
            _ => {
                self.state = 0;
                if self.erase_armed {
                    self.erase_armed = false;
                    if a == 0x5555 && v == 0x10 {
                        let n = self.len();
                        self.data[..n].fill(0xFF);
                        self.dirty = true;
                    } else if v == 0x30 {
                        let base = self.bank as usize * 0x10000 + (a & 0xF000);
                        self.data[base..base + 0x1000].fill(0xFF);
                        self.dirty = true;
                    }
                    return;
                }
                if a != 0x5555 {
                    return;
                }
                match v {
                    0x90 => self.id_mode = true,
                    0xF0 => self.id_mode = false,
                    0x80 => self.erase_armed = true,
                    0xA0 => self.write_next = true,
                    0xB0 => self.bank_next = true,
                    _ => {}
                }
            }
        }
    }
}

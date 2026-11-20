// Seiko S-3511A real-time clock on the cartridge's GPIO port (0x080000C4..C9),
// as used by Pokémon Ruby, Sapphire and Emerald. Serial protocol: CS high,
// then a command byte (sent MSB first) and data bytes (LSB first), bits
// clocked on SCK rising edges.

const BYTES: [u8; 8] = [0, 0, 7, 0, 1, 0, 3, 0];
const CMD_RESET: u8 = 0;
const CMD_DATETIME: u8 = 2;
const CMD_CONTROL: u8 = 4;
const CMD_TIME: u8 = 6;

pub struct Rtc {
    pub readable: bool,
    pins: u8,
    dir: u8,
    active: bool,
    have_cmd: bool,
    cmd: u8,
    reading: bool,
    bits: u8,
    nbits: u8,
    remaining: u8,
    idx: u8,
    buf: [u8; 7],
    out: u8,
    control: u8,
    /// Seconds since the Unix epoch, local time, set by the host.
    pub unix: f64,
}

fn bcd(v: u32) -> u8 {
    (((v / 10) << 4) | (v % 10)) as u8
}

impl Rtc {
    pub fn init(&mut self, _rom: &[u8]) {
        self.control = 0x40;
        // 2026-01-01 12:00 until the host sets the real time.
        self.unix = 1_767_268_800.0;
    }

    pub fn read(&self, off: u32) -> u16 {
        match off {
            0xC4 => {
                let mut v = self.pins & self.dir;
                if self.dir & 2 == 0 {
                    v |= self.out << 1;
                }
                v as u16
            }
            0xC6 => self.dir as u16,
            _ => self.readable as u16,
        }
    }

    pub fn write(&mut self, off: u32, v: u16) {
        match off {
            0xC4 => self.write_pins((v & 0xF) as u8),
            0xC6 => self.dir = (v & 0xF) as u8,
            _ => self.readable = v & 1 != 0,
        }
    }

    fn write_pins(&mut self, v: u8) {
        let old = self.pins;
        self.pins = (self.pins & !self.dir) | (v & self.dir);
        let cs = self.pins & 4 != 0;
        if !cs {
            self.active = false;
            return;
        }
        if old & 4 == 0 {
            // New transfer.
            self.active = true;
            self.have_cmd = false;
            self.bits = 0;
            self.nbits = 0;
            self.reading = false;
        }
        if !self.active || old & 1 != 0 || self.pins & 1 == 0 {
            return;
        }
        // SCK rising edge.
        if self.reading {
            if self.remaining == 0 {
                self.out = 0;
                return;
            }
            self.out = (self.buf[self.idx as usize] >> self.nbits) & 1;
            self.nbits += 1;
            if self.nbits == 8 {
                self.nbits = 0;
                self.idx += 1;
                self.remaining -= 1;
            }
        } else {
            self.bits |= ((self.pins >> 1) & 1) << self.nbits;
            self.nbits += 1;
            if self.nbits == 8 {
                let b = self.bits;
                self.bits = 0;
                self.nbits = 0;
                self.byte(b);
            }
        }
    }

    fn byte(&mut self, b: u8) {
        if !self.have_cmd {
            if b & 0xF != 6 {
                return;
            }
            self.have_cmd = true;
            self.cmd = (b >> 4) & 7;
            self.reading = b & 0x80 != 0;
            self.remaining = BYTES[self.cmd as usize];
            self.idx = 0;
            match self.cmd {
                CMD_RESET => self.control = 0,
                CMD_DATETIME | CMD_TIME if self.reading => self.fill_time(),
                CMD_CONTROL if self.reading => self.buf[0] = self.control,
                _ => {}
            }
            return;
        }
        if self.remaining > 0 {
            if self.cmd == CMD_CONTROL {
                self.control = b;
            }
            self.remaining -= 1;
        }
    }

    fn fill_time(&mut self) {
        let secs = self.unix.max(0.0) as u64;
        let days = (secs / 86400) as i64;
        let tod = secs % 86400;
        let (y, m, d) = civil_from_days(days);
        let weekday = ((days + 4) % 7) as u32; // 1970-01-01 was a Thursday
        let h = (tod / 3600) as u32;
        let hour = if self.control & 0x40 != 0 { bcd(h) } else { bcd(h % 12) | if h >= 12 { 0x80 } else { 0 } };
        let t = [bcd((y % 100) as u32), bcd(m), bcd(d), bcd(weekday), hour, bcd((tod / 60 % 60) as u32), bcd((tod % 60) as u32)];
        if self.cmd == CMD_TIME {
            self.buf[..3].copy_from_slice(&t[4..]);
        } else {
            self.buf = t;
        }
    }
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// Sound, minimal for the spike: register storage, the two Direct Sound FIFOs
// (fed by DMA1/2 on timer overflow, which is how Pokémon's m4a engine plays
// everything) and a 32768 Hz stereo mix of them. The four PSG channels are not
// synthesised yet; their registers are stored so games read back what they wrote.

pub const SAMPLE_RATE: u64 = 32768;
pub const AUDIO_LEN: usize = 16384;

pub struct Apu {
    regs: [u16; 0x28],
    fifo: [[i8; 32]; 2],
    fifo_r: [u8; 2],
    fifo_len: [u8; 2],
    cur: [i8; 2],
    pub output: bool,
    pub buffer: [f32; AUDIO_LEN],
    pub write_pos: u32,
    pub read_pos: u32,
}

impl Apu {
    pub fn init(&mut self) {
        self.output = false;
    }

    pub fn sample_period(&self) -> u64 {
        16_777_216 / SAMPLE_RATE
    }

    pub fn read16(&self, a: u32) -> u16 {
        if (0xA0..0xA8).contains(&a) {
            return 0;
        }
        self.regs[((a - 0x60) >> 1) as usize & 0x27]
    }

    pub fn write16(&mut self, a: u32, v: u16) {
        let i = ((a - 0x60) >> 1) as usize & 0x27;
        if a == 0x82 {
            if v & 0x0800 != 0 {
                self.fifo_len[0] = 0;
            }
            if v & 0x8000 != 0 {
                self.fifo_len[1] = 0;
            }
            self.regs[i] = v & 0x770F;
            return;
        }
        self.regs[i] = v;
    }

    pub fn fifo_write8(&mut self, a: u32, v: u8) {
        let f = ((a - 0xA0) >> 2) as usize & 1;
        if self.fifo_len[f] < 32 {
            let w = (self.fifo_r[f] + self.fifo_len[f]) & 31;
            self.fifo[f][w as usize] = v as i8;
            self.fifo_len[f] += 1;
        }
    }

    /// Timer `t` overflowed: each FIFO clocked by it plays its next sample.
    /// Returns a bit per FIFO that wants a DMA refill.
    pub fn timer_overflow(&mut self, t: usize, _now: u64) -> u8 {
        let cnt = self.regs[(0x82 - 0x60) >> 1];
        let mut req = 0;
        for f in 0..2 {
            if ((cnt >> (10 + 4 * f)) & 1) as usize != t {
                continue;
            }
            if self.fifo_len[f] > 0 {
                self.cur[f] = self.fifo[f][self.fifo_r[f] as usize];
                self.fifo_r[f] = (self.fifo_r[f] + 1) & 31;
                self.fifo_len[f] -= 1;
            }
            if self.fifo_len[f] <= 16 {
                req |= 1 << f;
            }
        }
        req
    }

    pub fn sample(&mut self, _at: u64) {
        if !self.output {
            return;
        }
        let x = self.regs[(0x84 - 0x60) >> 1];
        let (mut l, mut r) = (0f32, 0f32);
        if x & 0x80 != 0 {
            let cnt = self.regs[(0x82 - 0x60) >> 1];
            for f in 0..2 {
                let full = cnt & (4 << f) != 0;
                let s = self.cur[f] as f32 / 128.0 * if full { 1.0 } else { 0.5 };
                if cnt & (0x100 << (4 * f)) != 0 {
                    r += s;
                }
                if cnt & (0x200 << (4 * f)) != 0 {
                    l += s;
                }
            }
        }
        let w = self.write_pos as usize;
        self.buffer[w] = l * 0.5;
        self.buffer[w + 1] = r * 0.5;
        self.write_pos = ((w + 2) % AUDIO_LEN) as u32;
    }
}

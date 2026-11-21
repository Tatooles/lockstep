// Sound: the four Game Boy-style PSG channels plus the two Direct Sound FIFOs
// (fed by DMA1/2 on timer overflow, which is how Pokémon's m4a engine plays
// samples), mixed to 32768 Hz stereo. Channels are advanced once per output
// sample; the frame sequencer (length, envelope, sweep) runs at 512 Hz.

pub const SAMPLE_RATE: u64 = 32768;
pub const AUDIO_LEN: usize = 16384;
const CYCLES_PER_SAMPLE: i32 = (16_777_216 / SAMPLE_RATE) as i32;
const SEQ_PERIOD: i32 = 16_777_216 / 512;

const DUTY: [u8; 4] = [0b0000_0001, 0b1000_0001, 0b1000_0111, 0b0111_1110];

#[derive(Clone, Copy)]
struct Env {
    init: u8,
    up: bool,
    period: u8,
    vol: u8,
    timer: u8,
}

impl Env {
    fn write(&mut self, v: u16) {
        self.period = ((v >> 8) & 7) as u8;
        self.up = v & 0x800 != 0;
        self.init = (v >> 12) as u8;
    }
    fn trigger(&mut self) {
        self.vol = self.init;
        self.timer = self.period;
    }
    fn clock(&mut self) {
        if self.period == 0 {
            return;
        }
        self.timer = self.timer.saturating_sub(1);
        if self.timer == 0 {
            self.timer = self.period;
            if self.up && self.vol < 15 {
                self.vol += 1;
            } else if !self.up && self.vol > 0 {
                self.vol -= 1;
            }
        }
    }
    fn dac(&self) -> bool {
        self.init != 0 || self.up
    }
}

#[derive(Clone, Copy)]
struct Square {
    on: bool,
    duty: u8,
    pos: u8,
    timer: i32,
    freq: u32,
    length: u16,
    length_en: bool,
    env: Env,
    sweep_period: u8,
    sweep_neg: bool,
    sweep_shift: u8,
    sweep_timer: u8,
    shadow: u32,
}

impl Square {
    #[inline(always)]
    fn step(&mut self, t: i32) {
        if !self.on {
            return;
        }
        self.timer -= t;
        while self.timer <= 0 {
            self.timer += (2048 - self.freq as i32) * 16;
            self.pos = (self.pos + 1) & 7;
        }
    }
    fn out(&self) -> i32 {
        if self.on && DUTY[self.duty as usize] >> self.pos & 1 != 0 {
            self.env.vol as i32
        } else {
            0
        }
    }
    fn sweep(&mut self) {
        if self.sweep_period == 0 {
            return;
        }
        self.sweep_timer = self.sweep_timer.saturating_sub(1);
        if self.sweep_timer > 0 {
            return;
        }
        self.sweep_timer = self.sweep_period;
        let d = self.shadow >> self.sweep_shift;
        let f = if self.sweep_neg { self.shadow.wrapping_sub(d) } else { self.shadow + d };
        if f > 2047 {
            self.on = false;
        } else if self.sweep_shift != 0 {
            self.shadow = f;
            self.freq = f;
        }
    }
}

#[derive(Clone, Copy)]
struct Wave {
    on: bool,
    pos: u8,
    timer: i32,
    freq: u32,
    length: u16,
    length_en: bool,
}

#[derive(Clone, Copy)]
struct Noise {
    on: bool,
    lfsr: u16,
    timer: i32,
    length: u16,
    length_en: bool,
    env: Env,
}

pub struct Apu {
    regs: [u16; 0x28],
    /// Last value written to each register, for merging byte writes.
    raw: [u16; 0x28],
    /// Two 32-sample banks of 4-bit samples (16 bytes each).
    wave_ram: [u8; 32],
    sq: [Square; 2],
    wave: Wave,
    noise: Noise,
    seq_timer: i32,
    seq_step: u8,
    fifo: [[i8; 32]; 2],
    fifo_r: [u8; 2],
    fifo_len: [u8; 2],
    cur: [i8; 2],
    pub output: bool,
    pub buffer: [f32; AUDIO_LEN],
    pub write_pos: u32,
    pub read_pos: u32,
}

#[inline(always)]
fn reg_index(a: u32) -> usize {
    // 0x60..=0xAE map to 0..=0x27, one slot per halfword register.
    (((a - 0x60) >> 1) as usize).min(0x27)
}

impl Apu {
    pub fn init(&mut self) {
        self.output = false;
        self.noise.lfsr = 0x7FFF;
        self.seq_timer = SEQ_PERIOD;
    }

    pub fn sample_period(&self) -> u64 {
        CYCLES_PER_SAMPLE as u64
    }

    fn master_on(&self) -> bool {
        self.regs[reg_index(0x84)] & 0x80 != 0
    }

    pub fn read16(&self, a: u32) -> u16 {
        match a {
            0xA0..=0xA6 => 0,
            0x90..=0x9E => {
                // The CPU sees the bank that isn't playing.
                let bank = if self.regs[reg_index(0x70)] & 0x40 != 0 { 0 } else { 16 };
                let i = bank + (a - 0x90) as usize;
                u16::from_le_bytes([self.wave_ram[i], self.wave_ram[i + 1]])
            }
            0x84 => {
                let x = self.regs[reg_index(0x84)] & 0x80;
                x | self.sq[0].on as u16 | (self.sq[1].on as u16) << 1 | (self.wave.on as u16) << 2 | (self.noise.on as u16) << 3
            }
            _ => self.regs[reg_index(a)],
        }
    }

    /// What a byte write should merge with.
    pub fn raw16(&self, a: u32) -> u16 {
        if (0x90..0xA0).contains(&a) {
            self.read16(a)
        } else {
            self.raw[reg_index(a)]
        }
    }

    pub fn write16(&mut self, a: u32, v: u16) {
        if (0x60..0x80).contains(&a) && !self.master_on() {
            return;
        }
        let i = reg_index(a);
        // Trigger bits act on the write itself; a later byte write must not repeat them.
        self.raw[i] = if matches!(a, 0x64 | 0x6C | 0x74 | 0x7C) { v & 0x7FFF } else { v };
        match a {
            0x60 => {
                self.regs[i] = v & 0x7F;
                let s = &mut self.sq[0];
                s.sweep_shift = (v & 7) as u8;
                s.sweep_neg = v & 8 != 0;
                s.sweep_period = ((v >> 4) & 7) as u8;
            }
            0x62 | 0x68 => {
                let s = &mut self.sq[(a == 0x68) as usize];
                s.length = 64 - (v & 0x3F);
                s.duty = ((v >> 6) & 3) as u8;
                s.env.write(v);
                if !s.env.dac() {
                    s.on = false;
                }
                self.regs[i] = v & 0xFFC0;
            }
            0x64 | 0x6C => {
                let s = &mut self.sq[(a == 0x6C) as usize];
                s.freq = (v & 0x7FF) as u32;
                s.length_en = v & 0x4000 != 0;
                if v & 0x8000 != 0 {
                    s.on = s.env.dac();
                    if s.length == 0 {
                        s.length = 64;
                    }
                    s.timer = (2048 - s.freq as i32) * 16;
                    s.env.trigger();
                    s.shadow = s.freq;
                    s.sweep_timer = s.sweep_period;
                }
                self.regs[i] = v & 0x4000;
            }
            0x70 => {
                self.regs[i] = v & 0xE0;
                if v & 0x80 == 0 {
                    self.wave.on = false;
                }
            }
            0x72 => {
                self.wave.length = 256 - (v & 0xFF);
                self.regs[i] = v & 0xE000;
            }
            0x74 => {
                let w = &mut self.wave;
                w.freq = (v & 0x7FF) as u32;
                w.length_en = v & 0x4000 != 0;
                if v & 0x8000 != 0 {
                    w.on = self.regs[reg_index(0x70)] & 0x80 != 0;
                    if w.length == 0 {
                        w.length = 256;
                    }
                    w.pos = 0;
                    w.timer = (2048 - w.freq as i32) * 8;
                }
                self.regs[i] = v & 0x4000;
            }
            0x78 => {
                let n = &mut self.noise;
                n.length = 64 - (v & 0x3F);
                n.env.write(v);
                if !n.env.dac() {
                    n.on = false;
                }
                self.regs[i] = v & 0xFF00;
            }
            0x7C => {
                let n = &mut self.noise;
                n.length_en = v & 0x4000 != 0;
                if v & 0x8000 != 0 {
                    n.on = n.env.dac();
                    if n.length == 0 {
                        n.length = 64;
                    }
                    n.lfsr = if v & 8 != 0 { 0x7F } else { 0x7FFF };
                    n.env.trigger();
                    n.timer = Self::noise_period(v);
                }
                self.regs[i] = v & 0x40FF;
            }
            0x82 => {
                if v & 0x0800 != 0 {
                    self.fifo_len[0] = 0;
                }
                if v & 0x8000 != 0 {
                    self.fifo_len[1] = 0;
                }
                self.regs[i] = v & 0x770F;
            }
            0x84 => {
                if v & 0x80 == 0 {
                    // Master off clears the PSG registers.
                    for r in 0x60..0x82 {
                        if r & 1 == 0 {
                            self.regs[reg_index(r)] = 0;
                        }
                    }
                    self.sq[0].on = false;
                    self.sq[1].on = false;
                    self.wave.on = false;
                    self.noise.on = false;
                }
                self.regs[i] = v & 0x80;
            }
            0x90..=0x9E => {
                let bank = if self.regs[reg_index(0x70)] & 0x40 != 0 { 0 } else { 16 };
                let k = bank + (a - 0x90) as usize;
                self.wave_ram[k] = v as u8;
                self.wave_ram[k + 1] = (v >> 8) as u8;
            }
            _ => self.regs[i] = v,
        }
    }

    fn noise_period(cnt: u16) -> i32 {
        let r = (cnt & 7) as i32;
        let div = if r == 0 { 8 } else { r * 16 };
        (div << ((cnt >> 4) & 0xF)) * 4
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
        let cnt = self.regs[reg_index(0x82)];
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

    fn sequencer(&mut self) {
        let step = self.seq_step;
        self.seq_step = (step + 1) & 7;
        if step & 1 == 0 {
            for s in &mut self.sq {
                if s.length_en && s.length > 0 {
                    s.length -= 1;
                    if s.length == 0 {
                        s.on = false;
                    }
                }
            }
            let w = &mut self.wave;
            if w.length_en && w.length > 0 {
                w.length -= 1;
                if w.length == 0 {
                    w.on = false;
                }
            }
            let n = &mut self.noise;
            if n.length_en && n.length > 0 {
                n.length -= 1;
                if n.length == 0 {
                    n.on = false;
                }
            }
        }
        if step == 2 || step == 6 {
            self.sq[0].sweep();
        }
        if step == 7 {
            self.sq[0].env.clock();
            self.sq[1].env.clock();
            self.noise.env.clock();
        }
    }

    fn psg(&mut self) -> (i32, i32) {
        let t = CYCLES_PER_SAMPLE;
        self.sq[0].step(t);
        self.sq[1].step(t);
        let w70 = self.regs[reg_index(0x70)];
        let mut wave_out = 0;
        if self.wave.on {
            let w = &mut self.wave;
            w.timer -= t;
            let samples = if w70 & 0x20 != 0 { 64 } else { 32 };
            while w.timer <= 0 {
                w.timer += (2048 - w.freq as i32) * 8;
                w.pos = ((w.pos as u32 + 1) % samples) as u8;
            }
            // Playing bank (bit 6), or both banks in 64-sample mode.
            let base = if w70 & 0x40 != 0 { 16 } else { 0 };
            let p = w.pos as usize;
            let byte = self.wave_ram[(base + p / 2) & 31];
            let s = if p & 1 == 0 { byte >> 4 } else { byte & 0xF } as i32;
            let vol = self.regs[reg_index(0x72)];
            wave_out = if vol & 0x8000 != 0 {
                s * 3 / 4
            } else {
                match (vol >> 13) & 3 {
                    0 => 0,
                    1 => s,
                    2 => s / 2,
                    _ => s / 4,
                }
            };
        }
        let mut noise_out = 0;
        if self.noise.on {
            let cnt = self.regs[reg_index(0x7C)];
            let n = &mut self.noise;
            n.timer -= t;
            let period = Self::noise_period(cnt);
            while n.timer <= 0 {
                n.timer += period;
                let bit = (n.lfsr ^ (n.lfsr >> 1)) & 1;
                n.lfsr >>= 1;
                if cnt & 8 != 0 {
                    n.lfsr = (n.lfsr & !0x40) | (bit << 6);
                } else {
                    n.lfsr |= bit << 14;
                }
            }
            if n.lfsr & 1 == 0 {
                noise_out = n.env.vol as i32;
            }
        }
        self.seq_timer -= t;
        if self.seq_timer <= 0 {
            self.seq_timer += SEQ_PERIOD;
            self.sequencer();
        }
        let outs = [self.sq[0].out(), self.sq[1].out(), wave_out, noise_out];
        let cnt = self.regs[reg_index(0x80)];
        let (mut l, mut r) = (0, 0);
        for (k, &o) in outs.iter().enumerate() {
            if cnt & (0x100 << k) != 0 {
                r += o;
            }
            if cnt & (0x1000 << k) != 0 {
                l += o;
            }
        }
        let vr = (cnt & 7) as i32 + 1;
        let vl = ((cnt >> 4) & 7) as i32 + 1;
        (l * vl, r * vr)
    }

    pub fn sample(&mut self, _at: u64) {
        if !self.output || !self.master_on() {
            return;
        }
        let (pl, pr) = self.psg();
        let cnt = self.regs[reg_index(0x82)];
        // PSG: 0..15 per channel × 4 channels × volume 1..8, scaled by the PSG ratio.
        let ratio = [0.25f32, 0.5, 1.0, 0.0][(cnt & 3) as usize];
        let mut l = pl as f32 / 480.0 * ratio;
        let mut r = pr as f32 / 480.0 * ratio;
        for f in 0..2 {
            let s = self.cur[f] as f32 / 128.0 * if cnt & (4 << f) != 0 { 1.0 } else { 0.5 };
            if cnt & (0x100 << (4 * f)) != 0 {
                r += s;
            }
            if cnt & (0x200 << (4 * f)) != 0 {
                l += s;
            }
        }
        let w = self.write_pos as usize;
        self.buffer[w] = l * 0.4;
        self.buffer[w + 1] = r * 0.4;
        self.write_pos = ((w + 2) % AUDIO_LEN) as u32;
    }
}

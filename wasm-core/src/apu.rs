// DMG APU: a port of src/core/apu.ts. Float math matches the JS (f64, stored as f32).

const DUTY: [[u8; 8]; 4] = [
    [0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1, 1, 1],
    [0, 1, 1, 1, 1, 1, 1, 0],
];
const NOISE_DIV: [i32; 8] = [8, 16, 32, 48, 64, 80, 96, 112];
const READ_MASK: [u8; 32] = [
    0x80, 0x3f, 0x00, 0xff, 0xbf, 0xff, 0x3f, 0x00, 0xff, 0xbf, 0x7f, 0xff, 0x9f, 0xff, 0xbf, 0xff,
    0xff, 0x00, 0x00, 0xbf, 0x00, 0x00, 0x70, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];
const M_CYCLES_PER_SEC: f64 = 1048576.0;
pub const BUF_LEN: usize = 16384;

#[derive(Default)]
struct Envelope {
    initial: u8,
    up: bool,
    period: i32,
    volume: u8,
    timer: i32,
}

impl Envelope {
    fn write(&mut self, v: u8) {
        self.initial = v >> 4;
        self.up = v & 8 != 0;
        self.period = (v & 7) as i32;
    }
    fn trigger(&mut self) {
        self.volume = self.initial;
        self.timer = if self.period != 0 { self.period } else { 8 };
    }
    fn clock(&mut self) {
        if self.period == 0 {
            return;
        }
        self.timer -= 1;
        if self.timer <= 0 {
            self.timer = if self.period != 0 { self.period } else { 8 };
            if self.up && self.volume < 15 {
                self.volume += 1;
            } else if !self.up && self.volume > 0 {
                self.volume -= 1;
            }
        }
    }
}

#[derive(Default)]
struct Square {
    enabled: bool,
    dac_on: bool,
    duty: u8,
    pos: u8,
    length: i32,
    length_enable: bool,
    freq: i32,
    timer: i32,
    env: Envelope,
    has_sweep: bool,
    sweep_period: i32,
    sweep_negate: bool,
    sweep_shift: i32,
    sweep_timer: i32,
    sweep_enabled: bool,
    shadow: i32,
    neg_used: bool,
}

impl Square {
    #[inline(always)]
    fn step(&mut self, t: i32) {
        self.timer -= t;
        while self.timer <= 0 {
            self.timer += (2048 - self.freq) * 4;
            self.pos = (self.pos + 1) & 7;
        }
    }
    #[inline(always)]
    fn output(&self) -> u8 {
        if !self.enabled {
            return 0;
        }
        if DUTY[self.duty as usize][self.pos as usize] != 0 { self.env.volume } else { 0 }
    }
    fn clock_length(&mut self) {
        if self.length_enable && self.length > 0 {
            self.length -= 1;
            if self.length == 0 {
                self.enabled = false;
            }
        }
    }
    fn calc_sweep(&mut self) -> i32 {
        let mut f = self.shadow >> self.sweep_shift;
        if self.sweep_negate {
            f = self.shadow - f;
            self.neg_used = true;
        } else {
            f += self.shadow;
        }
        if f > 2047 {
            self.enabled = false;
        }
        f
    }
    fn clock_sweep(&mut self) {
        self.sweep_timer -= 1;
        if self.sweep_timer <= 0 {
            self.sweep_timer = if self.sweep_period != 0 { self.sweep_period } else { 8 };
            if self.sweep_enabled && self.sweep_period != 0 {
                let f = self.calc_sweep();
                if f <= 2047 && self.sweep_shift != 0 {
                    self.freq = f;
                    self.shadow = f;
                    self.calc_sweep();
                }
            }
        }
    }
    fn write_sweep(&mut self, v: u8) {
        let was_neg = self.sweep_negate;
        self.sweep_period = ((v >> 4) & 7) as i32;
        self.sweep_negate = v & 8 != 0;
        self.sweep_shift = (v & 7) as i32;
        if was_neg && !self.sweep_negate && self.neg_used {
            self.enabled = false;
        }
    }
    fn trigger(&mut self) {
        self.enabled = self.dac_on;
        if self.length == 0 {
            self.length = 64;
        }
        self.timer = (2048 - self.freq) * 4;
        self.env.trigger();
        if self.has_sweep {
            self.shadow = self.freq;
            self.sweep_timer = if self.sweep_period != 0 { self.sweep_period } else { 8 };
            self.sweep_enabled = self.sweep_period != 0 || self.sweep_shift != 0;
            self.neg_used = false;
            if self.sweep_shift != 0 {
                self.calc_sweep();
            }
        }
    }
}

#[derive(Default)]
struct Wave {
    enabled: bool,
    dac_on: bool,
    length: i32,
    length_enable: bool,
    freq: i32,
    timer: i32,
    pos: u8,
    vol_shift: u8,
    sample: u8,
    ram: [u8; 16],
}

impl Wave {
    #[inline(always)]
    fn step(&mut self, t: i32) {
        self.timer -= t;
        while self.timer <= 0 {
            self.timer += (2048 - self.freq) * 2;
            self.pos = (self.pos + 1) & 31;
            let b = self.ram[(self.pos >> 1) as usize];
            self.sample = if self.pos & 1 != 0 { b & 0x0f } else { b >> 4 };
        }
    }
    #[inline(always)]
    fn output(&self) -> u8 {
        if !self.enabled || self.vol_shift == 0 {
            return 0;
        }
        self.sample >> (self.vol_shift - 1)
    }
    fn clock_length(&mut self) {
        if self.length_enable && self.length > 0 {
            self.length -= 1;
            if self.length == 0 {
                self.enabled = false;
            }
        }
    }
    fn trigger(&mut self) {
        self.enabled = self.dac_on;
        if self.length == 0 {
            self.length = 256;
        }
        self.timer = (2048 - self.freq) * 2 + 6;
        self.pos = 0;
    }
}

struct Noise {
    enabled: bool,
    dac_on: bool,
    length: i32,
    length_enable: bool,
    timer: i32,
    shift: u32,
    width7: bool,
    div_code: u8,
    lfsr: u32,
    env: Envelope,
}

impl Noise {
    #[inline(always)]
    fn period(&self) -> i32 {
        NOISE_DIV[self.div_code as usize] << self.shift
    }
    #[inline(always)]
    fn step(&mut self, t: i32) {
        self.timer -= t;
        while self.timer <= 0 {
            self.timer += self.period();
            let x = (self.lfsr & 1) ^ ((self.lfsr >> 1) & 1);
            self.lfsr = (self.lfsr >> 1) | (x << 14);
            if self.width7 {
                self.lfsr = (self.lfsr & !0x40) | (x << 6);
            }
        }
    }
    #[inline(always)]
    fn output(&self) -> u8 {
        if !self.enabled {
            return 0;
        }
        if self.lfsr & 1 != 0 { 0 } else { self.env.volume }
    }
    fn clock_length(&mut self) {
        if self.length_enable && self.length > 0 {
            self.length -= 1;
            if self.length == 0 {
                self.enabled = false;
            }
        }
    }
    fn trigger(&mut self) {
        self.enabled = self.dac_on;
        if self.length == 0 {
            self.length = 64;
        }
        self.timer = self.period();
        self.lfsr = 0x7fff;
        self.env.trigger();
    }
}

/// Length-enable write with the "extra length clock" quirk.
fn length_enable_write(le: &mut bool, len: &mut i32, en: &mut bool, v: u8, next_clocks: bool) {
    let was = *le;
    *le = v & 0x40 != 0;
    if !was && *le && next_clocks && *len > 0 {
        *len -= 1;
        if *len == 0 && v & 0x80 == 0 {
            *en = false;
        }
    }
}

pub struct Apu {
    ch1: Square,
    ch2: Square,
    ch3: Wave,
    ch4: Noise,
    regs: [u8; 0x30],
    power: bool,
    seq_timer: i32,
    seq_step: u8,
    nr50: u8,
    nr51: u8,
    pub sample_rate: f64,
    pub output_enabled: bool,
    pub channel_mask: u8,
    acc: f64,
    mix_phase: u32,
    sum_l: f64,
    sum_r: f64,
    sum_n: f64,
    hp_l: f64,
    hp_r: f64,
    hp_prev_l: f64,
    hp_prev_r: f64,
    pub buffer: [f32; BUF_LEN],
    pub write_pos: usize,
    pub read_pos: usize,
}

impl Apu {
    pub fn new() -> Self {
        let mut a = Apu {
            ch1: Square { has_sweep: true, ..Default::default() },
            ch2: Square::default(),
            ch3: Wave::default(),
            ch4: Noise {
                enabled: false,
                dac_on: false,
                length: 0,
                length_enable: false,
                timer: 0,
                shift: 0,
                width7: false,
                div_code: 0,
                lfsr: 0x7fff,
                env: Envelope::default(),
            },
            regs: [0; 0x30],
            power: true,
            seq_timer: 0,
            seq_step: 0,
            nr50: 0x77,
            nr51: 0xf3,
            sample_rate: 48000.0,
            output_enabled: true,
            channel_mask: 0b1111,
            acc: 0.0,
            mix_phase: 0,
            sum_l: 0.0,
            sum_r: 0.0,
            sum_n: 0.0,
            hp_l: 0.0,
            hp_r: 0.0,
            hp_prev_l: 0.0,
            hp_prev_r: 0.0,
            buffer: [0.0; BUF_LEN],
            write_pos: 0,
            read_pos: 0,
        };
        const INIT: [(u16, u8); 21] = [
            (0xff10, 0x80), (0xff11, 0xbf), (0xff12, 0xf3), (0xff14, 0xbf), (0xff16, 0x3f),
            (0xff17, 0x00), (0xff19, 0xbf), (0xff1a, 0x7f), (0xff1b, 0xff), (0xff1c, 0x9f),
            (0xff1e, 0xbf), (0xff20, 0xff), (0xff21, 0x00), (0xff22, 0x00), (0xff23, 0xbf),
            (0xff24, 0x77), (0xff25, 0xf3), (0, 0), (0, 0), (0, 0), (0, 0),
        ];
        for &(addr, v) in INIT.iter() {
            if addr != 0 {
                a.write(addr, v);
            }
        }
        a.ch1.enabled = false;
        a.ch2.enabled = false;
        a.ch3.enabled = false;
        a.ch4.enabled = false;
        a
    }

    /// Registers, wave RAM and power, as Apu.saveState in the TypeScript core.
    pub fn save(&self, regs: &mut [u8; 0x30], wave: &mut [u8; 16]) -> bool {
        *regs = self.regs;
        *wave = self.ch3.ram;
        self.power
    }

    /// Replays NR10-NR51 with trigger bits cleared, as Apu.loadState does.
    pub fn load(&mut self, regs: &[u8; 0x30], wave: &[u8; 16], power: bool) {
        self.power = true;
        for i in 0..0x16usize {
            let a = 0xff10 + i as u16;
            let v = if matches!(a, 0xff14 | 0xff19 | 0xff1e | 0xff23) { regs[i] & 0x7f } else { regs[i] };
            self.write(a, v);
        }
        self.ch3.ram = *wave;
        if !power {
            self.write(0xff26, 0);
        }
    }

    pub fn clear_buffer(&mut self) {
        self.read_pos = self.write_pos;
    }

    #[inline(always)]
    pub fn tick(&mut self) {
        if self.power {
            self.ch1.step(4);
            self.ch2.step(4);
            self.ch3.step(4);
            self.ch4.step(4);
            self.seq_timer += 1;
            if self.seq_timer >= 2048 {
                self.seq_timer = 0;
                self.clock_sequencer();
            }
        }
        if !self.output_enabled {
            return;
        }
        self.mix_phase = self.mix_phase.wrapping_add(1);
        if self.mix_phase & 3 != 0 {
            return;
        }
        self.mix();
    }

    fn clock_sequencer(&mut self) {
        let s = self.seq_step;
        if s & 1 == 0 {
            self.ch1.clock_length();
            self.ch2.clock_length();
            self.ch3.clock_length();
            self.ch4.clock_length();
        }
        if s == 2 || s == 6 {
            self.ch1.clock_sweep();
        }
        if s == 7 {
            self.ch1.env.clock();
            self.ch2.env.clock();
            self.ch4.env.clock();
        }
        self.seq_step = (s + 1) & 7;
    }

    fn mix(&mut self) {
        let mut l = 0.0f64;
        let mut r = 0.0f64;
        if self.power {
            let m = self.channel_mask;
            let o1 = if m & 1 != 0 && self.ch1.dac_on { self.ch1.output() as f64 / 7.5 - 1.0 } else { 0.0 };
            let o2 = if m & 2 != 0 && self.ch2.dac_on { self.ch2.output() as f64 / 7.5 - 1.0 } else { 0.0 };
            let o3 = if m & 4 != 0 && self.ch3.dac_on { self.ch3.output() as f64 / 7.5 - 1.0 } else { 0.0 };
            let o4 = if m & 8 != 0 && self.ch4.dac_on { self.ch4.output() as f64 / 7.5 - 1.0 } else { 0.0 };
            let p = self.nr51;
            if p & 0x10 != 0 { l += o1; }
            if p & 0x20 != 0 { l += o2; }
            if p & 0x40 != 0 { l += o3; }
            if p & 0x80 != 0 { l += o4; }
            if p & 0x01 != 0 { r += o1; }
            if p & 0x02 != 0 { r += o2; }
            if p & 0x04 != 0 { r += o3; }
            if p & 0x08 != 0 { r += o4; }
            l *= (((self.nr50 >> 4) & 7) as f64 + 1.0) / 8.0;
            r *= ((self.nr50 & 7) as f64 + 1.0) / 8.0;
        }
        self.sum_l += l;
        self.sum_r += r;
        self.sum_n += 1.0;
        self.acc += self.sample_rate * 4.0;
        if self.acc >= M_CYCLES_PER_SEC {
            self.acc -= M_CYCLES_PER_SEC;
            let avg_l = self.sum_l / self.sum_n / 4.0;
            let avg_r = self.sum_r / self.sum_n / 4.0;
            self.sum_l = 0.0;
            self.sum_r = 0.0;
            self.sum_n = 0.0;
            let a = 0.996;
            let out_l = avg_l - self.hp_prev_l + a * self.hp_l;
            let out_r = avg_r - self.hp_prev_r + a * self.hp_r;
            self.hp_prev_l = avg_l;
            self.hp_prev_r = avg_r;
            self.hp_l = out_l;
            self.hp_r = out_r;
            let next = (self.write_pos + 2) % BUF_LEN;
            if next != self.read_pos {
                self.buffer[self.write_pos] = out_l as f32;
                self.buffer[self.write_pos + 1] = out_r as f32;
                self.write_pos = next;
            }
        }
    }

    pub fn read(&self, addr: u16) -> u8 {
        if (0xff30..=0xff3f).contains(&addr) {
            return self.ch3.ram[(addr - 0xff30) as usize];
        }
        let i = addr as i32 - 0xff10;
        if i < 0 || i >= READ_MASK.len() as i32 {
            return 0xff;
        }
        if addr == 0xff26 {
            return (if self.power { 0x80 } else { 0 })
                | 0x70
                | (self.ch1.enabled as u8)
                | ((self.ch2.enabled as u8) << 1)
                | ((self.ch3.enabled as u8) << 2)
                | ((self.ch4.enabled as u8) << 3);
        }
        self.regs[i as usize] | READ_MASK[i as usize]
    }

    pub fn write(&mut self, addr: u16, v: u8) {
        if (0xff30..=0xff3f).contains(&addr) {
            self.ch3.ram[(addr - 0xff30) as usize] = v;
            return;
        }
        if addr == 0xff26 {
            let on = v & 0x80 != 0;
            if self.power && !on {
                for a in 0xff10..=0xff25u16 {
                    self.write(a, 0);
                }
                self.ch1.enabled = false;
                self.ch2.enabled = false;
                self.ch3.enabled = false;
                self.ch4.enabled = false;
                self.power = false;
            } else if !self.power && on {
                self.power = true;
                self.seq_step = 0;
                self.ch1.pos = 0;
                self.ch2.pos = 0;
            }
            return;
        }
        let i = addr as i32 - 0xff10;
        if !(0..0x17).contains(&i) {
            return;
        }
        if !self.power {
            match addr {
                0xff11 => self.ch1.length = 64 - (v & 0x3f) as i32,
                0xff16 => self.ch2.length = 64 - (v & 0x3f) as i32,
                0xff1b => self.ch3.length = 256 - v as i32,
                0xff20 => self.ch4.length = 64 - (v & 0x3f) as i32,
                _ => {}
            }
            return;
        }
        self.regs[i as usize] = v;
        let nxt = self.seq_step & 1 == 1;
        match addr {
            0xff10 => self.ch1.write_sweep(v),
            0xff11 => {
                self.ch1.duty = v >> 6;
                self.ch1.length = 64 - (v & 0x3f) as i32;
            }
            0xff12 => {
                self.ch1.env.write(v);
                self.ch1.dac_on = v & 0xf8 != 0;
                if !self.ch1.dac_on {
                    self.ch1.enabled = false;
                }
            }
            0xff13 => self.ch1.freq = (self.ch1.freq & 0x700) | v as i32,
            0xff14 => {
                let c = &mut self.ch1;
                c.freq = (c.freq & 0xff) | (((v & 7) as i32) << 8);
                length_enable_write(&mut c.length_enable, &mut c.length, &mut c.enabled, v, nxt);
                if v & 0x80 != 0 {
                    c.trigger();
                    if c.length_enable && c.length == 64 && nxt {
                        c.length -= 1;
                    }
                }
            }
            0xff16 => {
                self.ch2.duty = v >> 6;
                self.ch2.length = 64 - (v & 0x3f) as i32;
            }
            0xff17 => {
                self.ch2.env.write(v);
                self.ch2.dac_on = v & 0xf8 != 0;
                if !self.ch2.dac_on {
                    self.ch2.enabled = false;
                }
            }
            0xff18 => self.ch2.freq = (self.ch2.freq & 0x700) | v as i32,
            0xff19 => {
                let c = &mut self.ch2;
                c.freq = (c.freq & 0xff) | (((v & 7) as i32) << 8);
                length_enable_write(&mut c.length_enable, &mut c.length, &mut c.enabled, v, nxt);
                if v & 0x80 != 0 {
                    c.trigger();
                    if c.length_enable && c.length == 64 && nxt {
                        c.length -= 1;
                    }
                }
            }
            0xff1a => {
                self.ch3.dac_on = v & 0x80 != 0;
                if !self.ch3.dac_on {
                    self.ch3.enabled = false;
                }
            }
            0xff1b => self.ch3.length = 256 - v as i32,
            0xff1c => self.ch3.vol_shift = (v >> 5) & 3,
            0xff1d => self.ch3.freq = (self.ch3.freq & 0x700) | v as i32,
            0xff1e => {
                let c = &mut self.ch3;
                c.freq = (c.freq & 0xff) | (((v & 7) as i32) << 8);
                length_enable_write(&mut c.length_enable, &mut c.length, &mut c.enabled, v, nxt);
                if v & 0x80 != 0 {
                    c.trigger();
                    if c.length_enable && c.length == 256 && nxt {
                        c.length -= 1;
                    }
                }
            }
            0xff20 => self.ch4.length = 64 - (v & 0x3f) as i32,
            0xff21 => {
                self.ch4.env.write(v);
                self.ch4.dac_on = v & 0xf8 != 0;
                if !self.ch4.dac_on {
                    self.ch4.enabled = false;
                }
            }
            0xff22 => {
                self.ch4.shift = (v >> 4) as u32;
                self.ch4.width7 = v & 8 != 0;
                self.ch4.div_code = v & 7;
            }
            0xff23 => {
                let c = &mut self.ch4;
                length_enable_write(&mut c.length_enable, &mut c.length, &mut c.enabled, v, nxt);
                if v & 0x80 != 0 {
                    c.trigger();
                    if c.length_enable && c.length == 64 && nxt {
                        c.length -= 1;
                    }
                }
            }
            0xff24 => self.nr50 = v,
            0xff25 => self.nr51 = v,
            _ => {}
        }
    }
}

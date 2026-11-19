// DIV/TIMA timer, including the falling-edge and TIMA reload quirks.

use crate::state::State;
use crate::INT_TIMER;

const TAC_BITS: [u16; 4] = [1 << 9, 1 << 3, 1 << 5, 1 << 7];

pub struct Timer {
    pub counter: u16,
    pub tima: u8,
    pub tma: u8,
    pub tac: u8,
    reload_pending: bool,
    reloading: bool,
}

impl Timer {
    pub fn new() -> Self {
        Timer { counter: 0, tima: 0, tma: 0, tac: 0, reload_pending: false, reloading: false }
    }

    #[inline(always)]
    pub fn tick(&mut self, iflag: &mut u8) {
        self.reloading = false;
        if self.reload_pending {
            self.reload_pending = false;
            self.tima = self.tma;
            self.reloading = true;
            *iflag |= INT_TIMER;
        }
        let old = self.counter;
        self.counter = self.counter.wrapping_add(4);
        if self.tac & 4 != 0 {
            let bit = TAC_BITS[(self.tac & 3) as usize];
            if old & bit != 0 && self.counter & bit == 0 {
                self.inc_tima();
            }
        }
    }

    fn inc_tima(&mut self) {
        self.tima = self.tima.wrapping_add(1);
        if self.tima == 0 {
            self.reload_pending = true;
        }
    }

    fn signal(&self) -> bool {
        self.tac & 4 != 0 && self.counter & TAC_BITS[(self.tac & 3) as usize] != 0
    }

    pub fn save(&self, s: &mut State) {
        s.put(self.counter as f64);
        s.put(self.tima as f64);
        s.put(self.tma as f64);
        s.put(self.tac as f64);
        s.flag(self.reload_pending);
        s.flag(self.reloading);
    }

    pub fn load(&mut self, s: &mut State) {
        self.counter = s.get() as u16;
        self.tima = s.get() as u8;
        self.tma = s.get() as u8;
        self.tac = s.get() as u8;
        self.reload_pending = s.is();
        self.reloading = s.is();
    }

    pub fn read(&self, addr: u16) -> u8 {
        match addr {
            0xff04 => (self.counter >> 8) as u8,
            0xff05 => self.tima,
            0xff06 => self.tma,
            0xff07 => self.tac | 0xf8,
            _ => 0xff,
        }
    }

    pub fn write(&mut self, addr: u16, val: u8) {
        match addr {
            0xff04 => {
                let was = self.signal();
                self.counter = 0;
                if was {
                    self.inc_tima();
                }
            }
            0xff05 => {
                if self.reloading {
                    return;
                }
                self.reload_pending = false;
                self.tima = val;
            }
            0xff06 => {
                self.tma = val;
                if self.reloading {
                    self.tima = val;
                }
            }
            0xff07 => {
                let was = self.signal();
                self.tac = val & 7;
                if was && !self.signal() {
                    self.inc_tima();
                }
            }
            _ => {}
        }
    }
}

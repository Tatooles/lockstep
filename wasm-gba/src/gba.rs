// The machine: CPU + system bus, the frame loop, and execution hooks.

use crate::cpu::Cpu;
use crate::sys::{Sys, CYCLES_PER_FRAME};

const MAX_HOOKS: usize = 64;

/// Addresses where `run_frame` stops before executing, so the host can read
/// game state at a precise moment (e.g. when a battle starts).
pub struct Hooks {
    filter: [u64; 1024],
    addrs: [u32; MAX_HOOKS],
    n: usize,
    /// The address `run_frame` stopped at (it resumes past it next call).
    pub hit: u32,
    resume: bool,
}

#[inline(always)]
fn hook_hash(pc: u32) -> usize {
    ((pc >> 1) ^ (pc >> 17)) as usize & 0xFFFF
}

impl Hooks {
    pub fn add(&mut self, addr: u32) -> bool {
        if self.n == MAX_HOOKS {
            return false;
        }
        self.addrs[self.n] = addr & !1;
        self.n += 1;
        let h = hook_hash(addr & !1);
        self.filter[h >> 6] |= 1 << (h & 63);
        true
    }

    pub fn clear(&mut self) {
        self.n = 0;
        self.filter.fill(0);
    }

    #[inline(always)]
    fn test(&self, pc: u32) -> bool {
        let h = hook_hash(pc);
        if self.filter[h >> 6] & (1 << (h & 63)) == 0 {
            return false;
        }
        self.addrs[..self.n].contains(&pc)
    }
}

pub struct Gba {
    pub cpu: Cpu,
    pub sys: Sys,
    pub hooks: Hooks,
    in_frame: bool,
}

pub const RUN_FRAME_DONE: u32 = 0;
pub const RUN_HOOK: u32 = 1;

impl Gba {
    /// A powered-on machine with `rom` inserted, past the BIOS intro.
    pub fn new_boxed(rom: &'static [u8]) -> Box<Gba> {
        // Gba is plain data and large; build it zeroed on the heap.
        let mut g: Box<Gba> = unsafe { Box::<Gba>::new_zeroed().assume_init() };
        g.power_on(rom);
        g
    }

    pub fn power_on(&mut self, rom: &'static [u8]) {
        let save = if self.sys.save.kind != 0 { Some(self.sys.save.data) } else { None };
        let hooks_n = self.hooks.n;
        // Zero everything but the hooks, then rebuild.
        unsafe {
            core::ptr::write_bytes(&mut self.sys as *mut Sys, 0, 1);
        }
        self.cpu = Cpu::new();
        self.sys.init(rom.as_ptr(), rom.len() as u32);
        if let Some(data) = save {
            self.sys.save.data = data;
        }
        self.hooks.n = hooks_n;
        self.cpu.skip_bios(0x0800_0000);
        self.cpu.reload(&mut self.sys);
        self.in_frame = false;
    }

    /// Run until the start of the next VBlank. Returns RUN_HOOK if a hook
    /// address was reached first; calling again continues the same frame.
    pub fn run_frame(&mut self) -> u32 {
        if !self.in_frame {
            self.sys.frame_done = false;
            self.in_frame = true;
        }
        let deadline = self.sys.now + CYCLES_PER_FRAME * 2;
        loop {
            if self.sys.halted {
                if self.sys.now < self.sys.next_event {
                    self.sys.now = self.sys.next_event;
                }
            } else if self.hooks.n == 0 {
                let cpu = &mut self.cpu;
                let sys = &mut self.sys;
                while sys.now < sys.next_event {
                    if sys.irq_line && !cpu.irq_disabled() {
                        cpu.irq(sys);
                    }
                    cpu.step(sys);
                    if sys.halted {
                        break;
                    }
                }
            } else {
                while self.sys.now < self.sys.next_event {
                    if self.sys.irq_line && !self.cpu.irq_disabled() {
                        self.cpu.irq(&mut self.sys);
                    }
                    let pc = self.cpu.next_pc();
                    if self.hooks.resume {
                        self.hooks.resume = false;
                    } else if self.hooks.test(pc) {
                        self.hooks.hit = pc;
                        self.hooks.resume = true;
                        return RUN_HOOK;
                    }
                    self.cpu.step(&mut self.sys);
                    if self.sys.halted {
                        break;
                    }
                }
            }
            self.sys.run_events();
            if self.sys.frame_done || self.sys.now >= deadline {
                self.in_frame = false;
                return RUN_FRAME_DONE;
            }
        }
    }
}

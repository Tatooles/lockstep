// Runs the SingleStepTests ARM7TDMI suite (https://github.com/SingleStepTests/ARM7TDMI)
// against the CPU. Reads the .json.bin files directly.
//   cargo run --release --bin sst -- <dir with *.json.bin> [filter] [-v]

use lockstep_gba::cpu::{Bus, Cpu, Swi};
use std::fs;

#[derive(Clone, Default, Debug)]
struct State {
    r: [u32; 16],
    fiq: [u32; 7],
    svc: [u32; 2],
    abt: [u32; 2],
    irq: [u32; 2],
    und: [u32; 2],
    cpsr: u32,
    spsr: [u32; 5],
    pipe: [u32; 2],
}

#[derive(Clone, Copy, Debug)]
struct Tx {
    kind: u32,
    size: u32,
    addr: u32,
    data: u32,
}

struct Test {
    initial: State,
    fin: State,
    txs: Vec<Tx>,
    opcode: u32,
    base: u32,
}

fn u32_at(b: &[u8], p: usize) -> u32 {
    u32::from_le_bytes(b[p..p + 4].try_into().unwrap())
}

fn read_state(b: &[u8], p: usize) -> (usize, State) {
    let sz = u32_at(b, p) as usize;
    let v: Vec<u32> = (0..40).map(|i| u32_at(b, p + 8 + i * 4)).collect();
    let mut s = State::default();
    s.r.copy_from_slice(&v[0..16]);
    s.fiq.copy_from_slice(&v[16..23]);
    s.svc.copy_from_slice(&v[23..25]);
    s.abt.copy_from_slice(&v[25..27]);
    s.irq.copy_from_slice(&v[27..29]);
    s.und.copy_from_slice(&v[29..31]);
    s.cpsr = v[31];
    s.spsr.copy_from_slice(&v[32..37]);
    s.pipe.copy_from_slice(&v[37..39]);
    (sz, s)
}

fn parse(b: &[u8]) -> Vec<Test> {
    assert_eq!(u32_at(b, 0), 0xD33DBAE0, "bad magic");
    let n = u32_at(b, 4) as usize;
    let mut p = 8;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let full = u32_at(b, p) as usize;
        let mut q = p + 4;
        let (sz, initial) = read_state(b, q);
        q += sz;
        let (sz, fin) = read_state(b, q);
        q += sz;
        let sz = u32_at(b, q) as usize;
        let count = u32_at(b, q + 8) as usize;
        let mut txs = Vec::with_capacity(count);
        for i in 0..count {
            let t = q + 12 + i * 24;
            txs.push(Tx { kind: u32_at(b, t), size: u32_at(b, t + 4), addr: u32_at(b, t + 8), data: u32_at(b, t + 12) });
        }
        q += sz;
        let opcode = u32_at(b, q + 8);
        let base = u32_at(b, q + 12);
        out.push(Test { initial, fin, txs, opcode, base });
        p += full;
    }
    out
}

struct TestBus<'a> {
    test: &'a Test,
    next_read: usize,
    writes: Vec<Tx>,
}

impl TestBus<'_> {
    fn read(&mut self, addr: u32, size: u32) -> u32 {
        let reads = self.test.txs.iter().filter(|t| t.kind == 1).collect::<Vec<_>>();
        // A recorded read covers an aligned unit of its size; take our lane of it.
        let hit = |t: &Tx| {
            let mask = !(t.size.max(size) - 1);
            t.addr & mask == addr & mask
        };
        let lane = |t: &Tx| {
            if t.size > size {
                t.data >> ((addr & (t.size - 1) & !(size - 1)) * 8)
            } else {
                t.data
            }
        };
        // Prefer the next read in order; otherwise any read at that address.
        if let Some(t) = reads.get(self.next_read) {
            if hit(t) {
                self.next_read += 1;
                return lane(t);
            }
        }
        for t in &reads {
            if hit(t) {
                return lane(t);
            }
        }
        0
    }

    fn fetch(&mut self, addr: u32, size: u32) -> u32 {
        let addr = addr & !(size - 1);
        for t in &self.test.txs {
            if t.kind == 0 && t.size == size && t.addr == addr {
                return t.data;
            }
        }
        if addr == self.test.base {
            self.test.opcode
        } else if size == 2 {
            addr & 0xFFFF
        } else {
            addr
        }
    }
}

impl Bus for TestBus<'_> {
    fn read8(&mut self, addr: u32, _seq: bool) -> u32 {
        self.read(addr, 1) & 0xFF
    }
    fn read16(&mut self, addr: u32, _seq: bool) -> u32 {
        self.read(addr, 2) & 0xFFFF
    }
    fn read32(&mut self, addr: u32, _seq: bool) -> u32 {
        self.read(addr, 4)
    }
    fn write8(&mut self, addr: u32, v: u8, _seq: bool) {
        self.writes.push(Tx { kind: 2, size: 1, addr, data: v as u32 });
    }
    fn write16(&mut self, addr: u32, v: u16, _seq: bool) {
        self.writes.push(Tx { kind: 2, size: 2, addr, data: v as u32 });
    }
    fn write32(&mut self, addr: u32, v: u32, _seq: bool) {
        self.writes.push(Tx { kind: 2, size: 4, addr, data: v });
    }
    fn fetch16(&mut self, addr: u32, _seq: bool) -> u32 {
        self.fetch(addr, 2) & 0xFFFF
    }
    fn fetch32(&mut self, addr: u32, _seq: bool) -> u32 {
        self.fetch(addr, 4)
    }
    fn idle(&mut self) {}
    fn swi(&mut self, _cpu: &mut Cpu, _n: u32) -> Swi {
        Swi::Exception
    }
}

fn load(cpu: &mut Cpu, s: &State) {
    *cpu = Cpu::new();
    // Put the banked copies in place, then enter the test's mode directly.
    cpu.bank[1] = s.fiq;
    cpu.bank[2][5..7].copy_from_slice(&s.svc);
    cpu.bank[3][5..7].copy_from_slice(&s.abt);
    cpu.bank[4][5..7].copy_from_slice(&s.irq);
    cpu.bank[5][5..7].copy_from_slice(&s.und);
    cpu.spsr[1..6].copy_from_slice(&s.spsr);
    // R holds the user bank; the current mode's r8..r14 live in its own array.
    cpu.r = s.r;
    cpu.set_cpsr_raw((s.cpsr & !0x1F) | 0x10);
    cpu.switch_mode(s.cpsr & 0x1F);
    cpu.set_cpsr_raw(s.cpsr);
    cpu.pipe = s.pipe;
}

fn snapshot(cpu: &Cpu) -> State {
    let cpsr = cpu.get_cpsr();
    let mut cpu = cpu.clone();
    cpu.switch_mode(0x10);
    let mut s = State { r: cpu.r, fiq: cpu.bank[1], cpsr, pipe: cpu.pipe, ..Default::default() };
    s.svc.copy_from_slice(&cpu.bank[2][5..7]);
    s.abt.copy_from_slice(&cpu.bank[3][5..7]);
    s.irq.copy_from_slice(&cpu.bank[4][5..7]);
    s.und.copy_from_slice(&cpu.bank[5][5..7]);
    s.spsr.copy_from_slice(&cpu.spsr[1..6]);
    s
}

fn diff(got: &State, want: &State) -> Vec<String> {
    let mut d = vec![];
    for i in 0..16 {
        if got.r[i] != want.r[i] {
            d.push(format!("r{i}: got {:08x} want {:08x}", got.r[i], want.r[i]));
        }
    }
    let pairs: [(&str, &[u32], &[u32]); 7] = [
        ("fiq", &got.fiq, &want.fiq),
        ("svc", &got.svc, &want.svc),
        ("abt", &got.abt, &want.abt),
        ("irq", &got.irq, &want.irq),
        ("und", &got.und, &want.und),
        ("spsr", &got.spsr, &want.spsr),
        ("pipe", &got.pipe, &want.pipe),
    ];
    for (name, g, w) in pairs {
        if g != w {
            d.push(format!("{name}: got {:08x?} want {:08x?}", g, w));
        }
    }
    if got.cpsr != want.cpsr {
        d.push(format!("cpsr: got {:08x} want {:08x}", got.cpsr, want.cpsr));
    }
    d
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = args.get(1).expect("usage: sst <dir> [filter] [-v]");
    let filter = args.get(2).filter(|a| !a.starts_with('-')).cloned().unwrap_or_default();
    let verbose = args.iter().any(|a| a.starts_with("-v"));
    let mut files: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().ends_with(".json.bin") && p.to_string_lossy().contains(&filter))
        .collect();
    files.sort();
    let (mut total_pass, mut total) = (0usize, 0usize);
    for path in files {
        let tests = parse(&fs::read(&path).unwrap());
        let mut pass = 0;
        let mut shown = 0;
        let mut invalid_mode = 0;
        for (i, t) in tests.iter().enumerate() {
            let mut cpu = Cpu::new();
            load(&mut cpu, &t.initial);
            let mut bus = TestBus { test: t, next_read: 0, writes: vec![] };
            cpu.step(&mut bus);
            let got = snapshot(&cpu);
            let mut d = diff(&got, &t.fin);
            let want_writes: Vec<Tx> = t.txs.iter().filter(|x| x.kind == 2).copied().collect();
            let wmatch = want_writes.len() == bus.writes.len()
                && want_writes.iter().zip(&bus.writes).all(|(a, b)| {
                    let mask = !(a.size - 1);
                    a.size == b.size && a.addr & mask == b.addr & mask && a.data == b.data
                });
            if !wmatch {
                d.push(format!("writes: got {:x?} want {:x?}", bus.writes, want_writes));
            }
            let valid = |m: u32| matches!(m & 0x1F, 0x10 | 0x11 | 0x12 | 0x13 | 0x17 | 0x1B | 0x1F);
            if d.is_empty() {
                pass += 1;
            } else if !valid(t.fin.cpsr) || !valid(t.initial.cpsr) {
                invalid_mode += 1;
            } else if verbose && shown < 3 {
                shown += 1;
                println!("  #{i} opcode {:08x} cpsr {:08x}: {}", t.opcode, t.initial.cpsr, d.join("; "));
                if args.iter().any(|a| a == "-vv") {
                    println!("     txs {:x?}", t.txs);
                }
            }
        }
        let name = path.file_name().unwrap().to_string_lossy().replace(".json.bin", "");
        let note = if invalid_mode > 0 { format!("  ({invalid_mode} failures involve an invalid CPSR mode)") } else { String::new() };
        println!("{name:40} {pass:6}/{}{note}", tests.len());
        total_pass += pass;
        total += tests.len();
    }
    println!("TOTAL {total_pass}/{total} ({:.2}%)", 100.0 * total_pass as f64 / total.max(1) as f64);
}

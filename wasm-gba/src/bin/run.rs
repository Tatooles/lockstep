// Native test driver for the GBA core.
//   run <rom> [frames] [--png out.png] [--keys frame:mask,...] [--bench] [--r12]
//
// --r12 prints r12, which jsmolka's gba-tests leave as 0 on success or the
// number of the first failing test.

use lockstep_gba::gba::Gba;
use std::time::Instant;

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

/// Uncompressed PNG (stored deflate blocks).
fn png(w: u32, h: u32, rgba: &[u32]) -> Vec<u8> {
    let mut raw = Vec::new();
    for y in 0..h as usize {
        raw.push(0);
        for x in 0..w as usize {
            raw.extend_from_slice(&rgba[y * w as usize + x].to_le_bytes());
        }
    }
    let mut z = vec![0x78, 0x01];
    for (i, chunk) in raw.chunks(65535).enumerate() {
        let last = (i + 1) * 65535 >= raw.len();
        z.push(last as u8);
        z.extend_from_slice(&(chunk.len() as u16).to_le_bytes());
        z.extend_from_slice(&(!(chunk.len() as u16)).to_le_bytes());
        z.extend_from_slice(chunk);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for &x in &raw {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    z.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut chunk = |ty: &[u8], data: &[u8]| {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut c = ty.to_vec();
        c.extend_from_slice(data);
        out.extend_from_slice(&c);
        out.extend_from_slice(&crc32(&c).to_be_bytes());
    };
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = &args[1];
    let frames: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(120);
    let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let rom: &'static [u8] = Box::leak(std::fs::read(path).expect("read rom").into_boxed_slice());
    let mut g = Gba::new_boxed(rom);
    if args.iter().any(|a| a == "--norender") {
        g.sys.render = false;
    }
    // Key script: "frame:mask,frame:mask" (mask stays until the next entry).
    let script: Vec<(u32, u16)> = arg("--keys")
        .map(|s| {
            s.split(',')
                .map(|e| {
                    let (f, m) = e.split_once(':').unwrap();
                    (f.parse().unwrap(), u16::from_str_radix(m.trim_start_matches("0x"), 16).unwrap())
                })
                .collect()
        })
        .unwrap_or_default();
    let shots: Vec<u32> = arg("--shots").map(|s| s.split(',').map(|f| f.parse().unwrap()).collect()).unwrap_or_default();
    let t0 = Instant::now();
    let c0 = g.sys.now;
    for f in 0..frames {
        if let Some(&(_, m)) = script.iter().filter(|(sf, _)| *sf <= f).last() {
            g.sys.set_keys(m);
        }
        g.run_frame();
        if shots.contains(&f) {
            let out = format!("{}-{f}.png", arg("--png").unwrap_or("shot".into()).trim_end_matches(".png"));
            std::fs::write(&out, png(240, 160, &g.sys.ppu.frame)).unwrap();
        }
    }
    let secs = t0.elapsed().as_secs_f64();
    if args.iter().any(|a| a == "--bench") {
        let emu = (g.sys.now - c0) as f64 / 16_777_216.0;
        println!(
            "{frames} frames in {:.0} ms = {:.1}x realtime ({:.3} ms/frame), emulated {:.2}s",
            secs * 1000.0,
            emu / secs,
            secs * 1000.0 / frames as f64,
            emu
        );
    }
    if g.cpu.insns > 0 {
        println!("insns {} = {:.1} M/s, {:.2} cycles/insn (busy)", g.cpu.insns, g.cpu.insns as f64 / secs / 1e6, (g.sys.now - g.sys.idle_cycles) as f64 / g.cpu.insns as f64);
    }
    if args.iter().any(|a| a == "--r12") {
        println!("r12 = {}", g.cpu.r[12]);
    }
    println!(
        "pc {:08x} cpsr {:08x} halted {} frames {} busy {:.0}% vblanks(iwram counter) {}",
        g.cpu.next_pc(),
        g.cpu.get_cpsr(),
        g.sys.halted,
        g.sys.frames,
        100.0 - g.sys.idle_cycles as f64 * 100.0 / g.sys.now as f64,
        u32::from_le_bytes(g.sys.iwram[0x7FF8..0x7FFC].try_into().unwrap())
    );
    if let Some(p) = arg("--png") {
        if shots.is_empty() {
            std::fs::write(&p, png(240, 160, &g.sys.ppu.frame)).unwrap();
        }
    }
}

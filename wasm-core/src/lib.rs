// Lockstep Game Boy core in Rust, compiled to Wasm. A line-for-line port of
// src/core/*.ts, exposed through a small C ABI (no wasm-bindgen).

mod apu;
mod bus;
mod cart;
mod cpu;
mod ppu;
mod timer;

use bus::Bus;
use cart::Cart;
use cpu::Cpu;

pub const INT_VBLANK: u8 = 1;
pub const INT_STAT: u8 = 2;
pub const INT_TIMER: u8 = 4;
pub const INT_SERIAL: u8 = 8;
pub const INT_JOYPAD: u8 = 16;
const CYCLES_PER_FRAME: u64 = 70224;

mod host {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn now_ms() -> f64;
        pub fn serial_byte(b: u32);
    }
}

pub(crate) fn now() -> f64 {
    unsafe { host::now_ms() }
}

pub(crate) fn serial(b: u8) {
    unsafe { host::serial_byte(b as u32) }
}

static mut GB: *mut Cpu = core::ptr::null_mut();

#[inline(always)]
fn gb() -> &'static mut Cpu {
    unsafe { &mut *GB }
}

/// Reserve `len` bytes for the host to copy a ROM into.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

/// Build a Game Boy from a ROM previously copied into `alloc(len)`.
#[no_mangle]
pub extern "C" fn init(ptr: *mut u8, len: usize) {
    let rom = unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(ptr, len)) };
    let mut cpu = Box::new(Cpu::new(Bus::new(Cart::new(&rom))));
    drop(rom);
    // IO registers as left by the DMG boot ROM (GameBoy.initIo).
    {
        let b = &mut cpu.bus;
        b.timer.counter = 0xabcc;
        b.write(0xff05, 0);
        b.write(0xff06, 0);
        b.write(0xff07, 0xf8);
        b.iflag = 0xe1;
        b.write(0xff40, 0x91);
        b.write(0xff42, 0);
        b.write(0xff43, 0);
        b.write(0xff45, 0);
        b.write(0xff47, 0xfc);
        b.write(0xff48, 0xff);
        b.write(0xff49, 0xff);
        b.write(0xff4a, 0);
        b.write(0xff4b, 0);
        b.ie = 0;
    }
    unsafe {
        if !GB.is_null() {
            drop(Box::from_raw(GB));
        }
        GB = Box::into_raw(cpu);
    }
}

/// Run until the next VBlank (or one frame's worth of cycles if the LCD is off).
#[no_mangle]
pub extern "C" fn run_frame() {
    let cpu = gb();
    cpu.bus.ppu.frame_ready = false;
    let limit = cpu.bus.mcycles + CYCLES_PER_FRAME / 4;
    while !cpu.bus.ppu.frame_ready && cpu.bus.mcycles < limit {
        cpu.step();
    }
}

#[no_mangle]
pub extern "C" fn step() {
    gb().step();
}

#[no_mangle]
pub extern "C" fn frame_ptr() -> *const u8 {
    gb().bus.ppu.frame.as_ptr()
}

#[no_mangle]
pub extern "C" fn wram_ptr() -> *mut u8 {
    gb().bus.wram.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn mcycles() -> f64 {
    gb().bus.mcycles as f64
}

/// 0..10 = a f b c d e h l sp pc halted
#[no_mangle]
pub extern "C" fn reg(i: u32) -> u32 {
    let c = gb();
    match i {
        0 => c.a as u32,
        1 => c.f as u32,
        2 => c.b as u32,
        3 => c.c as u32,
        4 => c.d as u32,
        5 => c.e as u32,
        6 => c.h as u32,
        7 => c.l as u32,
        8 => c.sp as u32,
        9 => c.pc as u32,
        10 => c.halted as u32,
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn peek(addr: u32) -> u32 {
    gb().bus.read(addr as u16) as u32
}

#[no_mangle]
pub extern "C" fn set_button(id: u32, down: u32) {
    gb().bus.set_button(id, down != 0);
}

#[no_mangle]
pub extern "C" fn set_audio(enabled: u32, sample_rate: f64) {
    let apu = &mut gb().bus.apu;
    apu.output_enabled = enabled != 0;
    apu.sample_rate = sample_rate;
}

#[no_mangle]
pub extern "C" fn audio_ptr() -> *const f32 {
    gb().bus.apu.buffer.as_ptr()
}

#[no_mangle]
pub extern "C" fn audio_write_pos() -> u32 {
    gb().bus.apu.write_pos as u32
}

#[no_mangle]
pub extern "C" fn audio_read_pos() -> u32 {
    gb().bus.apu.read_pos as u32
}

#[no_mangle]
pub extern "C" fn audio_set_read_pos(p: u32) {
    gb().bus.apu.read_pos = p as usize;
}

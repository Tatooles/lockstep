// Lockstep's Game Boy core in Rust, compiled to Wasm and exposed through a
// small C ABI (no wasm-bindgen). The TypeScript wrapper is src/core/gameboy.ts.
//
// Memory is only allocated in `alloc` and `init`. After that nothing grows the
// Wasm heap, so typed-array views the host takes over it stay valid.

mod apu;
mod bus;
mod cart;
mod cpu;
mod ppu;
mod state;
mod timer;

use core::ptr::addr_of_mut;

use bus::Bus;
use cart::Cart;
use cpu::Cpu;
use state::State;

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

/// Save-state numbers, in the order of the SaveState arrays in src/core/gameboy.ts:
/// cpu[15], bus.regs[12], ppu.regs[17], timer[6], cart.regs[5], cart.rtc[9],
/// then apu.power and "has rtc".
const STATE_NUMS_LEN: usize = 66;
static mut STATE_NUMS: [f64; STATE_NUMS_LEN] = [0.0; STATE_NUMS_LEN];
const APU_POWER: usize = 64;
const HAS_RTC: usize = 65;
/// apu.regs[0x30] then apu.wave[16].
static mut STATE_BYTES: [u8; 0x40] = [0; 0x40];

#[inline(always)]
fn gb() -> &'static mut Cpu {
    unsafe { &mut *GB }
}

fn nums() -> &'static mut [f64; STATE_NUMS_LEN] {
    unsafe { &mut *addr_of_mut!(STATE_NUMS) }
}

fn bytes() -> &'static mut [u8; 0x40] {
    unsafe { &mut *addr_of_mut!(STATE_BYTES) }
}

/// IO registers as left by the DMG boot ROM (GameBoy.initIo).
fn init_io(cpu: &mut Cpu) {
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
    init_io(&mut cpu);
    unsafe {
        if !GB.is_null() {
            drop(Box::from_raw(GB));
        }
        GB = Box::into_raw(cpu);
    }
}

/// Power cycle, keeping battery RAM. Matches GameBoy.reset in the TypeScript
/// core: a fresh machine's state is loaded into this one (so the last frame
/// and channel internals the state doesn't cover carry over, as they do there).
#[no_mangle]
pub extern "C" fn reset() {
    let mut fresh = Cpu::new(Bus::new(Cart::empty()));
    init_io(&mut fresh);
    let n = nums();
    let b = bytes();
    save_into(&fresh, n, b);
    // A fresh cartridge: power-on mapper registers and a new RTC base.
    let cart: [f64; 14] = [0.0, 1.0, 0.0, 0.0, 255.0, 0.0, 0.0, 0.0, 0.0, 0.0, now(), 0.0, 0.0, 0.0];
    n[50..64].copy_from_slice(&cart);
    let cpu = gb();
    cpu.bus.wram.fill(0);
    cpu.bus.hram.fill(0);
    cpu.bus.ppu.vram.fill(0);
    cpu.bus.ppu.oam.fill(0);
    load_from(cpu, n, b);
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

/// Side-effect-free bus read.
#[no_mangle]
pub extern "C" fn peek(addr: u32) -> u32 {
    gb().bus.read(addr as u16) as u32
}

/// Bus write, with the same side effects as a CPU write.
#[no_mangle]
pub extern "C" fn poke(addr: u32, v: u32) {
    gb().bus.write(addr as u16, v as u8);
}

#[no_mangle]
pub extern "C" fn set_button(id: u32, down: u32) {
    gb().bus.set_button(id, down != 0);
}

// ---- memory views ----

#[no_mangle]
pub extern "C" fn frame_ptr() -> *const u8 {
    gb().bus.ppu.frame.as_ptr()
}

#[no_mangle]
pub extern "C" fn wram_ptr() -> *mut u8 {
    gb().bus.wram.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn hram_ptr() -> *mut u8 {
    gb().bus.hram.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn vram_ptr() -> *mut u8 {
    gb().bus.ppu.vram.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn oam_ptr() -> *mut u8 {
    gb().bus.ppu.oam.as_mut_ptr()
}

// ---- cartridge ----

#[no_mangle]
pub extern "C" fn cart_ram_ptr() -> *mut u8 {
    gb().bus.cart.ram.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn cart_ram_len() -> u32 {
    gb().bus.cart.ram.len() as u32
}

#[no_mangle]
pub extern "C" fn cart_ram_dirty() -> u32 {
    gb().bus.cart.ram_dirty as u32
}

#[no_mangle]
pub extern "C" fn set_cart_ram_dirty(v: u32) {
    gb().bus.cart.ram_dirty = v != 0;
}

#[no_mangle]
pub extern "C" fn rom_bank() -> u32 {
    gb().bus.cart.current_rom_bank() as u32
}

// ---- audio ----

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

#[no_mangle]
pub extern "C" fn audio_clear() {
    gb().bus.apu.clear_buffer();
}

// ---- save states ----

#[no_mangle]
pub extern "C" fn state_nums_ptr() -> *mut f64 {
    nums().as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn state_bytes_ptr() -> *mut u8 {
    bytes().as_mut_ptr()
}

fn save_into(cpu: &Cpu, n: &mut [f64; STATE_NUMS_LEN], b: &mut [u8; 0x40]) {
    let mut s = State::new(&mut n[..]);
    cpu.save(&mut s);
    cpu.bus.save(&mut s);
    cpu.bus.ppu.save(&mut s);
    cpu.bus.timer.save(&mut s);
    cpu.bus.cart.save(&mut s);
    let (regs, wave) = b.split_at_mut(0x30);
    let power = cpu.bus.apu.save(regs.try_into().unwrap(), wave.try_into().unwrap());
    n[APU_POWER] = if power { 1.0 } else { 0.0 };
    n[HAS_RTC] = 1.0;
}

fn load_from(cpu: &mut Cpu, n: &mut [f64; STATE_NUMS_LEN], b: &[u8; 0x40]) {
    let power = n[APU_POWER] == 1.0;
    let has_rtc = n[HAS_RTC] == 1.0;
    let regs: [u8; 0x30] = b[..0x30].try_into().unwrap();
    let wave: [u8; 16] = b[0x30..].try_into().unwrap();
    let mut s = State::new(&mut n[..]);
    cpu.load(&mut s);
    cpu.bus.load(&mut s);
    cpu.bus.ppu.load(&mut s);
    cpu.bus.apu.load(&regs, &wave, power);
    cpu.bus.timer.load(&mut s);
    cpu.bus.cart.load(&mut s, has_rtc);
}

/// Fill the state scratch areas. Memory blocks (WRAM, VRAM, ...) are read
/// directly through their views.
#[no_mangle]
pub extern "C" fn save_state() {
    save_into(gb(), nums(), bytes());
}

/// Restore from the scratch areas, after the host has written the memory blocks.
#[no_mangle]
pub extern "C" fn load_state() {
    load_from(gb(), nums(), bytes());
}

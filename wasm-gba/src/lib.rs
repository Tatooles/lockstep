// Lockstep's Game Boy Advance core (spike), compiled to Wasm with a small C ABI
// in the same style as wasm-core/. No BIOS image: SWIs are emulated in Rust.
//
// Memory is only allocated in `alloc` and `init`. After that nothing grows the
// Wasm heap, so typed-array views the host takes over it stay valid.

pub mod apu;
pub mod bios;
pub mod cpu;
pub mod gba;
pub mod ppu;
pub mod rtc;
pub mod save;
pub mod sys;

use gba::Gba;

static mut GBA: *mut Gba = core::ptr::null_mut();
static mut STATE: *mut u8 = core::ptr::null_mut();

#[inline(always)]
fn gba() -> &'static mut Gba {
    unsafe { &mut *GBA }
}

/// Reserve `len` bytes for the host to copy a ROM into.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

/// Build a GBA from a ROM previously copied into `alloc(len)`. The ROM buffer
/// is kept for the life of the module.
#[no_mangle]
pub extern "C" fn init(ptr: *mut u8, len: usize) {
    let rom: &'static [u8] = unsafe { core::slice::from_raw_parts(ptr, len) };
    unsafe {
        if GBA.is_null() {
            GBA = Box::into_raw(Gba::new_boxed(rom));
            STATE = Box::into_raw(vec![0u8; core::mem::size_of::<Gba>()].into_boxed_slice()) as *mut u8;
        } else {
            (*GBA).power_on(rom);
        }
    }
}

/// Power cycle, keeping save memory.
#[no_mangle]
pub extern "C" fn reset() {
    let g = gba();
    let rom = g.sys.rom_slice();
    g.power_on(rom);
}

/// Run to the next VBlank. Returns 1 if stopped at a hook address instead
/// (call again to continue the frame), 0 when the frame is done.
#[no_mangle]
pub extern "C" fn run_frame() -> u32 {
    gba().run_frame()
}

#[no_mangle]
pub extern "C" fn frame_ptr() -> *const u32 {
    gba().sys.ppu.frame.as_ptr()
}

/// Buttons, active high: A B Select Start Right Left Up Down R L (bits 0..9).
#[no_mangle]
pub extern "C" fn set_keys(mask: u32) {
    gba().sys.set_keys(mask as u16);
}

#[no_mangle]
pub extern "C" fn cycles() -> f64 {
    gba().sys.now as f64
}

// ---- CPU ----

/// 0..15 = r0..r15 (r15 = next instruction), 16 = CPSR.
#[no_mangle]
pub extern "C" fn reg(i: u32) -> u32 {
    let c = &gba().cpu;
    match i {
        15 => c.next_pc(),
        0..=14 => c.r[i as usize],
        16 => c.get_cpsr(),
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn set_reg(i: u32, v: u32) {
    if i < 15 {
        gba().cpu.r[i as usize] = v;
    }
}

// ---- hooks ----

#[no_mangle]
pub extern "C" fn hook_add(addr: u32) -> u32 {
    gba().hooks.add(addr) as u32
}

#[no_mangle]
pub extern "C" fn hook_clear() {
    gba().hooks.clear();
}

#[no_mangle]
pub extern "C" fn hook_hit() -> u32 {
    gba().hooks.hit
}

// ---- memory ----

/// Side-effect-free reads (IO reads are plain register reads).
#[no_mangle]
pub extern "C" fn peek8(addr: u32) -> u32 {
    gba().sys.read8_raw(addr)
}

#[no_mangle]
pub extern "C" fn peek16(addr: u32) -> u32 {
    gba().sys.read16_raw(addr)
}

#[no_mangle]
pub extern "C" fn peek32(addr: u32) -> u32 {
    gba().sys.read32_raw(addr)
}

#[no_mangle]
pub extern "C" fn poke8(addr: u32, v: u32) {
    gba().sys.write8_raw(addr, v as u8);
}

#[no_mangle]
pub extern "C" fn poke16(addr: u32, v: u32) {
    gba().sys.write16_raw(addr, v as u16);
}

#[no_mangle]
pub extern "C" fn poke32(addr: u32, v: u32) {
    gba().sys.write32_raw(addr, v);
}

#[no_mangle]
pub extern "C" fn ewram_ptr() -> *mut u8 {
    gba().sys.ewram.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn iwram_ptr() -> *mut u8 {
    gba().sys.iwram.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn vram_ptr() -> *mut u8 {
    gba().sys.vram.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn palette_ptr() -> *mut u8 {
    gba().sys.palette.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn oam_ptr() -> *mut u8 {
    gba().sys.oam.as_mut_ptr()
}

// ---- cartridge save ----

#[no_mangle]
pub extern "C" fn save_ptr() -> *mut u8 {
    gba().sys.save.data.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn save_len() -> u32 {
    gba().sys.save.len() as u32
}

#[no_mangle]
pub extern "C" fn save_kind() -> u32 {
    gba().sys.save.kind as u32
}

#[no_mangle]
pub extern "C" fn save_dirty() -> u32 {
    gba().sys.save.dirty as u32
}

#[no_mangle]
pub extern "C" fn set_save_dirty(v: u32) {
    gba().sys.save.dirty = v != 0;
}

/// Local wall-clock time for the cartridge RTC, in seconds since 1970.
#[no_mangle]
pub extern "C" fn set_time(unix_local: f64) {
    gba().sys.rtc.unix = unix_local;
}

// ---- audio ----

#[no_mangle]
pub extern "C" fn set_audio(enabled: u32) {
    gba().sys.apu.output = enabled != 0;
}

#[no_mangle]
pub extern "C" fn audio_ptr() -> *const f32 {
    gba().sys.apu.buffer.as_ptr()
}

#[no_mangle]
pub extern "C" fn audio_write_pos() -> u32 {
    gba().sys.apu.write_pos
}

#[no_mangle]
pub extern "C" fn audio_read_pos() -> u32 {
    gba().sys.apu.read_pos
}

#[no_mangle]
pub extern "C" fn audio_set_read_pos(p: u32) {
    gba().sys.apu.read_pos = p;
}

// ---- save states ----
// A state is the machine's bytes: the struct holds no pointers but the ROM's,
// which load_state keeps. Only valid for the same build of the core.

#[no_mangle]
pub extern "C" fn state_size() -> u32 {
    core::mem::size_of::<Gba>() as u32
}

#[no_mangle]
pub extern "C" fn state_ptr() -> *mut u8 {
    unsafe { STATE }
}

#[no_mangle]
pub extern "C" fn save_state() {
    unsafe {
        core::ptr::copy_nonoverlapping(GBA as *const u8, STATE, core::mem::size_of::<Gba>());
    }
}

#[no_mangle]
pub extern "C" fn load_state() {
    let g = gba();
    let (rom, rom_len) = (g.sys.rom, g.sys.rom_len);
    unsafe {
        core::ptr::copy_nonoverlapping(STATE as *const u8, GBA as *mut u8, core::mem::size_of::<Gba>());
    }
    let g = gba();
    g.sys.rom = rom;
    g.sys.rom_len = rom_len;
}

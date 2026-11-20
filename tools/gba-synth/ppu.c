// PPU feature scenes, for diffing our renderer against mGBA's. Each scene is
// static for 64 frames (scene = frame / 64 % 4):
//   0  mode 1: text BG0 over a rotated, scaled, wrapping affine BG2; normal,
//      flipped, 8bpp, affine and double-size sprites; a semi-transparent
//      sprite; BG0 alpha-blended over BG2.
//   1  mode 0: three BGs at different priorities, WIN0, WIN1 and an OBJ window
//      with different layer masks, brighten inside WIN0 only.
//   2  mode 0: BG mosaic and darken.
//   3  mode 3 bitmap with sprites (tiles from 512 up).
// Build: node tools/gba-synth/build.ts -> roms/ppu-scenes.gba

typedef unsigned int u32;
typedef unsigned short u16;
typedef unsigned char u8;
typedef int s32;
typedef short s16;

#define R16(a) (*(volatile u16 *)(a))
#define R32(a) (*(volatile u32 *)(a))
#define VRAM16 ((volatile u16 *)0x6000000)
#define VRAM32 ((volatile u32 *)0x6000000)
#define PAL ((volatile u16 *)0x5000000)
#define OAM ((volatile u16 *)0x7000000)

static volatile u32 vblanks;

__attribute__((section(".iwram"), target("arm"), noinline)) void irq_handler(void) {
  u16 f = R16(0x4000202) & R16(0x4000200);
  R16(0x4000202) = f;
  R16(0x3007FF8) |= f;
  if (f & 1) vblanks++;
}

// Signed division for the EABI runtime, in case the compiler emits a call.
int __aeabi_idiv(int a, int b) {
  int neg = (a < 0) ^ (b < 0);
  u32 ua = a < 0 ? -a : a, ub = b < 0 ? -b : b, q = 0;
  for (int bit = 31; bit >= 0; bit--)
    if ((ua >> bit) >= ub) {
      ua -= ub << bit;
      q |= 1u << bit;
    }
  return neg ? -(int)q : (int)q;
}

void *memcpy(void *d, const void *s, u32 n) {
  u8 *dd = d;
  const u8 *ss = s;
  while (n--) *dd++ = *ss++;
  return d;
}

void *memset(void *d, int v, u32 n) {
  u8 *dd = d;
  while (n--) *dd++ = (u8)v;
  return d;
}

// sin(i * 2pi / 256) * 256 for i in 0..64, by symmetry for the rest.
static const s16 sin_q[65] = {0,   6,   13,  19,  25,  31,  38,  44,  50,  56,  62,  68,  74,  80,  86,  92,  98,
                              104, 109, 115, 121, 126, 132, 137, 142, 147, 152, 157, 162, 167, 172, 177, 181, 185,
                              190, 194, 198, 202, 206, 209, 213, 216, 220, 223, 226, 229, 231, 234, 237, 239, 241,
                              243, 245, 247, 248, 250, 251, 252, 253, 254, 255, 255, 256, 256, 256};

static s32 isin(u32 a) {
  a &= 255;
  if (a < 64) return sin_q[a];
  if (a < 128) return sin_q[128 - a];
  if (a < 192) return -sin_q[a - 128];
  return -sin_q[256 - a];
}

static s32 icos(u32 a) { return isin(a + 64); }

static void clear_oam(void) {
  for (int i = 0; i < 128; i++) OAM[i * 4] = 0x0200;
}

static void sprite(int i, u16 a0, u16 a1, u16 a2) {
  OAM[i * 4] = a0;
  OAM[i * 4 + 1] = a1;
  OAM[i * 4 + 2] = a2;
}

static void affine(int g, u32 angle, s32 scale) {
  s32 c = icos(angle), s = isin(angle);
  OAM[g * 16 + 3] = (u16)(c * 256 / scale);
  OAM[g * 16 + 7] = (u16)(-s * 256 / scale);
  OAM[g * 16 + 11] = (u16)(s * 256 / scale);
  OAM[g * 16 + 15] = (u16)(c * 256 / scale);
}

static void load_common(void) {
  // BG palette: 16 banks of gradients; OBJ palette likewise, shifted.
  for (int i = 0; i < 256; i++) {
    PAL[i] = (u16)(((i * 7) & 31) | (((i * 3) & 31) << 5) | (((255 - i) >> 3) << 10));
    PAL[256 + i] = (u16)((((i * 5) + 9) & 31) << 10 | ((i * 11) & 31) << 5 | ((i >> 3) & 31));
  }
  PAL[0] = 0x2108;
  // 4bpp BG tiles 0..63 at char base 0: stripes, checks, rings, with holes (color 0).
  for (int t = 0; t < 64; t++)
    for (int r = 0; r < 8; r++) {
      u32 row = 0;
      for (int c = 0; c < 8; c++) {
        u32 p;
        switch (t & 3) {
          case 0: p = (c + r + t) & 15; break;
          case 1: p = ((c ^ r) & 4) ? (t & 15) : 0; break;
          case 2: p = ((c - 4) * (c - 4) + (r - 4) * (r - 4) < 10) ? 0 : ((c + t) & 15); break;
          default: p = (r == c || r == 7 - c) ? 15 : (c > r ? 3 : 0);
        }
        row |= p << (c * 4);
      }
      VRAM32[t * 8 + r] = row;
    }
  // 8bpp BG tiles 0..31 at char base 2 (0x8000), for the affine BG.
  volatile u8 *b8 = (volatile u8 *)0x6008000;
  for (int t = 0; t < 32; t++)
    for (int i = 0; i < 64; i += 2) {
      int r = i / 8, c = i % 8;
      u8 p0 = (u8)(((t * 8 + r * 3 + c) & 0xFF) | 1), p1 = (u8)((t * 8 + r * 3 + c + 1) | 1);
      if ((t & 7) == 3 && r > 2 && r < 6) p0 = p1 = 0;
      *(volatile u16 *)(b8 + t * 64 + i) = p0 | (p1 << 8);
    }
  // OBJ tiles: 4bpp tiles 0..63 at 0x6010000, 8bpp from tile 64, and the same
  // patterns from tile 512 (0x6014000) for bitmap modes.
  for (int base = 0; base <= 512; base += 512)
    for (int t = 0; t < 128; t++)
      for (int r = 0; r < 8; r++) {
        u32 row = 0;
        for (int c = 0; c < 8; c++) {
          u32 p = ((r - 3) * (r - 3) + (c - 3) * (c - 3) < 12) ? ((t + c) & 15) : ((t & 1) && c == r ? 9 : 0);
          row |= p << (c * 4);
        }
        VRAM32[0x4000 + (base + t) * 8 + r] = row;
      }
}

static void scene0(void) {
  R16(0x4000000) = 0x1540 | 1;  // mode 1, BG0, BG2, OBJ, 1D
  R16(0x4000008) = (28 << 8) | 0 | 1;           // BG0: 4bpp, screen 28, prio 1
  R16(0x400000C) = (30 << 8) | (2 << 2) | (1 << 14) | 0x2000 | 2;  // BG2: affine 256x256, wrap, prio 2
  for (int i = 0; i < 1024; i++) VRAM16[28 * 0x400 + i] = (u16)((i % 5 == 0) ? 0 : ((i * 7) & 63) | ((i & 3) << 10) | ((i & 7) << 12));
  volatile u8 *m = (volatile u8 *)(0x6000000 + 30 * 0x800);
  for (int i = 0; i < 1024; i += 2) *(volatile u16 *)(m + i) = (u16)(((i * 3) & 31) | (((i * 5 + 1) & 31) << 8));
  R16(0x4000010) = 13;
  R16(0x4000012) = 21;
  s32 a = 21, sc = 320;  // 30 degrees, 1.25x
  R16(0x4000020) = (u16)(icos(a) * 256 / sc);
  R16(0x4000022) = (u16)(-isin(a) * 256 / sc);
  R16(0x4000024) = (u16)(isin(a) * 256 / sc);
  R16(0x4000026) = (u16)(icos(a) * 256 / sc);
  R32(0x4000028) = (u32)(-40 * 256);
  R32(0x400002C) = (u32)(17 << 8);
  clear_oam();
  sprite(0, 20 | 0x0000, 10 | 0x8000, 0 | (1 << 10) | (2 << 12));          // 32x32 4bpp
  sprite(1, 20, 60 | 0x8000 | 0x1000, 0 | (1 << 10) | (3 << 12));          // hflip
  sprite(2, 70 | 0x2000 | 0x8000, 20 | 0x4000, 64 | (0 << 10));            // 16x32 8bpp (tall)
  sprite(3, 60 | 0x0300, 100 | 0x8000 | (1 << 9), 0 | (5 << 12));          // affine double 32x32
  affine(1, 40, 200);
  sprite(4, 100 | 0x0100, 170 | 0x4000 | (2 << 9), 8 | (6 << 12));         // affine 32x16
  affine(2, 200, 300);
  sprite(5, 110 | 0x0400, 60 | 0x8000, 16 | (0 << 10) | (7 << 12));        // semi-transparent
  sprite(6, 150, 230 | 0x4000, 4);                                         // straddles the right edge
  sprite(7, 250, 500 | 0x4000, 4);                                         // wraps at the top/left
  R16(0x4000050) = 0x0001 | 0x40 | (0x04 << 8) | (0x20 << 8);  // BG0 over BG2+backdrop
  R16(0x4000052) = 10 | (6 << 8);
}

static void scene1(void) {
  R16(0x4000000) = 0x0B40 | 0xE000 | 0x1000;  // mode 0, BG0 BG1 BG3 OBJ, WIN0 WIN1 OBJWIN
  R16(0x4000008) = (28 << 8) | 2;
  R16(0x400000A) = (29 << 8) | 1 | (1 << 14);  // 512x256
  R16(0x400000E) = (27 << 8) | 0;
  for (int i = 0; i < 1024; i++) {
    VRAM16[28 * 0x400 + i] = (u16)((i & 1) ? (i & 63) : 0) | ((i & 15) << 12);
    VRAM16[29 * 0x400 + i] = (u16)((i % 3) ? ((i * 3) & 63) : 0) | (((i >> 5) & 15) << 12) | ((i & 32) ? 0x400 : 0) | ((i & 64) ? 0x800 : 0);
    VRAM16[30 * 0x400 + i] = (u16)((i * 5) & 63);
    VRAM16[27 * 0x400 + i] = (u16)((i % 7) ? ((i * 11) & 63) : 0) | (((i >> 6) & 15) << 12);
  }
  R16(0x4000010) = 3;
  R16(0x4000012) = 5;
  R16(0x4000014) = 300;
  R16(0x4000016) = 11;
  R16(0x400001C) = 7;
  R16(0x400001E) = 2;
  R16(0x4000040) = (40 << 8) | 120;   // WIN0 x 40..120
  R16(0x4000044) = (30 << 8) | 100;   // WIN0 y 30..100
  R16(0x4000042) = (200 << 8) | 60;   // WIN1 x wraps: 200..240, 0..60
  R16(0x4000046) = (80 << 8) | 150;
  R16(0x4000048) = (0x31) | (0x02 << 8);  // WIN0: BG0+OBJ+effects, WIN1: BG1
  R16(0x400004A) = (0x0A) | (0x21 << 8);  // outside: BG1+BG3, OBJ window: BG0+effects
  clear_oam();
  sprite(0, 50 | 0x0800 | 0x8000 * 0, 150 | 0xC000, 0);  // 64x64 OBJ window sprite
  sprite(1, 60, 70 | 0x8000, 4 | (1 << 10));             // normal sprite inside WIN0
  sprite(2, 110, 20 | 0x8000, 12 | (2 << 10));
  R16(0x4000050) = 0x0003 | 0x80;  // brighten BG0+BG1
  R16(0x4000054) = 8;
}

static void scene2(void) {
  R16(0x4000000) = 0x0340 | 0x1000;  // mode 0, BG0 BG1 OBJ
  R16(0x4000008) = (28 << 8) | 0x40 | 1;  // BG0 with mosaic
  R16(0x400000A) = (29 << 8) | 0;
  R16(0x400004C) = 3 | (2 << 4);  // BG mosaic 4x3
  R16(0x4000010) = 0;
  R16(0x4000012) = 0;
  R16(0x4000014) = 0;
  R16(0x4000016) = 0;
  clear_oam();
  sprite(0, 40, 40 | 0x8000, 0);
  sprite(1, 90, 150 | 0x8000, 4 | (3 << 10));
  R16(0x4000050) = 0x0002 | 0x10 | 0xC0;  // darken BG1 and OBJ
  R16(0x4000054) = 11;
}

static void scene3(void) {
  R16(0x4000000) = 3 | 0x0400 | 0x1000 | 0x40;  // mode 3, BG2, OBJ
  R16(0x4000020) = 0x100;
  R16(0x4000022) = 0;
  R16(0x4000024) = 0;
  R16(0x4000026) = 0x100;
  R32(0x4000028) = 0;
  R32(0x400002C) = 0;
  for (int y = 0; y < 160; y++)
    for (int x = 0; x < 240; x++) VRAM16[y * 240 + x] = (u16)((x >> 3) | ((y >> 3) << 5) | (((x + y) >> 4) << 10));
  clear_oam();
  sprite(0, 30, 30 | 0x8000, 512);
  sprite(1, 70 | 0x0100, 120 | 0x8000 | (3 << 9), 520 | (4 << 12));
  affine(3, 100, 256);
  R16(0x4000050) = 0;
}

int main(void) {
  R16(0x4000000) = 0x80;
  load_common();
  R32(0x3007FFC) = (u32)irq_handler;
  R16(0x4000004) = 8;
  R16(0x4000200) = 1;
  R16(0x4000208) = 1;
  int shown = -1;
  for (;;) {
    __asm__ volatile("swi 0x05" ::: "r0", "r1", "r2", "r3", "memory");
    int scene = (int)(vblanks / 64) & 3;
    if (scene != shown) {
      shown = scene;
      R16(0x4000000) = 0x80;
      if (scene == 0) scene0();
      else if (scene == 1) scene1();
      else if (scene == 2) scene2();
      else scene3();
    }
  }
}

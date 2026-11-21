// A synthetic "overworld" workload for benchmarking the GBA core without a
// commercial ROM. It does the kinds of work a Gen 3 Pokémon frame does:
// Thumb game logic running from ROM, a sample mixer in ARM code in IWRAM fed to
// Direct Sound by timer + DMA (like m4a), a scrolling tile map streamed into
// VRAM, 128 sprites, shadow OAM/BG buffers copied by DMA in VBlank, and
// VBlankIntrWait between frames. Build: node tools/gba-synth/build.ts

typedef unsigned int u32;
typedef unsigned short u16;
typedef unsigned char u8;
typedef signed char s8;
typedef int s32;
typedef short s16;

#define R16(a) (*(volatile u16 *)(a))
#define R32(a) (*(volatile u32 *)(a))
#define DISPCNT R16(0x4000000)
#define DISPSTAT R16(0x4000004)
#define BG0CNT R16(0x4000008)
#define BG1CNT R16(0x400000A)
#define BG0HOFS R16(0x4000010)
#define BG0VOFS R16(0x4000012)
#define BG1HOFS R16(0x4000014)
#define BG1VOFS R16(0x4000016)
#define BLDCNT R16(0x4000050)
#define BLDALPHA R16(0x4000052)
#define SOUNDCNT_H R16(0x4000082)
#define SOUNDCNT_X R16(0x4000084)
#define FIFO_A 0x40000A0
#define DMA1SAD R32(0x40000BC)
#define DMA1DAD R32(0x40000C0)
#define DMA1CNT R32(0x40000C4)
#define DMA3SAD R32(0x40000D4)
#define DMA3DAD R32(0x40000D8)
#define DMA3CNT R32(0x40000DC)
#define TM0CNT_L R16(0x4000100)
#define TM0CNT_H R16(0x4000102)
#define KEYINPUT R16(0x4000130)
#define IE R16(0x4000200)
#define IF R16(0x4000202)
#define WAITCNT R16(0x4000204)
#define IME R16(0x4000208)
#define BIOS_IF R16(0x3007FF8)
#define IRQ_VECTOR R32(0x3007FFC)

#define IWRAM_CODE __attribute__((section(".iwram"), target("arm"), noinline))
#define EWRAM __attribute__((section(".ewram")))

static inline __attribute__((unused)) void vblank_wait(void) { __asm__ volatile("swi 0x05" ::: "r0", "r1", "r2", "r3", "memory"); }

static volatile unsigned int vblanks;

// BUSYWAIT builds spin on a counter the VBlank handler bumps, as some games
// (and, reportedly, Gen 3 Pokémon) do, instead of halting in VBlankIntrWait.
static void wait_frame(void) {
#ifdef BUSYWAIT
  unsigned int v = vblanks;
  while (vblanks == v)
    ;
#else
  vblank_wait();
#endif
}

static void dma3(const void *src, volatile void *dst, u32 words) {
  DMA3SAD = (u32)src;
  DMA3DAD = (u32)dst;
  DMA3CNT = words | 0x84000000;
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

// ---- world ----

#define WORLD 128
static EWRAM u16 world[WORLD * WORLD];
static EWRAM u16 bg_shadow[32 * 32];
static EWRAM u16 oam_shadow[128 * 4];
static u32 rng = 12345;
static u32 frame;

static u32 rand(void) {
  rng = rng * 1103515245u + 12345u;
  return rng >> 16;
}

typedef struct {
  s32 x, y;   // 20.8 fixed point, world pixels
  s32 vx, vy;
  u16 timer;
  u8 state;
  u8 tile;
  u16 hp;
  u16 facing;
} Obj;

#define NOBJ 96
static EWRAM Obj objs[NOBJ];

static int solid(s32 px, s32 py) {
  u32 tx = ((u32)px >> 3) & (WORLD - 1);
  u32 ty = ((u32)py >> 3) & (WORLD - 1);
  return (world[ty * WORLD + tx] & 0x3FF) >= 48;
}

static void update_objects(void) {
  for (int i = 0; i < NOBJ; i++) {
    Obj *o = &objs[i];
    if (o->timer == 0) {
      u32 r = rand();
      o->state = r & 3;
      o->timer = 16 + (r >> 4 & 63);
      static const s8 dx[4] = {1, -1, 0, 0}, dy[4] = {0, 0, 1, -1};
      o->vx = dx[o->state] * 192;
      o->vy = dy[o->state] * 192;
      o->facing = o->state;
    }
    o->timer--;
    s32 nx = o->x + o->vx, ny = o->y + o->vy;
    if (solid(nx >> 8, ny >> 8) || solid((nx >> 8) + 15, (ny >> 8) + 15)) {
      o->vx = -o->vx;
      o->vy = -o->vy;
      o->timer = 1;
    } else {
      o->x = nx;
      o->y = ny;
    }
  }
  // Pairwise proximity checks among the first 40 (trainer sight lines, etc.).
  for (int i = 0; i < 40; i++) {
    for (int j = i + 1; j < 40; j++) {
      s32 ddx = (objs[i].x - objs[j].x) >> 8, ddy = (objs[i].y - objs[j].y) >> 8;
      if (ddx < 0) ddx = -ddx;
      if (ddy < 0) ddy = -ddy;
      if (ddx + ddy < 24) {
        objs[i].hp++;
        objs[j].hp--;
      }
    }
  }
}

static void build_oam(s32 camx, s32 camy) {
  int n = 0;
  for (int i = 0; i < NOBJ; i++) {
    s32 sx = (objs[i].x >> 8) - camx, sy = (objs[i].y >> 8) - camy;
    if (sx < -16 || sx >= 240 || sy < -16 || sy >= 160) continue;
    u16 *e = &oam_shadow[n * 4];
    e[0] = (sy & 0xFF) | 0x0000;           // 16x16, 4bpp
    e[1] = (sx & 0x1FF) | 0x4000 | (objs[i].facing == 1 ? 0x1000 : 0);
    e[2] = (objs[i].tile + objs[i].facing * 4) | ((i & 3) << 12) | (1 << 10);
    n++;
  }
  for (; n < 128; n++) oam_shadow[n * 4] = 0x0200;  // hidden
}

// Stream the 32x32 visible window of the world into the BG shadow map (the
// game copies only changed rows/columns; we copy the dirty column and row).
static void stream_map(s32 camx, s32 camy) {
  u32 tx0 = (u32)camx >> 3, ty0 = (u32)camy >> 3;
  for (int r = 0; r < 21; r++) {
    u32 ty = (ty0 + r) & (WORLD - 1);
    u16 *dst = &bg_shadow[((ty0 + r) & 31) * 32];
    const u16 *src = &world[ty * WORLD];
    for (int c = 0; c < 31; c++) {
      u32 tx = (tx0 + c) & (WORLD - 1);
      dst[(tx0 + c) & 31] = src[tx];
    }
  }
}

// ---- sound (ARM, IWRAM, like m4a's SoundMainRAM) ----

#define MIX_LEN 224  // 13379 Hz / 59.73
#define NCHAN 8
typedef struct {
  const s8 *wave;
  u32 pos, step, len;
  s32 vol;
} Chan;
static Chan chans[NCHAN];
static s8 mixbuf[2][MIX_LEN] __attribute__((aligned(4)));
static s32 acc[MIX_LEN];
static s8 waves[4][256];

IWRAM_CODE void mix(s8 *out) {
  for (int i = 0; i < MIX_LEN; i++) acc[i] = 0;
  for (int c = 0; c < NCHAN; c++) {
    Chan *ch = &chans[c];
    const s8 *w = ch->wave;
    u32 pos = ch->pos, step = ch->step, len = ch->len;
    s32 vol = ch->vol;
    for (int i = 0; i < MIX_LEN; i++) {
      acc[i] += w[pos >> 16] * vol;
      pos += step;
      if (pos >= len) pos -= len;
    }
    ch->pos = pos;
  }
  for (int i = 0; i < MIX_LEN; i++) {
    s32 v = acc[i] >> 8;
    out[i] = v > 127 ? 127 : v < -128 ? -128 : v;
  }
}

IWRAM_CODE void irq_handler(void) {
  u16 f = IF & IE;
  IF = f;
  BIOS_IF |= f;
  if (f & 1) vblanks++;
}

int main(void) {
  WAITCNT = 0x4317;
  // Tiles: 64 procedural 4bpp tiles at char base 0, 16 sprite tiles at 0x6010000.
  volatile u32 *vram = (volatile u32 *)0x6000000;
  for (int t = 0; t < 64; t++)
    for (int r = 0; r < 8; r++) vram[t * 8 + r] = 0x11111111u * ((t + r) & 15) ^ (r * 0x01010101u);
  volatile u32 *objv = (volatile u32 *)0x6010000;
  for (int t = 0; t < 64; t++)
    for (int r = 0; r < 8; r++) objv[t * 8 + r] = (r & 1) ? 0x01234560u : 0x06543210u;
  volatile u16 *pal = (volatile u16 *)0x5000000;
  for (int i = 0; i < 512; i++) pal[i] = (u16)(i * 0x0421 + 7);
  for (int i = 0; i < WORLD * WORLD; i++) world[i] = (u16)(rand() % 56) | ((i & 7) << 12);
  for (int i = 0; i < NOBJ; i++) {
    objs[i].x = (rand() % 1024) << 8;
    objs[i].y = (rand() % 1024) << 8;
    objs[i].tile = 0;
  }
  // Static BG1 (like the overworld's top layer), blended over BG0.
  volatile u16 *map1 = (volatile u16 *)(0x6000000 + 30 * 0x800);
  for (int i = 0; i < 1024; i++) map1[i] = (i % 7 == 0) ? (u16)(i & 63) : 0;
  BG0CNT = (31 << 8) | 1;
  BG1CNT = (30 << 8);
  BLDCNT = 0x0142;  // BG1 alpha over BG0
  BLDALPHA = 0x0A06;
  DISPCNT = 0x1340;  // mode 0, BG0+BG1+OBJ, 1D OBJ

  // Sound: 13379 Hz timer 0, FIFO A from mixbuf via DMA1.
  for (int w = 0; w < 4; w++)
    for (int i = 0; i < 256; i++) waves[w][i] = (s8)((w & 1) ? (i < 128 ? 100 : -100) : ((i * (w + 1)) & 255) - 128);
  for (int c = 0; c < NCHAN; c++) {
    chans[c].wave = waves[c & 3];
    chans[c].len = 256 << 16;
    chans[c].step = (1 << 16) + c * 0x3000;
    chans[c].vol = 24 + c * 4;
  }
  SOUNDCNT_X = 0x80;
  SOUNDCNT_H = 0x0B0E;  // FIFO A 100%, L+R, timer 0, reset
  TM0CNT_L = 65536 - 1254;
  TM0CNT_H = 0x80;
#ifdef PSG
  // Also keep all four PSG channels playing (Pokémon's music uses them).
  R16(0x4000080) = 0xFF77;              // all channels L+R, max volume
  SOUNDCNT_H = 0x0B0E | 2;              // PSG at 100%
  for (int i = 0; i < 8; i++) R16(0x4000090 + i * 2) = (u16)(0x0123 * (i + 1));
  R16(0x4000070) = 0x80;                // wave DAC on
#endif

  IRQ_VECTOR = (u32)irq_handler;
  DISPSTAT = 8;
  IE = 1;
  IME = 1;

  int buf = 0;
  for (;;) {
    frame++;
    s32 camx = (frame * 3 / 2) & 1023, camy = (frame / 2) & 1023;
    update_objects();
    mix(mixbuf[buf]);
    stream_map(camx, camy);
    build_oam(camx, camy);
#ifdef PSG
    if ((frame & 15) == 0) {
      u16 f = (u16)(1200 + (rand() & 511));
      R16(0x4000062) = 0xF780;            // ch1: duty 50%, volume 15, slow decay
      R16(0x4000064) = f | 0x8000;
      R16(0x4000068) = 0xF740;            // ch2
      R16(0x400006C) = (f + 300) | 0x8000;
      R16(0x4000072) = 0x2000;            // ch3: 100% volume
      R16(0x4000074) = (f - 400) | 0x8000;
      R16(0x4000078) = 0xA200;            // ch4: noise
      R16(0x400007C) = 0x8021;
    }
#endif
    if ((frame & 63) == 0) {
      // Occasional bulk work: recolor part of the palette (fades, weather).
      for (int i = 0; i < 256; i++) pal[i] = (u16)(pal[i] + 0x21);
    }
    wait_frame();
    // VBlank: shadow buffers to VRAM/OAM, scroll, restart the sound DMA.
    dma3(oam_shadow, (volatile void *)0x7000000, 256);
    dma3(bg_shadow, (volatile void *)(0x6000000 + 31 * 0x800), 512);
    BG0HOFS = camx;
    BG0VOFS = camy;
    DMA1CNT = 0;
    DMA1SAD = (u32)mixbuf[buf];
    DMA1DAD = FIFO_A;
    DMA1CNT = 0xB6000000;  // enable, special (FIFO), repeat, 32-bit
    buf ^= 1;
  }
}

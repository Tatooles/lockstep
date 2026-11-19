// DMG PPU: dot-based mode timing with a scanline renderer.

import { INT_STAT, INT_VBLANK, SCREEN_H, SCREEN_W } from './constants.ts';

export interface PpuState {
  vram: Uint8Array;
  oam: Uint8Array;
  regs: number[];
}

export class Ppu {
  readonly vram = new Uint8Array(0x2000);
  readonly oam = new Uint8Array(0xa0);
  /** Final shades (0 = lightest .. 3 = darkest), one byte per pixel. */
  readonly frame = new Uint8Array(SCREEN_W * SCREEN_H);
  /** Set when VBlank begins; host clears it after presenting. */
  frameReady = false;
  /** Incremented every completed frame. */
  frameCount = 0;

  lcdc = 0x91;
  stat = 0x85;
  scy = 0;
  scx = 0;
  ly = 0;
  lyc = 0;
  bgp = 0xfc;
  obp0 = 0xff;
  obp1 = 0xff;
  wy = 0;
  wx = 0;

  private mode = 1;
  private dot = 400;
  private mode3Len = 172;
  private statLine = false;
  private windowLine = 0;
  private wyTriggered = false;
  private requestInterrupt: (bit: number) => void;

  // Scratch buffers for line rendering.
  private bgIdx = new Uint8Array(SCREEN_W);
  private spriteBuf = new Int16Array(10);

  constructor(requestInterrupt: (bit: number) => void) {
    this.requestInterrupt = requestInterrupt;
    this.ly = 0;
    this.mode = 2;
    this.dot = 0;
  }

  get lcdOn(): boolean {
    return (this.lcdc & 0x80) !== 0;
  }

  /** Effective LY (line 153 reads 0 after the first few dots). */
  private lyValue(): number {
    return this.ly === 153 && this.dot >= 4 ? 0 : this.ly;
  }

  /** Advance one M-cycle (4 dots). */
  tick(): void {
    if (!(this.lcdc & 0x80)) return;
    const d = (this.dot += 4);
    // The STAT line only changes on mode/line transitions (register writes
    // re-evaluate it separately), so skip the check on quiet cycles.
    let changed = false;
    if (this.ly < 144) {
      if (this.mode === 2) {
        if (d >= 80) {
          this.mode = 3;
          this.renderLine();
          changed = true;
        }
      } else if (this.mode === 3) {
        if (d >= 80 + this.mode3Len) {
          this.mode = 0;
          changed = true;
        }
      }
      if (d >= 456) {
        this.dot -= 456;
        this.ly++;
        changed = true;
        if (this.ly === 144) {
          this.mode = 1;
          this.requestInterrupt(INT_VBLANK);
          this.frameReady = true;
          this.frameCount++;
        } else {
          this.startLine();
        }
      }
    } else if (d >= 456) {
      this.dot -= 456;
      this.ly++;
      changed = true;
      if (this.ly > 153) {
        this.ly = 0;
        this.windowLine = 0;
        this.wyTriggered = false;
        this.startLine();
      }
    } else if (d === 4 && (this.ly === 144 || this.ly === 153)) {
      // End of the line-144 OAM quirk; line 153 starts reading LY=0.
      changed = true;
    }
    if (changed) this.updateStat();
  }

  private startLine(): void {
    this.mode = 2;
    if (this.ly === this.wy) this.wyTriggered = true;
  }

  private updateStat(): void {
    const ly = this.lyValue();
    const coincide = ly === this.lyc;
    const s = this.stat;
    const line =
      (coincide && (s & 0x40) !== 0) ||
      (this.mode === 0 && (s & 0x08) !== 0) ||
      (this.mode === 1 && (s & 0x10) !== 0) ||
      (this.mode === 2 && (s & 0x20) !== 0) ||
      (this.mode === 1 && this.ly === 144 && this.dot < 4 && (s & 0x20) !== 0);
    if (line && !this.statLine) this.requestInterrupt(INT_STAT);
    this.statLine = line;
  }

  read(addr: number): number {
    switch (addr) {
      case 0xff40:
        return this.lcdc;
      case 0xff41: {
        if (!this.lcdOn) return 0x80 | (this.stat & 0x78);
        const coincide = this.lyValue() === this.lyc ? 4 : 0;
        // The HBlank interrupt fires one M-cycle before STAT reports mode 0.
        let mode = this.mode;
        if (mode === 0 && this.ly < 144 && this.dot < 84 + this.mode3Len) mode = 3;
        else if (mode === 3 && this.dot < 84) mode = 2;
        return 0x80 | (this.stat & 0x78) | coincide | mode;
      }
      case 0xff42:
        return this.scy;
      case 0xff43:
        return this.scx;
      case 0xff44:
        return this.lcdOn ? this.lyValue() : 0;
      case 0xff45:
        return this.lyc;
      case 0xff47:
        return this.bgp;
      case 0xff48:
        return this.obp0;
      case 0xff49:
        return this.obp1;
      case 0xff4a:
        return this.wy;
      case 0xff4b:
        return this.wx;
    }
    return 0xff;
  }

  write(addr: number, val: number): void {
    switch (addr) {
      case 0xff40: {
        const wasOn = this.lcdOn;
        this.lcdc = val;
        if (wasOn && !this.lcdOn) {
          this.ly = 0;
          this.dot = 0;
          this.mode = 0;
          this.windowLine = 0;
          this.wyTriggered = false;
          // A blank (white) screen while the LCD is off.
          this.frame.fill(0);
        } else if (!wasOn && this.lcdOn) {
          this.ly = 0;
          this.dot = 4; // LCD restarts slightly into line 0
          this.startLine();
          this.updateStat();
        }
        break;
      }
      case 0xff41:
        this.stat = (this.stat & 0x87) | (val & 0x78);
        if (this.lcdOn) this.updateStat();
        break;
      case 0xff42:
        this.scy = val;
        break;
      case 0xff43:
        this.scx = val;
        break;
      case 0xff44:
        break; // read-only
      case 0xff45:
        this.lyc = val;
        if (this.lcdOn) this.updateStat();
        break;
      case 0xff47:
        this.bgp = val;
        break;
      case 0xff48:
        this.obp0 = val;
        break;
      case 0xff49:
        this.obp1 = val;
        break;
      case 0xff4a:
        this.wy = val;
        break;
      case 0xff4b:
        this.wx = val;
        break;
    }
  }

  private renderLine(): void {
    const ly = this.ly;
    const lcdc = this.lcdc;
    const vram = this.vram;
    const frame = this.frame;
    const rowBase = ly * SCREEN_W;
    const bgIdx = this.bgIdx;
    const bgp = this.bgp;
    const unsignedTiles = (lcdc & 0x10) !== 0;

    // --- Background & window ---
    if (lcdc & 0x01) {
      const bgMap = lcdc & 0x08 ? 0x1c00 : 0x1800;
      const y = (ly + this.scy) & 0xff;
      const tileRow = (y >> 3) << 5;
      const fineY = (y & 7) << 1;
      const winOn = (lcdc & 0x20) !== 0 && this.wyTriggered && this.wx <= 166;
      const winX = this.wx - 7;
      let x = 0;
      const bgEnd = winOn ? Math.max(0, Math.min(SCREEN_W, winX)) : SCREEN_W;
      for (; x < bgEnd; x++) {
        const px = (x + this.scx) & 0xff;
        const tile = vram[bgMap + tileRow + (px >> 3)];
        const addr = unsignedTiles ? tile << 4 : 0x1000 + (((tile << 24) >> 24) << 4);
        const lo = vram[addr + fineY];
        const hi = vram[addr + fineY + 1];
        const bit = 7 - (px & 7);
        const c = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        bgIdx[x] = c;
        frame[rowBase + x] = (bgp >> (c << 1)) & 3;
      }
      if (winOn && x < SCREEN_W) {
        const winMap = lcdc & 0x40 ? 0x1c00 : 0x1800;
        const wy = this.windowLine;
        const wRow = (wy >> 3) << 5;
        const wFine = (wy & 7) << 1;
        for (; x < SCREEN_W; x++) {
          const px = x - winX;
          const tile = vram[winMap + wRow + (px >> 3)];
          const addr = unsignedTiles ? tile << 4 : 0x1000 + (((tile << 24) >> 24) << 4);
          const lo = vram[addr + wFine];
          const hi = vram[addr + wFine + 1];
          const bit = 7 - (px & 7);
          const c = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
          bgIdx[x] = c;
          frame[rowBase + x] = (bgp >> (c << 1)) & 3;
        }
        this.windowLine++;
      }
    } else {
      for (let x = 0; x < SCREEN_W; x++) {
        bgIdx[x] = 0;
        frame[rowBase + x] = 0;
      }
    }

    // --- Sprites ---
    let count = 0;
    const height = lcdc & 0x04 ? 16 : 8;
    const oam = this.oam;
    const buf = this.spriteBuf;
    for (let i = 0; i < 40 && count < 10; i++) {
      const sy = oam[i << 2] - 16;
      if (ly >= sy && ly < sy + height) buf[count++] = i;
    }
    this.mode3Len = 172 + (this.scx & 7) + count * 6;
    if (!(lcdc & 0x02) || count === 0) return;

    // Priority: lower X first, then lower OAM index (insertion sort, stable).
    for (let i = 1; i < count; i++) {
      const v = buf[i];
      const vx = oam[(v << 2) + 1];
      let j = i - 1;
      while (j >= 0 && oam[(buf[j] << 2) + 1] > vx) {
        buf[j + 1] = buf[j];
        j--;
      }
      buf[j + 1] = v;
    }

    // Draw lowest priority first so higher priority overwrites.
    for (let n = count - 1; n >= 0; n--) {
      const o = buf[n] << 2;
      const sy = oam[o] - 16;
      const sx = oam[o + 1] - 8;
      let tile = oam[o + 2];
      const attr = oam[o + 3];
      let row = ly - sy;
      if (attr & 0x40) row = height - 1 - row;
      if (height === 16) tile &= 0xfe;
      const addr = (tile << 4) + (row << 1);
      const lo = vram[addr];
      const hi = vram[addr + 1];
      const pal = attr & 0x10 ? this.obp1 : this.obp0;
      const behind = (attr & 0x80) !== 0;
      const flipX = (attr & 0x20) !== 0;
      for (let p = 0; p < 8; p++) {
        const x = sx + p;
        if (x < 0 || x >= SCREEN_W) continue;
        const bit = flipX ? p : 7 - p;
        const c = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        if (c === 0) continue;
        // Higher-priority sprite pixels always replace lower ones; BG priority
        // is decided by the winning sprite. Track that with a marker in bgIdx.
        if (behind && (bgIdx[x] & 3) !== 0) {
          // Restore BG pixel (a lower-priority sprite may have drawn here).
          frame[rowBase + x] = (this.bgp >> ((bgIdx[x] & 3) << 1)) & 3;
          continue;
        }
        frame[rowBase + x] = (pal >> (c << 1)) & 3;
      }
    }
  }

  saveState(): PpuState {
    return {
      vram: this.vram.slice(),
      oam: this.oam.slice(),
      regs: [
        this.lcdc, this.stat, this.scy, this.scx, this.ly, this.lyc, this.bgp, this.obp0, this.obp1,
        this.wy, this.wx, this.mode, this.dot, this.mode3Len, this.statLine ? 1 : 0, this.windowLine,
        this.wyTriggered ? 1 : 0,
      ],
    };
  }

  loadState(s: PpuState): void {
    this.vram.set(s.vram);
    this.oam.set(s.oam);
    const r = s.regs;
    [this.lcdc, this.stat, this.scy, this.scx, this.ly, this.lyc, this.bgp, this.obp0, this.obp1,
      this.wy, this.wx, this.mode, this.dot, this.mode3Len] = r;
    this.statLine = r[14] === 1;
    this.windowLine = r[15];
    this.wyTriggered = r[16] === 1;
  }
}

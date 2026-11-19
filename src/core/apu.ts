// DMG APU: 2 square channels, wave channel, noise channel, frame sequencer.

const DUTY = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
];
const NOISE_DIV = [8, 16, 32, 48, 64, 80, 96, 112];
const READ_MASK = [
  0x80, 0x3f, 0x00, 0xff, 0xbf, // NR10-NR14
  0xff, 0x3f, 0x00, 0xff, 0xbf, // NR20-NR24
  0x7f, 0xff, 0x9f, 0xff, 0xbf, // NR30-NR34
  0xff, 0xff, 0x00, 0x00, 0xbf, // NR40-NR44
  0x00, 0x00, 0x70, // NR50-NR52
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // FF27-FF2F
];
const M_CYCLES_PER_SEC = 1048576;

class Envelope {
  initial = 0;
  up = false;
  period = 0;
  volume = 0;
  timer = 0;
  write(v: number): void {
    this.initial = v >> 4;
    this.up = (v & 8) !== 0;
    this.period = v & 7;
  }
  trigger(): void {
    this.volume = this.initial;
    this.timer = this.period || 8;
  }
  clock(): void {
    if (this.period === 0) return;
    if (--this.timer <= 0) {
      this.timer = this.period || 8;
      if (this.up && this.volume < 15) this.volume++;
      else if (!this.up && this.volume > 0) this.volume--;
    }
  }
}

class Square {
  enabled = false;
  dacOn = false;
  duty = 0;
  pos = 0;
  length = 0;
  lengthEnable = false;
  freq = 0;
  timer = 0;
  env = new Envelope();
  // Sweep (channel 1 only)
  hasSweep: boolean;
  sweepPeriod = 0;
  sweepNegate = false;
  sweepShift = 0;
  sweepTimer = 0;
  sweepEnabled = false;
  shadow = 0;
  negUsed = false;

  constructor(hasSweep: boolean) {
    this.hasSweep = hasSweep;
  }

  step(t: number): void {
    this.timer -= t;
    while (this.timer <= 0) {
      this.timer += (2048 - this.freq) * 4;
      this.pos = (this.pos + 1) & 7;
    }
  }

  output(): number {
    if (!this.enabled) return 0;
    return DUTY[this.duty][this.pos] ? this.env.volume : 0;
  }

  clockLength(): void {
    if (this.lengthEnable && this.length > 0 && --this.length === 0) this.enabled = false;
  }

  private calcSweep(): number {
    let f = this.shadow >> this.sweepShift;
    if (this.sweepNegate) {
      f = this.shadow - f;
      this.negUsed = true;
    } else f = this.shadow + f;
    if (f > 2047) this.enabled = false;
    return f;
  }

  clockSweep(): void {
    if (--this.sweepTimer <= 0) {
      this.sweepTimer = this.sweepPeriod || 8;
      if (this.sweepEnabled && this.sweepPeriod) {
        const f = this.calcSweep();
        if (f <= 2047 && this.sweepShift) {
          this.freq = this.shadow = f;
          this.calcSweep();
        }
      }
    }
  }

  writeSweep(v: number): void {
    const wasNeg = this.sweepNegate;
    this.sweepPeriod = (v >> 4) & 7;
    this.sweepNegate = (v & 8) !== 0;
    this.sweepShift = v & 7;
    if (wasNeg && !this.sweepNegate && this.negUsed) this.enabled = false;
  }

  trigger(): void {
    this.enabled = this.dacOn;
    if (this.length === 0) this.length = 64;
    this.timer = (2048 - this.freq) * 4;
    this.env.trigger();
    if (this.hasSweep) {
      this.shadow = this.freq;
      this.sweepTimer = this.sweepPeriod || 8;
      this.sweepEnabled = this.sweepPeriod !== 0 || this.sweepShift !== 0;
      this.negUsed = false;
      if (this.sweepShift) this.calcSweep();
    }
  }
}

class Wave {
  enabled = false;
  dacOn = false;
  length = 0;
  lengthEnable = false;
  freq = 0;
  timer = 0;
  pos = 0;
  volShift = 0;
  sample = 0;
  readonly ram = new Uint8Array(16);

  step(t: number): void {
    this.timer -= t;
    while (this.timer <= 0) {
      this.timer += (2048 - this.freq) * 2;
      this.pos = (this.pos + 1) & 31;
      const b = this.ram[this.pos >> 1];
      this.sample = this.pos & 1 ? b & 0x0f : b >> 4;
    }
  }

  output(): number {
    if (!this.enabled || this.volShift === 0) return 0;
    return this.sample >> (this.volShift - 1);
  }

  clockLength(): void {
    if (this.lengthEnable && this.length > 0 && --this.length === 0) this.enabled = false;
  }

  trigger(): void {
    this.enabled = this.dacOn;
    if (this.length === 0) this.length = 256;
    this.timer = (2048 - this.freq) * 2 + 6;
    this.pos = 0;
  }
}

class Noise {
  enabled = false;
  dacOn = false;
  length = 0;
  lengthEnable = false;
  timer = 0;
  shift = 0;
  width7 = false;
  divCode = 0;
  lfsr = 0x7fff;
  env = new Envelope();

  period(): number {
    return NOISE_DIV[this.divCode] << this.shift;
  }

  step(t: number): void {
    this.timer -= t;
    while (this.timer <= 0) {
      this.timer += this.period();
      const x = (this.lfsr & 1) ^ ((this.lfsr >> 1) & 1);
      this.lfsr = (this.lfsr >> 1) | (x << 14);
      if (this.width7) this.lfsr = (this.lfsr & ~0x40) | (x << 6);
    }
  }

  output(): number {
    if (!this.enabled) return 0;
    return this.lfsr & 1 ? 0 : this.env.volume;
  }

  clockLength(): void {
    if (this.lengthEnable && this.length > 0 && --this.length === 0) this.enabled = false;
  }

  trigger(): void {
    this.enabled = this.dacOn;
    if (this.length === 0) this.length = 64;
    this.timer = this.period();
    this.lfsr = 0x7fff;
    this.env.trigger();
  }
}

export class Apu {
  private ch1 = new Square(true);
  private ch2 = new Square(false);
  private ch3 = new Wave();
  private ch4 = new Noise();
  private regs = new Uint8Array(0x30);
  private power = true;
  private seqTimer = 0;
  private seqStep = 0;
  private nr50 = 0x77;
  private nr51 = 0xf3;

  // Output resampling
  sampleRate = 48000;
  /** When false the APU still runs but produces no samples (e.g. fast-forward). */
  outputEnabled = true;
  /** Per-channel mute for the host UI. */
  channelMask = 0b1111;
  private acc = 0;
  private mixPhase = 0;
  private sumL = 0;
  private sumR = 0;
  private sumN = 0;
  private hpL = 0;
  private hpR = 0;
  private hpPrevL = 0;
  private hpPrevR = 0;
  readonly buffer = new Float32Array(16384); // interleaved stereo ring
  private writePos = 0;
  private readPos = 0;

  constructor() {
    this.reset();
  }

  private reset(): void {
    // Post-boot register state.
    const init: [number, number][] = [
      [0xff10, 0x80], [0xff11, 0xbf], [0xff12, 0xf3], [0xff14, 0xbf], [0xff16, 0x3f],
      [0xff17, 0x00], [0xff19, 0xbf], [0xff1a, 0x7f], [0xff1b, 0xff], [0xff1c, 0x9f],
      [0xff1e, 0xbf], [0xff20, 0xff], [0xff21, 0x00], [0xff22, 0x00], [0xff23, 0xbf],
      [0xff24, 0x77], [0xff25, 0xf3],
    ];
    for (const [a, v] of init) this.write(a, v);
    this.ch1.enabled = false;
    this.ch2.enabled = false;
    this.ch3.enabled = false;
    this.ch4.enabled = false;
  }

  /** Advance one M-cycle. */
  tick(): void {
    if (this.power) {
      this.ch1.step(4);
      this.ch2.step(4);
      this.ch3.step(4);
      this.ch4.step(4);
      if (++this.seqTimer >= 2048) {
        this.seqTimer = 0;
        this.clockSequencer();
      }
    }
    if (!this.outputEnabled) return;
    // Mix at 1/4 of the M-cycle rate (~262 kHz): plenty of headroom above the
    // output rate for the box filter, at a quarter of the cost.
    if (++this.mixPhase & 3) return;
    this.mix();
  }

  private clockSequencer(): void {
    const s = this.seqStep;
    if ((s & 1) === 0) {
      this.ch1.clockLength();
      this.ch2.clockLength();
      this.ch3.clockLength();
      this.ch4.clockLength();
    }
    if (s === 2 || s === 6) this.ch1.clockSweep();
    if (s === 7) {
      this.ch1.env.clock();
      this.ch2.env.clock();
      this.ch4.env.clock();
    }
    this.seqStep = (s + 1) & 7;
  }

  private mix(): void {
    let l = 0;
    let r = 0;
    if (this.power) {
      const m = this.channelMask;
      const o1 = m & 1 && this.ch1.dacOn ? this.ch1.output() / 7.5 - 1 : 0;
      const o2 = m & 2 && this.ch2.dacOn ? this.ch2.output() / 7.5 - 1 : 0;
      const o3 = m & 4 && this.ch3.dacOn ? this.ch3.output() / 7.5 - 1 : 0;
      const o4 = m & 8 && this.ch4.dacOn ? this.ch4.output() / 7.5 - 1 : 0;
      const p = this.nr51;
      if (p & 0x10) l += o1;
      if (p & 0x20) l += o2;
      if (p & 0x40) l += o3;
      if (p & 0x80) l += o4;
      if (p & 0x01) r += o1;
      if (p & 0x02) r += o2;
      if (p & 0x04) r += o3;
      if (p & 0x08) r += o4;
      l *= (((this.nr50 >> 4) & 7) + 1) / 8;
      r *= ((this.nr50 & 7) + 1) / 8;
    }
    this.sumL += l;
    this.sumR += r;
    this.sumN++;
    this.acc += this.sampleRate * 4;
    if (this.acc >= M_CYCLES_PER_SEC) {
      this.acc -= M_CYCLES_PER_SEC;
      const avgL = this.sumL / this.sumN / 4;
      const avgR = this.sumR / this.sumN / 4;
      this.sumL = this.sumR = this.sumN = 0;
      // DC-blocking high-pass filter.
      const a = 0.996;
      const outL = avgL - this.hpPrevL + a * this.hpL;
      const outR = avgR - this.hpPrevR + a * this.hpR;
      this.hpPrevL = avgL;
      this.hpPrevR = avgR;
      this.hpL = outL;
      this.hpR = outR;
      const buf = this.buffer;
      const next = (this.writePos + 2) % buf.length;
      if (next !== this.readPos) {
        buf[this.writePos] = outL;
        buf[this.writePos + 1] = outR;
        this.writePos = next;
      }
    }
  }

  /** Number of stereo frames buffered. */
  available(): number {
    const n = this.buffer.length;
    return ((this.writePos - this.readPos + n) % n) >> 1;
  }

  /** Copy up to `frames` stereo frames into left/right arrays. Returns frames copied. */
  drain(left: Float32Array, right: Float32Array, frames: number): number {
    const buf = this.buffer;
    let i = 0;
    while (i < frames && this.readPos !== this.writePos) {
      left[i] = buf[this.readPos];
      right[i] = buf[this.readPos + 1];
      this.readPos = (this.readPos + 2) % buf.length;
      i++;
    }
    return i;
  }

  clearBuffer(): void {
    this.readPos = this.writePos;
  }

  read(addr: number): number {
    if (addr >= 0xff30 && addr <= 0xff3f) return this.ch3.ram[addr - 0xff30];
    const i = addr - 0xff10;
    if (i < 0 || i >= READ_MASK.length) return 0xff;
    if (addr === 0xff26) {
      return (
        (this.power ? 0x80 : 0) |
        0x70 |
        (this.ch1.enabled ? 1 : 0) |
        (this.ch2.enabled ? 2 : 0) |
        (this.ch3.enabled ? 4 : 0) |
        (this.ch4.enabled ? 8 : 0)
      );
    }
    return this.regs[i] | READ_MASK[i];
  }

  write(addr: number, v: number): void {
    if (addr >= 0xff30 && addr <= 0xff3f) {
      this.ch3.ram[addr - 0xff30] = v;
      return;
    }
    if (addr === 0xff26) {
      const on = (v & 0x80) !== 0;
      if (this.power && !on) {
        for (let a = 0xff10; a <= 0xff25; a++) this.write(a, 0);
        this.ch1.enabled = this.ch2.enabled = this.ch3.enabled = this.ch4.enabled = false;
        this.power = false;
      } else if (!this.power && on) {
        this.power = true;
        this.seqStep = 0;
        this.ch1.pos = this.ch2.pos = 0;
      }
      return;
    }
    const i = addr - 0xff10;
    if (i < 0 || i >= 0x17) return;
    // While powered off only length registers are writable (DMG).
    if (!this.power) {
      if (addr === 0xff11) this.ch1.length = 64 - (v & 0x3f);
      else if (addr === 0xff16) this.ch2.length = 64 - (v & 0x3f);
      else if (addr === 0xff1b) this.ch3.length = 256 - v;
      else if (addr === 0xff20) this.ch4.length = 64 - (v & 0x3f);
      return;
    }
    this.regs[i] = v;
    const nextStepClocksLength = (this.seqStep & 1) === 1;
    switch (addr) {
      case 0xff10:
        this.ch1.writeSweep(v);
        break;
      case 0xff11:
        this.ch1.duty = v >> 6;
        this.ch1.length = 64 - (v & 0x3f);
        break;
      case 0xff12:
        this.ch1.env.write(v);
        this.ch1.dacOn = (v & 0xf8) !== 0;
        if (!this.ch1.dacOn) this.ch1.enabled = false;
        break;
      case 0xff13:
        this.ch1.freq = (this.ch1.freq & 0x700) | v;
        break;
      case 0xff14:
        this.ch1.freq = (this.ch1.freq & 0xff) | ((v & 7) << 8);
        this.lengthEnableWrite(this.ch1, v, nextStepClocksLength, 64);
        if (v & 0x80) {
          this.ch1.trigger();
          if (this.ch1.lengthEnable && this.ch1.length === 64 && nextStepClocksLength) this.ch1.length--;
        }
        break;
      case 0xff16:
        this.ch2.duty = v >> 6;
        this.ch2.length = 64 - (v & 0x3f);
        break;
      case 0xff17:
        this.ch2.env.write(v);
        this.ch2.dacOn = (v & 0xf8) !== 0;
        if (!this.ch2.dacOn) this.ch2.enabled = false;
        break;
      case 0xff18:
        this.ch2.freq = (this.ch2.freq & 0x700) | v;
        break;
      case 0xff19:
        this.ch2.freq = (this.ch2.freq & 0xff) | ((v & 7) << 8);
        this.lengthEnableWrite(this.ch2, v, nextStepClocksLength, 64);
        if (v & 0x80) {
          this.ch2.trigger();
          if (this.ch2.lengthEnable && this.ch2.length === 64 && nextStepClocksLength) this.ch2.length--;
        }
        break;
      case 0xff1a:
        this.ch3.dacOn = (v & 0x80) !== 0;
        if (!this.ch3.dacOn) this.ch3.enabled = false;
        break;
      case 0xff1b:
        this.ch3.length = 256 - v;
        break;
      case 0xff1c:
        this.ch3.volShift = (v >> 5) & 3;
        break;
      case 0xff1d:
        this.ch3.freq = (this.ch3.freq & 0x700) | v;
        break;
      case 0xff1e:
        this.ch3.freq = (this.ch3.freq & 0xff) | ((v & 7) << 8);
        this.lengthEnableWrite(this.ch3, v, nextStepClocksLength, 256);
        if (v & 0x80) {
          this.ch3.trigger();
          if (this.ch3.lengthEnable && this.ch3.length === 256 && nextStepClocksLength) this.ch3.length--;
        }
        break;
      case 0xff20:
        this.ch4.length = 64 - (v & 0x3f);
        break;
      case 0xff21:
        this.ch4.env.write(v);
        this.ch4.dacOn = (v & 0xf8) !== 0;
        if (!this.ch4.dacOn) this.ch4.enabled = false;
        break;
      case 0xff22:
        this.ch4.shift = v >> 4;
        this.ch4.width7 = (v & 8) !== 0;
        this.ch4.divCode = v & 7;
        break;
      case 0xff23:
        this.lengthEnableWrite(this.ch4, v, nextStepClocksLength, 64);
        if (v & 0x80) {
          this.ch4.trigger();
          if (this.ch4.lengthEnable && this.ch4.length === 64 && nextStepClocksLength) this.ch4.length--;
        }
        break;
      case 0xff24:
        this.nr50 = v;
        break;
      case 0xff25:
        this.nr51 = v;
        break;
    }
  }

  /** Length-enable write with the "extra length clock" quirk. */
  private lengthEnableWrite(
    ch: { lengthEnable: boolean; length: number; enabled: boolean },
    v: number,
    nextStepClocksLength: boolean,
    _max: number,
  ): void {
    const was = ch.lengthEnable;
    ch.lengthEnable = (v & 0x40) !== 0;
    if (!was && ch.lengthEnable && nextStepClocksLength && ch.length > 0) {
      if (--ch.length === 0 && !(v & 0x80)) ch.enabled = false;
    }
  }

  saveState(): { regs: Uint8Array; wave: Uint8Array; power: boolean } {
    return { regs: this.regs.slice(), wave: this.ch3.ram.slice(), power: this.power };
  }

  loadState(s: { regs: Uint8Array; wave: Uint8Array; power: boolean }): void {
    this.power = true;
    for (let i = 0; i < 0x17; i++) {
      const a = 0xff10 + i;
      if (a === 0xff14 || a === 0xff19 || a === 0xff1e || a === 0xff23) {
        this.write(a, s.regs[i] & 0x7f);
      } else this.write(a, s.regs[i]);
    }
    this.ch3.ram.set(s.wave);
    if (!s.power) this.write(0xff26, 0);
  }
}

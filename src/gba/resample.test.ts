import { describe, expect, it } from 'vitest';
import { RingResampler } from './resample.ts';

/** A ring of `len` floats holding stereo frames (L = v, R = -v) for values starting at `read`. */
function ring(len: number, read: number, values: number[]): { buf: Float32Array; write: number } {
  const buf = new Float32Array(len);
  let w = read;
  for (const v of values) {
    buf[w] = v;
    buf[w + 1] = -v;
    w = (w + 2) % len;
  }
  return { buf, write: w };
}

describe('RingResampler', () => {
  it('passes samples through at a 1:1 ratio, one frame behind', () => {
    const rs = new RingResampler();
    const { buf, write } = ring(16, 0, [1, 2, 3, 4]);
    const { l, r } = rs.drain(buf, 0, write, 1);
    expect([...l]).toEqual([0, 1, 2, 3]);
    expect([...r].map((v) => v + 0)).toEqual([0, -1, -2, -3]);
    const next = ring(16, write, [5, 6]);
    expect([...rs.drain(next.buf, write, next.write, 1).l]).toEqual([4, 5]);
  });

  it('interpolates when upsampling and wraps around the ring', () => {
    const rs = new RingResampler();
    const { buf, write } = ring(8, 6, [2, 4, 6]);
    const { l } = rs.drain(buf, 6, write, 0.5);
    expect([...l]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps the output rate across uneven chunks', () => {
    const rs = new RingResampler();
    const step = 32768 / 48000;
    let read = 0;
    let out = 0;
    const len = 1024;
    for (const n of [100, 37, 250, 1, 0, 300]) {
      const { buf, write } = ring(len, read, Array.from({ length: n }, () => 0.5));
      out += rs.drain(buf, read, write, step).l.length;
      read = write;
    }
    expect(Math.abs(out - 688 / step)).toBeLessThan(1.01);
  });
});

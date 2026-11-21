// Linear resampler from the GBA core's audio ring (interleaved stereo floats
// at 32768 Hz) to the output device's rate.

export class RingResampler {
  /** Position between the last frame of the previous drain (0) and the first new one (1). */
  private t = 0;
  private lastL = 0;
  private lastR = 0;

  /**
   * Consume ring[read, write) and return it at `step` input frames per output
   * frame (input rate / output rate). The last input frame is kept to
   * interpolate across calls.
   */
  drain(ring: Float32Array, read: number, write: number, step: number): { l: Float32Array; r: Float32Array } {
    const len = ring.length;
    const n = ((write - read + len) % len) >> 1;
    // Output frames at positions t, t + step, ... while still inside the input.
    const count = this.t < n ? Math.ceil((n - this.t) / step) : 0;
    const l = new Float32Array(count);
    const r = new Float32Array(count);
    let t = this.t;
    for (let k = 0; k < count; k++, t += step) {
      const i = Math.floor(t);
      const f = t - i;
      // Input frame j: j = 0 is the previous drain's last frame, j >= 1 is ring frame j - 1.
      const a = i === 0 ? -1 : (read + 2 * (i - 1)) % len;
      const b = (read + 2 * i) % len;
      const l0 = a < 0 ? this.lastL : ring[a];
      const r0 = a < 0 ? this.lastR : ring[a + 1];
      l[k] = l0 + (ring[b] - l0) * f;
      r[k] = r0 + (ring[b + 1] - r0) * f;
    }
    if (n > 0) {
      const last = (read + 2 * (n - 1)) % len;
      this.lastL = ring[last];
      this.lastR = ring[last + 1];
    }
    this.t = t - n;
    return { l, r };
  }

  reset(): void {
    this.t = 0;
    this.lastL = this.lastR = 0;
  }
}

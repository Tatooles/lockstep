// Web Audio output for the APU. Must be unlocked from a user gesture on iOS.

export class AudioOut {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;
  /** Frames currently queued in the worklet (reported asynchronously). */
  buffered = 0;
  volume = 0.8;
  private gain: GainNode | null = null;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get ready(): boolean {
    return this.node !== null && this.ctx?.state === 'running';
  }

  /** Create/resume the context. Call from a pointer/key handler. */
  unlock(): Promise<void> {
    if (this.ctx && this.node) {
      if (this.ctx.state !== 'running') return this.ctx.resume();
      return Promise.resolve();
    }
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx({ latencyHint: 'interactive' });
      this.ctx = ctx;
      // Resume synchronously within the gesture before awaiting anything else.
      const resumed = ctx.resume();
      await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}audio-worklet.js`);
      const node = new AudioWorkletNode(ctx, 'gb-output', { outputChannelCount: [2] });
      node.port.onmessage = (e) => {
        this.buffered = e.data as number;
      };
      const gain = ctx.createGain();
      gain.gain.value = this.volume;
      node.connect(gain).connect(ctx.destination);
      this.gain = gain;
      this.node = node;
      this.prime();
      await resumed;
    })().catch((err) => {
      console.warn('Audio unavailable', err);
      this.starting = null;
    });
    return this.starting;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  push(l: Float32Array, r: Float32Array): void {
    if (!this.node) return;
    this.node.port.postMessage({ l, r }, [l.buffer, r.buffer]);
    this.buffered += l.length;
  }

  clear(): void {
    this.node?.port.postMessage({ clear: true });
    this.buffered = 0;
    this.prime();
  }

  /** Queue a little silence so playback starts with headroom instead of underrunning. */
  private prime(ms = 50): void {
    if (!this.node) return;
    const n = Math.round((this.sampleRate * ms) / 1000);
    this.push(new Float32Array(n), new Float32Array(n));
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }
}

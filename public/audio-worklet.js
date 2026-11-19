// Ring-buffer player: the main thread posts stereo Float32 chunks; we play them
// back and report how much is buffered so the emulator can adjust its rate.
class GbOutput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 16384;
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.frames = 0;
    this.port.onmessage = (e) => {
      const { l, r, clear } = e.data;
      if (clear) {
        this.read = this.write;
        return;
      }
      for (let i = 0; i < l.length; i++) {
        const next = (this.write + 1) % this.size;
        if (next === this.read) this.read = (this.read + 1) % this.size; // drop oldest
        this.l[this.write] = l[i];
        this.r[this.write] = r[i];
        this.write = next;
      }
    };
  }

  buffered() {
    return (this.write - this.read + this.size) % this.size;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const ol = out[0];
    const or = out[1] ?? out[0];
    for (let i = 0; i < ol.length; i++) {
      if (this.read !== this.write) {
        ol[i] = this.l[this.read];
        or[i] = this.r[this.read];
        this.read = (this.read + 1) % this.size;
      } else {
        ol[i] = 0;
        or[i] = 0;
      }
    }
    if (++this.frames % 8 === 0) this.port.postMessage(this.buffered());
    return true;
  }
}

registerProcessor('gb-output', GbOutput);

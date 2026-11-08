// Runs in the audio thread. Converts mic Float32 samples to 16-bit PCM in ~40 ms chunks.
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(640);
    this.n = 0;
    this.sum = 0;
    this.count = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.sum += s * s;
      this.count++;
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage({ pcm: this.buf.slice().buffer, level: Math.sqrt(this.sum / this.count) });
        this.n = 0;
        this.sum = 0;
        this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PCMCapture);

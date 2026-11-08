/** Stateful box-filter resampling keeps fractional sample positions across worklet blocks. */
export class PcmResampler {
  constructor(inputRate, outputRate = 16000, frameSize = 512) {
    if (inputRate < outputRate) throw new Error('Microphone sample rate must be at least 16 kHz');
    this.ratio = inputRate / outputRate;
    this.frameSize = frameSize;
    this.frame = new Int16Array(frameSize);
    this.index = 0; this.weight = 0; this.sum = 0;
  }
  push(input, onFrame, muted = false) {
    for (let sample of input) {
      sample = muted ? 0 : Math.max(-1, Math.min(1, sample));
      let remaining = 1;
      while (remaining > 1e-9) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * take; this.weight += take; remaining -= take;
        if (this.weight >= this.ratio - 1e-9) {
          const value = this.sum / this.ratio;
          this.frame[this.index++] = Math.round(value * (value < 0 ? 32768 : 32767));
          this.sum = 0; this.weight = 0;
          if (this.index === this.frameSize) {
            const buffer = new ArrayBuffer(this.frameSize * 2);
            const view = new DataView(buffer);
            for (let i = 0; i < this.frameSize; i++) view.setInt16(i * 2, this.frame[i], true);
            onFrame(buffer); this.index = 0;
          }
        }
      }
    }
  }
}

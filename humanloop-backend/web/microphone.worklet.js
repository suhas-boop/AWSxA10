import { PcmResampler } from './pcm.mjs';
class MicrophoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new PcmResampler(sampleRate);
    this.muted = false;
    this.port.onmessage = event => { this.muted = event.data.muted; };
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples) this.resampler.push(samples, buffer => this.port.postMessage(buffer, [buffer]), this.muted);
    return true;
  }
}
registerProcessor('microphone-processor', MicrophoneProcessor);

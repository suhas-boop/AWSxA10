import microphoneWorkletUrl from './microphone.worklet.js?worker&url';
import { PcmPlayback } from './playback.mjs';

export class AudioSession {
  constructor(onFrame, onPlayback) { this.onFrame = onFrame; this.onPlayback = onPlayback; this.closed = false; }
  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires localhost or HTTPS.');
    this.context = new AudioContext();
    this.playback = new PcmPlayback(this.context, this.onPlayback);
    await this.context.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    if (this.closed) { this.stream.getTracks().forEach(track => track.stop()); return; }
    await this.context.audioWorklet.addModule(microphoneWorkletUrl);
    if (this.closed) return;
    this.input = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, 'microphone-processor');
    this.worklet.port.onmessage = event => this.onFrame(event.data);
    this.silent = this.context.createGain(); this.silent.gain.value = 0;
    this.input.connect(this.worklet); this.worklet.connect(this.silent); this.silent.connect(this.context.destination);
  }
  mute(value) { this.worklet?.port.postMessage({ muted: value }); }
  play(base64) {
    if (!this.closed) this.playback?.play(base64);
  }
  clear() { this.playback?.clear(); }
  async resume() {
    if (this.closed || this.context?.state === 'closed') throw new Error('Start a new voice check-in to reconnect the microphone.');
    await this.context?.resume();
  }
  async stop() {
    if (this.closed) return;
    this.closed = true; this.clear();
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.disconnect(); }
    this.input?.disconnect(); this.silent?.disconnect();
    if (this.context?.state !== 'closed') await this.context?.close();
  }
}

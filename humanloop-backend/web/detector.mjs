import WorkerURL from './detector.worker.mjs?worker&url';
export class SoundDetector {
  constructor(onObservation, onStatus) { this.onObservation = onObservation; this.onStatus = onStatus; this.pending = 0; this.ready = false; }
  async start() {
    const generation = Symbol('detector-start'); this.generation = generation;
    const manifest = await fetch('/models/manifest.json').then(r => r.json());
    if (this.generation !== generation) return;
    this.worker = new Worker(WorkerURL, { type: 'module' });
    this.timeout = setTimeout(() => this.fail(), 15000);
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'ready') { clearTimeout(this.timeout); this.ready = true; this.onStatus('active'); }
      if (data.type === 'ack') this.pending = Math.max(0, this.pending - 1);
      if (data.type === 'observation') this.onObservation(data.event, data.inferenceMs);
      if (data.type === 'error') this.fail();
    };
    this.worker.onerror = () => this.fail();
    this.worker.postMessage({ type: 'init', threshold: manifest.threshold });
  }
  frame(buffer, endMs) {
    if (!this.ready) return;
    if (this.pending++ > 64) { this.fail(); return; }
    const copy = buffer.slice(0);
    this.worker.postMessage({ type: 'frame', buffer: copy, endMs }, [copy]);
  }
  fail() { this.stop(); this.onStatus('unavailable'); }
  stop() { this.generation = null; clearTimeout(this.timeout); this.ready = false; this.pending = 0; this.worker?.terminate(); this.worker = null; }
}

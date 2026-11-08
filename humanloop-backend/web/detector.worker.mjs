import { AudioClassifier, FilesetResolver } from '@mediapipe/tasks-audio';
let classifier, samples = new Float32Array(0), baseMs = 0, sequence = 0, threshold = .35;
const windowSize = 15600, hop = 7680;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      threshold = data.threshold;
      const files = await FilesetResolver.forAudioTasks(new URL('/mediapipe', self.location.origin).href, true);
      classifier = await AudioClassifier.createFromOptions(files, { baseOptions: { modelAssetPath: new URL('/models/yamnet.tflite', self.location.origin).href }, maxResults: 521 });
      self.postMessage({ type: 'ready' }); return;
    }
    if (data.type === 'stop') { samples.fill(0); samples = new Float32Array(0); classifier?.close(); classifier = null; self.postMessage({ type: 'stopped' }); return; }
    if (data.type !== 'frame' || !classifier) return;
    const view = new DataView(data.buffer), input = new Float32Array(view.byteLength / 2);
    for (let i = 0; i < input.length; i++) input[i] = view.getInt16(i * 2, true) / 32768;
    if (!samples.length) baseMs = data.endMs - input.length / 16;
    const merged = new Float32Array(samples.length + input.length); merged.set(samples); merged.set(input, samples.length); samples.fill(0); samples = merged;
    while (samples.length >= windowSize) {
      const window = samples.slice(0, windowSize), started = performance.now();
      const categories = classifier.classify(window, 16000).flatMap(result => result.classifications.flatMap(head => head.categories));
      const clipped = window.some(value => Math.abs(value) > .995);
      for (const label of ['Cough', 'Throat clearing']) {
        const score = Math.max(0, ...categories.filter(c => c.categoryName === label).map(c => c.score));
        if (score >= threshold) self.postMessage({ type: 'observation', event: { window_id: `${++sequence}`, label, score, start_ms: Math.round(baseMs), end_ms: Math.round(baseMs + windowSize / 16), quality: clipped ? 'clipped' : 'uncertain' }, inferenceMs: performance.now() - started });
      }
      window.fill(0); const rest = samples.slice(hop); samples.fill(0); samples = rest; baseMs += hop / 16;
    }
    input.fill(0); self.postMessage({ type: 'ack' });
  } catch { self.postMessage({ type: 'error', message: 'Sound analysis is unavailable. You can still type or ask for human help.' }); }
};

import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile('data/acoustic/manifest.json'));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const results = [];
try {
  const page = await browser.newPage(); await page.goto('http://127.0.0.1:5173');
  // Development clips are processed first; held-out outcomes are never used to choose a threshold.
  let threshold = .35;
  for (const split of ['development', 'held-out']) {
    for (const item of manifest.items.filter(i => i.split === split)) {
      const buffer = await readFile(item.path); let pcm;
      for (let offset = 12; offset < buffer.length;) { const size = buffer.readUInt32LE(offset + 4); if (buffer.toString('ascii', offset, offset + 4) === 'data') { pcm = buffer.subarray(offset + 8, offset + 8 + size); break; } offset += 8 + size + size % 2; }
      const windows = await page.evaluate(async encoded => {
        const { default: workerUrl } = await import('/web/detector.worker.mjs?worker&url');
        return new Promise((resolve, reject) => {
          const worker = new Worker(workerUrl, { type: 'module' }), windows = new Map();
          const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Detector timed out')); }, 20000);
          worker.onerror = () => { clearTimeout(timeout); worker.terminate(); reject(new Error('Detector worker failed')); };
          worker.onmessage = ({ data }) => {
            if (data.type === 'ready') {
              const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
              worker.postMessage({ type: 'frame', buffer: bytes.buffer, endMs: bytes.length / 32 }, [bytes.buffer]);
            }
            if (data.type === 'observation') {
              const e = data.event, row = windows.get(e.start_ms) || { startMs: e.start_ms, inferenceMs: data.inferenceMs };
              row[e.label === 'Cough' ? 'cough' : 'throatClearing'] = e.score; windows.set(e.start_ms, row);
            }
            if (data.type === 'error') { clearTimeout(timeout); worker.terminate(); reject(new Error(data.message)); }
            if (data.type === 'ack') { clearTimeout(timeout); worker.terminate(); resolve([...windows.values()]); }
          };
          // Score capture only: production loads its frozen threshold from the model manifest.
          worker.postMessage({ type: 'init', threshold: 0 });
        });
      }, pcm.toString('base64'));
      results.push({ file: item.filename, category: item.category, split, seconds: pcm.length / 32000, windows });
    }
    if (split === 'development') {
      // Predeclared conservative candidate set; prioritize no false cough clips, then recall.
      const candidates = [.35, .5, .65, .8].map(t => ({ threshold: t, trueClips: results.filter(r => r.category === 'coughing' && r.windows.some(w => w.cough >= t)).length, falseClips: results.filter(r => r.category !== 'coughing' && r.windows.some(w => w.cough >= t)).length }));
      candidates.sort((a,b) => a.falseClips - b.falseClips || b.trueClips - a.trueClips || a.threshold - b.threshold);
      threshold = candidates[0].threshold;
      await writeFile('data/acoustic/threshold-freeze.json', JSON.stringify({ at: new Date().toISOString(), threshold, candidates, developmentFiles: results.map(r => r.file), scope: 'Tiny source-separated engineering smoke set; not clinical calibration' }, null, 2));
    }
  }
  const held = results.filter(r => r.split === 'held-out');
  let falseEvents = 0;
  for (const clip of held.filter(r => r.category !== 'coughing')) {
    let end = -Infinity;
    for (const w of clip.windows.filter(w => w.cough >= threshold)) { if (w.startMs > end + 300) falseEvents++; end = w.startMs + 975; }
  }
  const metrics = { threshold, heldOutCoughClips: held.filter(r => r.category === 'coughing').length, missedCoughClips: held.filter(r => r.category === 'coughing' && !r.windows.some(w => w.cough >= threshold)).length,
    nonCoughSeconds: held.filter(r => r.category !== 'coughing').reduce((s,r) => s + r.seconds, 0), falseMergedEvents: falseEvents };
  metrics.falseEventsPerMinute = falseEvents / (metrics.nonCoughSeconds / 60);
  await writeFile('data/acoustic-check.json', JSON.stringify({ at: new Date().toISOString(), metrics, limitations: ['Clip-level misses; no individual cough-event annotations', 'No independent speaker verification', 'No real room, television, throat-clearing, or microphone echo validation', 'Not evidence of clinical sensitivity or safety'], results }, null, 2));
  console.log(JSON.stringify(metrics));
} finally { await browser.close(); }

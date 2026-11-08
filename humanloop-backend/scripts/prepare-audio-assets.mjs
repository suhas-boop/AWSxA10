import { mkdir, readdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const acoustic = JSON.parse(await readFile('config/acoustic.json', 'utf8'));
await mkdir('public/models', { recursive: true });
await mkdir('public/mediapipe', { recursive: true });
for (const file of await readdir('node_modules/@mediapipe/tasks-audio/wasm')) await copyFile(`node_modules/@mediapipe/tasks-audio/wasm/${file}`, `public/mediapipe/${file}`);
const source = 'https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite';
let model;
try { model = await readFile('public/models/yamnet.tflite'); }
catch {
  const response = await fetch(source); if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
  model = Buffer.from(await response.arrayBuffer()); await writeFile('public/models/yamnet.tflite', model);
}
if (model.subarray(4, 8).toString() !== 'TFL3') throw new Error('Invalid model format');
if (createHash('sha256').update(model).digest('hex') !== '4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf') throw new Error('YAMNet asset checksum does not match the tested version');
const manifest = { name: 'YAMNet', source, sha256: createHash('sha256').update(model).digest('hex'), bytes: model.length,
  runtime: JSON.parse(await readFile('node_modules/@mediapipe/tasks-audio/package.json')).version,
  clinicalValidation: false, threshold: acoustic.threshold, thresholdStatus: acoustic.thresholdStatus, windowSamples: acoustic.windowSamples, hopSamples: acoustic.hopSamples, sampleRate: acoustic.sampleRate };
await writeFile('public/models/manifest.json', JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));

// Optional engineering fixtures only. Never records a user's microphone.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
if (process.platform !== 'darwin') throw new Error('Fixture conversion uses macOS say and afconvert');
const root = 'data/acoustic', base = 'https://raw.githubusercontent.com/karolpiczak/ESC-50/33c8ce9eb2cf0b1c2f8bcf322eb349b6be34dbb6/';
await mkdir(root, { recursive: true });
async function download(url, path) { try { return await readFile(path); } catch {} const r = await fetch(url); if (!r.ok) throw new Error(`Fixture download failed: ${r.status}`); const b = Buffer.from(await r.arrayBuffer()); await writeFile(path, b); return b; }
const csv = (await download(base + 'meta/esc50.csv', root + '/esc50.csv')).toString().trim().split(/\r?\n/);
const headers = csv.shift().split(','), rows = csv.map(line => Object.fromEntries(line.split(',').map((x,i) => [headers[i], x])));
const items = [];
for (const [split, fold] of [['development', '1'], ['held-out', '2']]) for (const category of ['coughing', 'laughing', 'breathing', 'sneezing']) {
  const sources = new Set();
  for (const row of rows.filter(r => r.fold === fold && r.category === category)) {
    if (sources.has(row.src_file)) continue; sources.add(row.src_file);
    const path = `${root}/${row.filename}`, converted = `${root}/16k-${row.filename}`;
    const bytes = await download(base + 'audio/' + row.filename, path);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', path, converted]);
    items.push({ ...row, split, path: converted, url: base + 'audio/' + row.filename, sha256: createHash('sha256').update(bytes).digest('hex') });
    if (sources.size === 4) break;
  }
}
await download(base + 'LICENSE', root + '/LICENSE');
await writeFile(root + '/manifest.json', JSON.stringify({ source: 'ESC-50', license: 'CC BY-NC 3.0; see downloaded LICENSE', limitations: 'Source-recording separated folds; speaker identity not verified. Clip labels only; cough-event boundaries not annotated.', items }, null, 2));
execFileSync('say', ['-o', 'data/voice-check.aiff', 'Hello CareAlong. I would like to talk about my day. How are you today?']);
execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', 'data/voice-check.aiff', 'data/voice-check.wav']);
function pcm(buffer) { for (let p = 12; p < buffer.length;) { const n = buffer.readUInt32LE(p + 4); if (buffer.toString('ascii', p, p + 4) === 'data') return buffer.subarray(p + 8, p + 8 + n); p += 8 + n + n % 2; } throw new Error('Missing WAV data'); }
const speech = pcm(await readFile('data/voice-check.wav')); await writeFile('data/voice-check.pcm', speech);
// A declared known positive from the initial evaluation; replay is not a new held-out sample.
const cough = pcm(await readFile(`${root}/16k-2-123896-A-24.wav`));
const sound = Buffer.concat([Buffer.alloc(160000), speech, Buffer.alloc(16000), cough, Buffer.alloc(32000 * 100)]);
const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + sound.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(sound.length, 40);
await writeFile('data/browser-microphone-fixture.wav', Buffer.concat([header, sound]));
console.log('Prepared 32 attributed acoustic fixtures and labeled synthetic speech/browser audio. No live microphone audio was recorded.');

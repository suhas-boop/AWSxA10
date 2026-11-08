// Sustained real Bedrock conversation with generated speech, no human microphone recording.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const origin = process.env.CAREALONG_URL || 'http://127.0.0.1:8080';
const breathingCheck = process.argv.includes('--breathing-answer');
const lines = breathingCheck ? ["I have a cough.", "It's new.", 'Not severe but a little bit uncomfortable.'] : ['Hello, my name is Daniel. Can you hear me?', 'I spent this morning planting flowers in my garden.', 'I planted yellow roses. What flowers do you like?', 'My granddaughter visited and helped me water the plants.', 'We had tea together afterwards and talked about her school.', 'I feel happy after our visit. What could we talk about next?'];
await mkdir('data/conversation', { recursive: true });
const clips = [];
for (let i = 0; i < lines.length; i++) {
  const base = `data/conversation/${breathingCheck ? 'breathing' : 'turn'}-${i}`;
  try { clips.push(await readFile(base + '.pcm')); continue; } catch {}
  execFileSync('say', ['-o', base + '.aiff', lines[i]]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', base + '.aiff', base + '.wav']);
  const b = await readFile(base + '.wav');
  for (let p = 12; p < b.length;) { const n = b.readUInt32LE(p + 4); if (b.toString('ascii', p, p + 4) === 'data') { clips.push(b.subarray(p + 8, p + 8 + n)); break; } p += 8 + n + n % 2; }
  await writeFile(base + '.pcm', clips.at(-1));
}
const secrets = JSON.parse(await readFile('.carealong-secrets.json'));
let token, run, heartbeat, sender, ws, listening = false, closed = false, pcm, position = 0, playUntil = 0, lastAudio = 0;
const report = { at: new Date().toISOString(), source: 'generated synthetic speech', turns: [], errors: [], userCaptions: 0, assistantCaptions: 0, audioBytes: 0, interrupts: 0, statuses: [] };
const assistant = [];
async function api(path, body) {
  const r = await fetch(origin + '/api' + path, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const value = await r.json(); assert.ok(r.ok, value.code); return value;
}
async function until(predicate, ms = 25000) { const deadline = Date.now() + ms; while (!predicate()) { if (closed || report.errors.length || Date.now() > deadline) throw new Error('Conversation stopped progressing'); await new Promise(r => setTimeout(r, 50)); } }
try {
  token = (await api('/login', { username: 'daniel', password: secrets.passwords.daniel })).token;
  run = await api('/runs', { consent: true }); report.runId = run.id;
  heartbeat = setInterval(() => { void api(`/runs/${run.id}/heartbeat`, {}).catch(e => report.errors.push('heartbeat: ' + e.message)); }, 1500);
  ws = new WebSocket(`${origin.replace('http', 'ws')}/ws?run=${run.id}`, [`carealong-token.${Buffer.from(token).toString('base64url')}`, 'carealong'], { origin });
  ws.on('message', data => {
    const e = JSON.parse(data);
    if (e.type === 'status') { report.statuses.push(e.status); listening = e.status === 'listening'; }
    if (e.type === 'audio') { const bytes = Buffer.from(e.data, 'base64').length; report.audioBytes += bytes; lastAudio = Date.now(); playUntil = Math.max(playUntil, lastAudio) + bytes / 48; }
    if (e.type === 'interrupt') { playUntil = Date.now(); report.interrupts++; }
    if (e.type === 'transcript' && e.final) { if (e.role === 'USER') report.userCaptions++; else { report.assistantCaptions++; assistant.push(e.text); } }
    if (e.type === 'error') report.errors.push(e.message);
  });
  ws.on('error', e => report.errors.push(e.message)); ws.on('close', () => { closed = true; });
  sender = setInterval(() => { if (!listening || ws.readyState !== WebSocket.OPEN) return; const frame = pcm && position < pcm.length ? pcm.subarray(position, position += 1024) : Buffer.alloc(1024); ws.send(frame); }, 32);
  await until(() => listening);
  const total = clips.length + (breathingCheck ? 0 : 1);
  for (let i = 0; i < total; i++) {
    if (i === clips.length) {
      const statuses = report.statuses.length;
      ws.send(JSON.stringify({ type: 'reconnect' }));
      await until(() => report.statuses.slice(statuses).includes('renewing') && report.statuses.slice(statuses).includes('listening'));
      report.reconnected = true;
    }
    const initial = { user: report.userCaptions, assistant: report.assistantCaptions, audio: report.audioBytes };
    const started = Date.now(); pcm = clips[i % clips.length]; position = 0;
    await until(() => position >= pcm.length);
    const ended = Date.now();
    await until(() => report.userCaptions > initial.user && report.assistantCaptions > initial.assistant && report.audioBytes > initial.audio && Date.now() > playUntil + 300 && Date.now() - lastAudio > 500);
    report.turns.push({ turn: i + 1, spokenInputMs: ended - started, responseAndPlaybackMs: Date.now() - ended, userCaptionBlocks: report.userCaptions - initial.user, assistant: assistant.slice(initial.assistant), audioBytes: report.audioBytes - initial.audio });
    console.log(`PASS spoken turn ${i + 1}/${total}${i === clips.length ? ' after reconnect' : ''}`);
    if (breathingCheck) {
      const state = await api('/state');
      const expected = ['new', 'breathing', 'ready'][i];
      assert.equal(state.incident?.phase, expected, `Spoken answer ${i + 1} did not advance the controller`);
      report.turns.at(-1).phase = state.incident.phase;
      report.turns.at(-1).nextQuestion = state.question;
    }
  }
  if (breathingCheck) {
    const context = await api(`/runs/${run.id}/context`, {});
    assert.equal(context.incident.severe_breathing, false);
    assert.match(context.next_question, /prepare a request/);
    assert.ok(context.evidence.some(e => /not severe.*uncomfortable/i.test(e.statement)));
    report.finalPhase = context.incident.phase;
    report.severeBreathing = context.incident.severe_breathing;
    report.nextQuestion = context.next_question;
  }
  report.passed = true;
} catch (e) { report.failure = e.message; process.exitCode = 1; }
finally {
  clearInterval(sender); clearInterval(heartbeat);
  if (run) await api(`/runs/${run.id}/stop`, {}).catch(() => {}); ws?.close();
  await writeFile(breathingCheck ? 'data/breathing-answer-check.json' : 'data/conversation-check.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ turns: report.turns.length, errors: report.errors, failure: report.failure, passed: report.passed || false }));
}

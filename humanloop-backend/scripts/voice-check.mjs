// Prerecorded synthetic speech -> real WebSocket -> Nova 2 Sonic -> audio + tool call.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const secrets = JSON.parse(await readFile('.carealong-secrets.json'));
const pcm = await readFile('data/voice-check.pcm');
const origin = process.env.CAREALONG_URL || 'http://127.0.0.1:8080';
const interruptionCheck = process.argv.includes('--interrupt');
let token, run, heartbeat, ws;
async function api(path, body) {
  const response = await fetch(`${origin}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json(); assert.ok(response.ok, result.code); return result;
}
const result = { at: new Date().toISOString(), source: 'macOS synthetic speech, not a human microphone', model: 'amazon.nova-2-sonic-v1:0', statuses: [], audioBytes: 0, userTurns: 0, assistantTurns: 0, interrupts: 0, errors: [] };
try {
  token = (await api('/login', { username: 'daniel', password: secrets.passwords.daniel })).token;
  run = await api('/runs', { consent: true });
  heartbeat = setInterval(() => { void api(`/runs/${run.id}/heartbeat`, {}).catch(() => {}); }, 1500);
  let listening = false, closed = false, firstAudio;
  const started = performance.now();
  ws = new WebSocket(`${origin.replace('http', 'ws')}/ws?run=${run.id}`, [`carealong-token.${Buffer.from(token).toString('base64url')}`, 'carealong'], { origin });
  ws.on('message', data => {
    const event = JSON.parse(data);
    if (event.type === 'status') { result.statuses.push(event.status); if (event.status === 'listening') listening = true; }
    if (event.type === 'audio') { result.audioBytes += Buffer.from(event.data, 'base64').length; firstAudio ??= performance.now(); }
    if (event.type === 'transcript' && event.final) { if (event.role === 'USER') result.userTurns++; else result.assistantTurns++; }
    if (event.type === 'interrupt') result.interrupts++;
    if (event.type === 'error') result.errors.push(event.message);
  });
  ws.on('error', error => { result.errors.push(error.message); closed = true; });
  ws.on('close', () => { closed = true; });
  let frame = 0, interruptionFrame, inputEnded;
  while (performance.now() - started < 40000 && !closed) {
    if (listening && ws.readyState === WebSocket.OPEN) {
      if (interruptionCheck && firstAudio && interruptionFrame === undefined) interruptionFrame = frame;
      const offset = (frame++ - (interruptionFrame ?? 30)) * 1024;
      if (!inputEnded && offset >= pcm.length) inputEnded = performance.now();
      const chunk = offset >= 0 && offset < pcm.length ? pcm.subarray(offset, Math.min(offset + 1024, pcm.length)) : Buffer.alloc(1024);
      ws.send(chunk);
    }
    if (result.audioBytes && result.assistantTurns && performance.now() - firstAudio > 3000 && (!interruptionCheck || (result.interrupts && result.assistantTurns >= 2))) break;
    await new Promise(resolve => setTimeout(resolve, 32));
  }
  result.firstAudioMs = firstAudio ? Math.round(firstAudio - started) : null;
  result.firstAudioAfterInputMs = firstAudio && inputEnded ? Math.round(firstAudio - inputEnded) : null;
  result.runId = run.id;
  const adminLogin = await api('/login', { username: 'admin', password: secrets.passwords.admin });
  const adminState = await fetch(`${origin}/api/state`, { headers: { Authorization: `Bearer ${adminLogin.token}` } }).then(r => r.json());
  result.successfulContextCalls = adminState.receipts.filter(r => r.run_id === run.id && r.tool === 'get_checkin_context' && r.status === 'SUCCEEDED').length;
  assert.ok(result.userTurns > 0, 'No final user speech received');
  assert.ok(result.audioBytes > 0, 'No audio response received');
  assert.ok(result.assistantTurns > 0, 'No final assistant speech received');
  assert.ok(result.successfulContextCalls > 0, 'Required context tool did not complete');
  if (interruptionCheck) assert.ok(result.interrupts > 0, 'No actual Bedrock interruption event received');
  assert.equal(result.errors.length, 0);
  result.passed = true;
} finally {
  clearInterval(heartbeat);
  if (run) await api(`/runs/${run.id}/stop`, {}).catch(() => {});
  ws?.close();
  await writeFile(interruptionCheck ? 'data/voice-interruption-check.json' : 'data/voice-check.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}

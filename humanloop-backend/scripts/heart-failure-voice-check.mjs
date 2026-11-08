// Generated speech over the real authenticated Nova Sonic stream; no human microphone.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const origin = process.env.CAREALONG_URL || 'http://127.0.0.1:8080';
const passwords = JSON.parse(await readFile('.carealong-secrets.json')).passwords;
await mkdir('data/hf-voice', { recursive: true });
const scenarios = [
  { username: 'margaret', name: 'Maggie', turns: ["I've had this dry cough since yesterday. It woke me up a couple of times, but I'm sure it's nothing.", 'I used three pillows last night. I had to stop on the way to breakfast to catch my breath.'], route: 'prompt-assessment' },
  { username: 'robert', name: 'Bob', turns: ["This new pill is making me cough. I think I'll stop taking it tonight.", 'My tongue is suddenly swelling.'], route: 'emergency' },
];
const reports = [];
for (const scenario of scenarios) {
  const clips = [];
  for (const [i, line] of scenario.turns.entries()) {
    const file = `data/hf-voice/${scenario.username}-${i}`;
    execFileSync('say', ['-o', file + '.aiff', line]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', file + '.aiff', file + '.wav']);
    const wav = await readFile(file + '.wav');
    for (let p = 12; p < wav.length;) { const n = wav.readUInt32LE(p + 4); if (wav.toString('ascii', p, p + 4) === 'data') { clips.push(wav.subarray(p + 8, p + 8 + n)); break; } p += 8 + n + n % 2; }
  }
  let token, run, ws, heartbeat, inputTimer, queue = [], listening = false, lastOutput = Date.now();
  const report = { resident: scenario.username, source: 'Generated speech, real Cognito/DynamoDB/Nova Sonic; notifications simulated', turns: [], errors: [], audioBytes: 0, checks: [] };
  const api = async (path, body) => {
    const r = await fetch(origin + '/api' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const j = await r.json(); assert.ok(r.ok, `${path}: ${j.code}`); return j;
  };
  const wait = async (predicate, label, timeout = 45000) => { const end = Date.now() + timeout; while (!predicate()) { if (report.errors.length) throw new Error(report.errors.join('; ')); if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 100)); } };
  try {
    token = (await api('/login', { username: scenario.username, password: passwords[scenario.username] })).token;
    run = await api('/runs', { consent: true }); report.runId = run.id;
    heartbeat = setInterval(() => void api(`/runs/${run.id}/heartbeat`, {}).catch(e => report.errors.push(e.message)), 1500);
    ws = new WebSocket(`${origin.replace('http', 'ws')}/ws?run=${run.id}`, [`carealong-token.${Buffer.from(token).toString('base64url')}`, 'carealong'], { origin });
    ws.on('error', e => report.errors.push(e.message));
    ws.on('message', bytes => { const m = JSON.parse(bytes); if (m.type === 'audio' || m.type === 'transcript') lastOutput = Date.now(); if (m.type === 'status') listening = m.status === 'listening'; if (m.type === 'error') report.errors.push(m.message); if (m.type === 'audio') report.audioBytes += Buffer.from(m.data, 'base64').length; if (m.type === 'transcript' && m.final) report.turns.push({ role: m.role, text: m.text }); });
    inputTimer = setInterval(() => { if (listening && ws.readyState === WebSocket.OPEN) ws.send(queue.shift() || Buffer.alloc(1024)); }, 32);
    await wait(() => report.turns.some(t => t.role === 'ASSISTANT'), 'personal greeting');
    await wait(() => Date.now() - lastOutput > 5000, 'complete greeting');
    assert.match(report.turns.filter(t => t.role === 'ASSISTANT').map(t => t.text).join(' '), new RegExp(scenario.name, 'i'));
    report.checks.push('personalized greeting from authorized profile');
    for (const clip of clips) {
      const previous = report.turns.length;
      queue = []; for (let offset = 0; offset < clip.length; offset += 1024) { const frame = Buffer.alloc(1024); clip.copy(frame, 0, offset, Math.min(offset + 1024, clip.length)); queue.push(frame); }
      await wait(() => !queue.length, 'speech sent');
      await wait(() => report.turns.slice(previous).some(t => t.role === 'USER'), 'speech transcript');
      await wait(() => { const rows = report.turns.slice(previous), user = rows.findIndex(t => t.role === 'USER'); return user >= 0 && rows.slice(user + 1).some(t => t.role === 'ASSISTANT'); }, 'spoken reply');
      await wait(() => Date.now() - lastOutput > 5000, 'complete spoken reply');
      const state = await api('/state');
      const task = state.tasks.find(t => t.run_id === run.id);
      assert.equal(task?.delivery_status, 'SIMULATED_DELIVERED'); assert.equal(task.external_contact, false);
      if (scenario.username === 'robert' && clip === clips[0]) {
        assert.equal(state.incident.findings.intends_to_stop_medication, true, 'split speech must preserve medication intention');
        assert.match(task.summary.reported.map(r => r.quote).join(' '), /stop taking it/i);
      }
      report.checks.push('reported speech persisted and simulated alert confirmed by tool receipt');
    }
    const state = await api('/state');
    assert.equal(state.incident.route, scenario.route);
    const task = state.tasks.find(t => t.run_id === run.id); assert.equal(task.acknowledged_by, null);
    report.task = { id: task.id, route: task.route, reported: task.summary.reported, recorded: task.summary.recorded, delivery: task.delivery_status, acknowledged_by: task.acknowledged_by };
    const replies = report.turns.filter(t => t.role === 'ASSISTANT').map(t => t.text).join(' ');
    assert.match(replies, /demo|simulat/i, 'delivery must be described as simulated');
    if (scenario.route === 'emergency') assert.match(replies, /911|nine.one.one|emergency/i);
    else assert.match(replies, /nurse|assess/i);
    assert.ok(report.audioBytes > 0); assert.equal(report.errors.length, 0);
    report.passed = true;
  } finally {
    clearInterval(inputTimer); clearInterval(heartbeat);
    if (run) await api(`/runs/${run.id}/stop`, {}).catch(() => {});
    ws?.close(); if (token) await api('/logout', {}).catch(() => {});
    reports.push(report);
    await writeFile('data/heart-failure-voice-check.json', JSON.stringify({ at: new Date().toISOString(), reports }, null, 2));
    console.log(JSON.stringify({ resident: report.resident, passed: report.passed || false, checks: report.checks, errors: report.errors, turns: report.turns }));
  }
}

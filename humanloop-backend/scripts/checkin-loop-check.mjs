// Generated speech against the real local Nova/Cognito/DynamoDB demo.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { questionTopics } from '../server/care/checkin-progress.mjs';
const origin = 'http://127.0.0.1:8080';
const passwords = JSON.parse(await readFile('.carealong-secrets.json')).passwords;
const report = { at: new Date().toISOString(), source: 'Generated speech; real Nova, Cognito, DynamoDB and gateway; simulated alerts only', scenarios: [] };
await mkdir('data/checkin-loop', { recursive: true });
const ids = new Set(['cough', 'onset', 'sleep', 'activity', 'swelling', 'weight', 'routine', 'other']);
for (const scenario of (process.env.CHECKIN_SCENARIO ? [process.env.CHECKIN_SCENARIO] : ['extra-pillows', 'finished-checklist'])) {
  let token, run, ws, heartbeat, inputTimer, listening = false, queue = [], lastOutput = Date.now(), sequence = 0, closing = false;
  const result = { scenario, turns: [], replies: [], errors: [], checks: [] }; report.scenarios.push(result);
  const api = async (path, body) => {
    const r = await fetch(origin + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const value = await r.json(); assert.ok(r.ok, `${path}: ${value.code}`); return value;
  };
  const wait = async (fn, label, timeout = 60000) => {
    const until = Date.now() + timeout;
    while (!fn()) { if (result.errors.length) throw Error(result.errors.join('; ')); if (Date.now() > until) throw Error(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 100)); }
  };
  const speak = async text => {
    const file = `data/checkin-loop/${scenario}-${sequence++}`;
    execFileSync('say', ['-o', file + '.aiff', text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', file + '.aiff', file + '.wav']);
    const wav = await readFile(file + '.wav'); let pcm;
    for (let p = 12; p < wav.length;) { const n = wav.readUInt32LE(p + 4); if (wav.toString('ascii', p, p + 4) === 'data') { pcm = wav.subarray(p + 8, p + 8 + n); break; } p += 8 + n + n % 2; }
    const before = result.turns.length;
    for (let p = 0; p < pcm.length; p += 1024) { const frame = Buffer.alloc(1024); pcm.copy(frame, 0, p, Math.min(p + 1024, pcm.length)); queue.push(frame); }
    await wait(() => !queue.length, 'speech input');
    await wait(() => result.turns.slice(before).some(t => t.role === 'USER'), 'resident transcript');
    await wait(() => result.turns.slice(before).some(t => t.role === 'ASSISTANT'), 'assistant response');
    await wait(() => Date.now() - lastOutput > 7000, 'finished response');
    const response = result.turns.slice(before).filter(t => t.role === 'ASSISTANT').map(t => t.text).join(' ');
    result.replies.push({ text, response }); console.log(JSON.stringify({ scenario, text, response })); return response;
  };
  try {
    token = (await api('/login', { username: 'margaret', password: passwords.margaret })).token;
    run = await api('/runs', { consent: true, workflow: 'clinical' }); result.runId = run.id;
    heartbeat = setInterval(() => void api(`/runs/${run.id}/heartbeat`, {}).catch(e => { if (!closing) result.errors.push(e.message); }), 1500);
    ws = new WebSocket(origin.replace('http', 'ws') + '/ws?run=' + run.id, [`carealong-token.${Buffer.from(token).toString('base64url')}`, 'carealong'], { origin });
    ws.on('error', e => { if (!closing) result.errors.push(e.message); });
    ws.on('message', bytes => { const m = JSON.parse(bytes); if (['audio', 'transcript'].includes(m.type)) lastOutput = Date.now(); if (m.type === 'status') listening = m.status === 'listening'; if (m.type === 'error' && !closing) result.errors.push(m.message); if (m.type === 'transcript' && m.final) result.turns.push({ role: m.role, text: m.text }); });
    inputTimer = setInterval(() => { if (listening && ws.readyState === WebSocket.OPEN) ws.send(queue.shift() || Buffer.alloc(1024)); }, 32);
    await wait(() => result.turns.some(t => t.role === 'ASSISTANT'), 'greeting'); await wait(() => Date.now() - lastOutput > 7000, 'greeting complete');
    let response = await speak('My morning is going well. I am ready for my check in.');
    const seen = new Set(); let reached = false;
    for (let n = 0; n < 12; n++) {
      const asked = questionTopics(response, ids);
      for (const id of asked) { assert.equal(seen.has(id), false, `Repeated question: ${id}`); seen.add(id); }
      if (!asked.length) {
        if (seen.size >= 6) { reached = true; break; }
        response = await speak('I am ready for the daily check in questions.'); continue;
      }
      if (scenario === 'extra-pillows' && asked.includes('sleep')) {
        assert.equal(asked.length, 1, 'one subject per question');
        response = await speak('Yeah.');
        const state = await api('/state');
        assert.equal(state.incident?.findings?.extra_pillows, true);
        assert.equal(state.incident?.route, 'prompt-assessment');
        assert.equal(state.tasks.find(t => t.run_id === run.id)?.delivery_status, 'SIMULATED_DELIVERED');
        assert.match(response, /nurse|assess/i); assert.match(response, /demo|simulat/i);
        result.checks.push('Short yeah to actual pillow question triggers assessment and simulated receipt'); reached = true; break;
      }
      const answers = { cough: 'No cough.', onset: 'No cough.', sleep: 'No.', activity: 'I walked to breakfast comfortably without stopping.', swelling: 'No.', weight: 'No, staff have not checked yet.', routine: 'Good enough for bingo.', other: 'No, nothing else has changed.' };
      response = await speak(answers[asked[0]]);
    }
    assert.equal(reached, true, 'target scenario reached');
    if (scenario === 'finished-checklist') result.checks.push('Daily checklist finishes without repeating any covered subject');
    for (const acknowledgment of ['Got it.', 'Got it.']) {
      const closing = await speak(acknowledgment);
      assert.equal(questionTopics(closing, ids).length, 0, 'acknowledgment cannot restart checklist');
      assert.ok(closing.split(/\s+/).length <= 30, 'acknowledgment should not repeat the handoff paragraph');
      assert.doesNotMatch(closing, /make sure.*(?:record|pass)|care team.*(?:notified|full picture)/i);
    }
    assert.deepEqual(result.errors, []);
    result.checks.push('Two acknowledgments stay brief without checklist restart or handoff promise'); result.passed = true;
  } finally {
    closing = true; clearInterval(inputTimer); clearInterval(heartbeat);
    if (run) await api(`/runs/${run.id}/stop`, {}).catch(() => {}); ws?.close(); if (token) await api('/logout', {}).catch(() => {});
    await writeFile('data/checkin-loop-check.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ scenario, passed: result.passed || false, checks: result.checks, errors: result.errors }));
  }
}

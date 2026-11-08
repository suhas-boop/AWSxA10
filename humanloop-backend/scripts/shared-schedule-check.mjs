// Generated speech against real Nova and the gateway; no policy/consent changes.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const origin = 'http://127.0.0.1:8080', passwords = JSON.parse(await readFile('.carealong-secrets.json')).passwords;
const tokens = {}, report = { at: new Date().toISOString(), checks: [], turns: [], errors: [] };
let run, ws, heartbeat, inputTimer, listening = false, closing = false, lastOutput = Date.now(), queue = [];
await mkdir('data/shared-schedule', { recursive: true });
const api = async (user, path, body) => {
  const response = await fetch(origin + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(tokens[user] ? { Authorization: `Bearer ${tokens[user]}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  const value = await response.json(); assert.ok(response.ok, `${path}: ${value.code}`); return value;
};
async function wait(fn, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (!await fn()) { if (report.errors.length) throw Error(report.errors.join('; ')); if (Date.now() > end) throw Error('Timed out: ' + label); await new Promise(r => setTimeout(r, 100)); }
}
async function speak(text) {
  const file = `data/shared-schedule/line-${report.turns.length}`, before = report.turns.length;
  execFileSync('say', ['-o', file + '.aiff', text]); execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', file + '.aiff', file + '.wav']);
  const wav = await readFile(file + '.wav'); let pcm;
  for (let p = 12; p < wav.length;) { const n = wav.readUInt32LE(p + 4); if (wav.toString('ascii', p, p + 4) === 'data') { pcm = wav.subarray(p + 8, p + 8 + n); break; } p += 8 + n + n % 2; }
  for (let p = 0; p < pcm.length; p += 1024) { const frame = Buffer.alloc(1024); pcm.copy(frame, 0, p, Math.min(p + 1024, pcm.length)); queue.push(frame); }
  await wait(() => !queue.length, 'speech sent'); await wait(() => report.turns.slice(before).some(t => t.role === 'USER'), 'user caption');
  await wait(() => report.turns.slice(before).some(t => t.role === 'ASSISTANT'), 'spoken response'); await wait(() => Date.now() - lastOutput > 7000, 'response complete');
  const reply = report.turns.slice(before).filter(t => t.role === 'ASSISTANT').map(t => t.text).join(' ');
  console.log(JSON.stringify({ text, reply })); return reply;
}
try {
  await wait(async () => { try { return (await fetch(origin + '/ping')).ok; } catch { return false; } }, 'server startup', 30000);
  for (const username of ['margaret', 'admin']) tokens[username] = (await api(username, '/login', { username, password: passwords[username] })).token;
  const policy = (await api('admin', '/state')).profiles.find(p => p.residentId === 'margaret').policy;
  assert.equal(policy.paused, false); assert.equal(policy.capabilities.schedule, true); assert.equal(policy.capabilities.attendance, true);
  run = await api('margaret', '/runs', { consent: true, workflow: 'social' }); report.runId = run.id;
  heartbeat = setInterval(() => void api('margaret', `/runs/${run.id}/heartbeat`, {}).catch(e => { if (!closing) report.errors.push(e.message); }), 1600);
  ws = new WebSocket(origin.replace('http', 'ws') + '/ws?run=' + run.id, [`carealong-token.${Buffer.from(tokens.margaret).toString('base64url')}`, 'carealong'], { origin });
  ws.on('error', e => { if (!closing) report.errors.push(e.message); });
  ws.on('message', bytes => { const m = JSON.parse(bytes); if (['audio', 'transcript'].includes(m.type)) lastOutput = Date.now(); if (m.type === 'status') listening = m.status === 'listening'; if (m.type === 'error' && !closing) report.errors.push(m.message); if (m.type === 'transcript' && m.final) report.turns.push({ role: m.role, text: m.text }); });
  inputTimer = setInterval(() => { if (listening && ws.readyState === WebSocket.OPEN) ws.send(queue.shift() || Buffer.alloc(1024)); }, 32);
  await wait(() => report.turns.some(t => t.role === 'ASSISTANT'), 'greeting'); await wait(() => Date.now() - lastOutput > 7000, 'greeting complete');
  const shared = await speak("Can you tell me about Rose's schedule?");
  let decisions = (await api('admin', '/state')).decisions.filter(d => d.run_id === run.id);
  assert.ok(decisions.some(d => d.tool === 'read_activity_schedule' && d.decision === 'Allowed'));
  assert.ok(decisions.some(d => d.tool === 'check_friend_attendance' && d.decision === 'Allowed'));
  assert.match(shared, /bingo/i); assert.match(shared, /tomorrow/i); assert.match(shared, /3|three/i);
  report.checks.push('General Rose schedule question checks real shared attendance and answers with authorized bingo details');
  const garden = await speak('Is Rose also going to the garden activity?');
  decisions = (await api('admin', '/state')).decisions.filter(d => d.run_id === run.id);
  assert.ok(decisions.some(d => d.tool === 'check_friend_attendance' && d.rule === 'attendance-consent'));
  assert.match(garden, /(?:not|n't|unavailable|only|unable).*(?:shar|confirm|know|access)|(?:shar|confirm|know|access).*(?:not|n't|unavailable)/i);
  assert.doesNotMatch(garden, /Rose (?:is not|isn't|won't|will not) (?:go|attend)/i);
  report.checks.push('Unshared garden attendance remains unknown, not a claim Rose is absent');
  assert.deepEqual(report.errors, []); report.decisions = decisions; report.passed = true;
} finally {
  closing = true; clearInterval(inputTimer); clearInterval(heartbeat);
  if (run) await api('margaret', `/runs/${run.id}/stop`, {}).catch(() => {}); ws?.close();
  for (const user of Object.keys(tokens)) await api(user, '/logout', {}).catch(() => {});
  await writeFile('data/shared-schedule-check.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: !!report.passed, checks: report.checks, errors: report.errors }));
}

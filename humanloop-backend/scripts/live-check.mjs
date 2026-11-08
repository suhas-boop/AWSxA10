// Explicit synthetic integration run: writes demo incidents/tasks to the configured AWS table.
// No credentials, tokens, or resident statements are printed or included in the report.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const origin = process.env.CAREALONG_URL || 'http://127.0.0.1:8080';
const secrets = JSON.parse(await readFile('.carealong-secrets.json'));
const tokens = {}, timers = new Map(), samples = [], checks = [];
async function api(user, path, body, expected = 200) {
  const start = performance.now();
  const response = await fetch(`${origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(25000),
    headers: { 'Content-Type': 'application/json', ...(tokens[user] ? { Authorization: `Bearer ${tokens[user]}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!path.includes('login')) samples.push({ operation: path.split('/').at(-1), ms: Math.round(performance.now() - start), http: response.status });
  assert.equal(response.status, expected, `${path}: ${result.code || 'unexpected response'}`); return result;
}
async function login(user) { const result = await api(user, '/login', { username: user, password: secrets.passwords[user] }); tokens[user] = result.token; }
async function run(user) {
  const value = await api(user, '/runs', { consent: true }, 201);
  timers.set(value.id, { user, timer: setInterval(() => { void api(user, `/runs/${value.id}/heartbeat`, {}).catch(() => {}); }, 1500) });
  return value.id;
}
async function stop(user, id) { clearInterval(timers.get(id)?.timer); await api(user, `/runs/${id}/stop`, {}); timers.delete(id); }
const turn = (user, id, text) => api(user, `/runs/${id}/turns`, { text, turn_id: randomUUID() });
async function proposal(user, id) {
  const context = await api(user, `/runs/${id}/context`, {}); assert.equal(context.ok, true);
  const value = await api(user, `/runs/${id}/propose`, { incident_id: context.incident.id, assistance: 'Synthetic integration verification' });
  assert.equal(value.ok, true); return value.draft;
}
async function submit(user, id, draft) {
  const result = await api(user, `/runs/${id}/confirm`, { draft_id: draft.id, accepted: true });
  assert.equal(result.status, 'CREATED', result.code); return result;
}
function passed(name) { checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
try {
  for (const user of ['margaret', 'robert', 'grace', 'sam', 'lee', 'carla', 'admin', 'daniel']) await login(user);
  passed('eight separate real Cognito identities');
  for (let iteration = 1; iteration <= 5; iteration++) {
    const id = await run('margaret');
    // Injected observation tests the controller, not acoustic detector accuracy.
    const observation = { window_id: randomUUID(), label: 'Cough', score: .8, start_ms: 0, end_ms: 975, quality: 'uncertain' };
    await api('margaret', `/runs/${id}/observations`, observation, 201);
    const duplicate = await api('margaret', `/runs/${id}/observations`, observation, 201); assert.equal(duplicate.duplicate, true);
    for (const answer of ['Yes, that was me.', 'Yes, it is new.', 'No.']) await turn('margaret', id, answer);
    const draft = await proposal('margaret', id), result = await submit('margaret', id, draft);
    const receipt = await api('margaret', `/requests/${draft.request_id}`); assert.equal(receipt.task_id, result.task_id);
    await api('lee', `/tasks/${result.task_id}/acknowledge`, { resident_id: 'margaret' }, 403);
    await api('margaret', `/tasks/${result.task_id}/acknowledge`, { resident_id: 'margaret' }, 403);
    await api('sam', `/tasks/${result.task_id}/acknowledge`, { resident_id: 'margaret' });
    await api('sam', `/tasks/${result.task_id}/next-step`, { resident_id: 'margaret', text: 'Synthetic verification: assigned nurse will contact the resident.' });
    const state = await api('margaret', '/state');
    assert.equal(state.tasks.find(t => t.id === result.task_id).status, 'NEXT_STEP_RECORDED');
    assert.equal(state.drafts.length, 0);
    await stop('margaret', id);
    assert.ok((await api('sam', '/state')).tasks.some(t => t.id === result.task_id));
    await api('sam', `/tasks/${result.task_id}/resolve`, { resident_id: 'margaret' });
    passed(`primary live journey ${iteration}/5 including human-owned actions and stop persistence`);
  }
  const denied = await run('margaret');
  await api('margaret', `/runs/${denied}/observations`, { window_id: randomUUID(), label: 'Cough', score: .8, start_ms: 0, end_ms: 975, quality: 'uncertain' }, 201);
  await turn('margaret', denied, 'No, that was the TV.');
  let state = await api('margaret', '/state'); assert.equal(state.incident.symptom_confirmed, false); assert.equal(state.incident.state, 'DISMISSED_BY_USER');
  assert.ok(!state.tasks.some(t => t.run_id === denied));
  await api('daniel', `/runs/${denied}/context`, {}, 403);
  await api('admin', `/runs/${denied}/revoke`, { tool: 'get_checkin_context' });
  assert.equal((await api('admin', `/runs/${denied}/probe`, {})).code, 'GRANT_REVOKED');
  assert.doesNotMatch(JSON.stringify(await api('admin', '/state')), /heart failure|apixaban/);
  await turn('margaret', denied, 'I cannot breathe.');
  state = await api('margaret', '/state'); assert.ok(state.emergency); assert.ok(!state.tasks.some(t => t.run_id === denied));
  await stop('margaret', denied); passed('TV denial, wrong-resident denial, live revocation, admin privacy, emergency precedence');
  const head = await run('robert');
  await turn('robert', head, 'I fell and hit my head.'); await turn('robert', head, 'Yes.');
  const context = await api('robert', `/runs/${head}/context`, {}); assert.equal(context.incident.route, 'urgent'); assert.match(JSON.stringify(context.context), /apixaban/);
  const hd = await proposal('robert', head); await api('robert', `/runs/${head}/confirm`, { draft_id: hd.id, accepted: false });
  assert.ok(!(await api('robert', '/state')).tasks.some(t => t.run_id === head)); await stop('robert', head); passed('head injury urgent route and declined handoff');
  const pharmacy = await run('grace');
  for (const answer of ['I could not get to the pharmacy.', 'Yes.', 'Yes.']) await turn('grace', pharmacy, answer);
  await submit('grace', pharmacy, await proposal('grace', pharmacy));
  assert.ok((await api('carla', '/state')).tasks.some(t => t.run_id === pharmacy));
  assert.ok((await api('sam', '/state')).tasks.some(t => t.run_id === pharmacy));
  await stop('grace', pharmacy); passed('independent pharmacy route with caregiver and nurse tasks');
  const expiring = await run('daniel'); clearInterval(timers.get(expiring).timer);
  await new Promise(resolve => setTimeout(resolve, 10000));
  await api('daniel', `/runs/${expiring}/context`, {}, 403); timers.delete(expiring);
  passed('lease expiry blocks actions after lost heartbeat');
  await api('daniel', '/logout', {}); await api('daniel', '/state', undefined, 401); passed('logout revokes subsequent human access');
} finally {
  for (const [id, value] of timers) { clearInterval(value.timer); await api(value.user, `/runs/${id}/stop`, {}).catch(() => {}); }
  await mkdir('data', { recursive: true });
  await writeFile('data/live-check.json', JSON.stringify({ at: new Date().toISOString(), origin, checks, samples, observationSource: 'injected controller fixture, not acoustic validation' }, null, 2));
}

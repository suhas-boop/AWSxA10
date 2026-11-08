import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../server/care/store.mjs';
import { CareWorkflow } from '../server/care/workflow.mjs';
import { seedFixtures, people, residentPK, orgPK } from '../server/care/fixtures.mjs';
import { createRunMcp } from '../server/care/mcp.mjs';
import { DynamoStore } from '../server/care/store.mjs';

async function setup() {
  const store = new MemoryStore();
  const subjects = Object.fromEntries(people.map(p => [p.username, `sub-${p.username}`]));
  await seedFixtures(store, subjects);
  let time = Date.now();
  const service = new CareWorkflow({ store, machineClientId: 'machine-client', clock: () => time, machineToken: async () => 'valid-machine',
    verifyMachine: async token => { if (token !== 'valid-machine') throw new Error('invalid token'); } });
  const person = name => ({ sub: subjects[name], exp: Math.floor(Date.now() / 1000) + 3600 });
  return { service, store, person, jump: ms => { time += ms; } };
}
async function ready(ctx, username = 'margaret') {
  const principal = ctx.person(username), run = await ctx.service.startRun(principal, true);
  await ctx.service.observe(principal, run.id, { window_id: '1', label: 'Cough', start_ms: 0, end_ms: 975, score: 0.8, quality: 'uncertain' });
  for (const text of ['Yes, that was me.', 'Yes, it is new.', 'No.']) await ctx.service.report(principal, run.id, text);
  const context = await ctx.service.agentCall(run.id, 'get_checkin_context', {});
  const proposed = await ctx.service.agentCall(run.id, 'propose_follow_up', { incident_id: context.incident.id, assistance: 'Nurse review' });
  assert.equal(proposed.ok, true);
  return { principal, run, draft: proposed.draft };
}
test('indirect breathing answer persists verbatim and the next context advances to review', async () => {
  const { service, person } = await setup(), senior = person('daniel');
  const run = await service.startRun(senior, true);
  await service.report(senior, run.id, "I'm coughing", 'speech');
  await service.report(senior, run.id, "It's new", 'speech');
  const phrase = 'not severe but a little bit uncomfortable';
  await service.report(senior, run.id, phrase, 'speech', 'answer-once');
  await service.report(senior, run.id, phrase, 'speech', 'answer-once');
  const context = await service.agentCall(run.id, 'get_checkin_context', {});
  assert.equal(context.incident.phase, 'ready');
  assert.equal(context.incident.severe_breathing, false);
  assert.match(context.next_question, /prepare a request/);
  assert.equal(context.evidence.filter(e => e.statement === phrase).length, 1);
  assert.match(context.evidence.find(e => e.statement === phrase).in_response_to, /severe difficulty breathing/);
  assert.equal((await service.snapshot(senior)).tasks.length, 0);
});
test('context stops repeated clinical questions without inventing an answer or task', async () => {
  const { service, person } = await setup(), senior = person('daniel');
  const run = await service.startRun(senior, true);
  assert.equal((await service.agentCall(run.id, 'get_checkin_context', {})).next_question, null);
  await service.report(senior, run.id, "I'm coughing");
  await service.report(senior, run.id, "It's new");
  for (const answer of ['Maybe', 'I am not sure', 'Why are you repeating that?']) await service.report(senior, run.id, answer);
  const context = await service.agentCall(run.id, 'get_checkin_context', {});
  assert.equal(context.question_mode, 'answer_controls');
  assert.equal(context.next_question, null);
  assert.equal(context.incident.phase, 'breathing');
  assert.equal(context.incident.severe_breathing, null);
  assert.equal((await service.snapshot(senior)).tasks.length, 0);
  await service.report(senior, run.id, 'No.');
  assert.equal((await service.agentCall(run.id, 'get_checkin_context', {})).incident.phase, 'ready');
});
test('primary journey requires confirmation and an actual assigned human acknowledgment', async () => {
  const ctx = await setup(), { service } = ctx, { principal, run, draft } = await ready(ctx);
  const fake = await service.agentCall(run.id, 'create_review_task', { draft_id: draft.id, confirmation_id: 'invented', request_id: draft.request_id });
  assert.equal(fake.code, 'CONFIRMATION_REQUIRED');
  const confirmation = await service.confirm(principal, run.id, draft.id, true);
  const result = await service.agentCall(run.id, 'create_review_task', confirmation);
  assert.equal(result.status, 'CREATED');
  assert.equal((await service.agentCall(run.id, 'create_review_task', confirmation)).task_id, result.task_id);
  assert.equal((await service.snapshot(ctx.person('sam'))).tasks.length, 1);
  await assert.rejects(service.taskAction(ctx.person('lee'), 'margaret', result.task_id, 'acknowledge'), /RESIDENT_SCOPE_DENIED/);
  await assert.rejects(service.taskAction(principal, 'margaret', result.task_id, 'acknowledge'), /RESIDENT_SCOPE_DENIED/);
  await service.taskAction(ctx.person('sam'), 'margaret', result.task_id, 'acknowledge');
  await service.taskAction(ctx.person('sam'), 'margaret', result.task_id, 'next-step', 'I will call at 3:30 PM.');
  const senior = await service.snapshot(principal);
  assert.equal(senior.tasks[0].status, 'NEXT_STEP_RECORDED');
  assert.equal(senior.tasks[0].acknowledged_by, 'Sam Rivera');
  assert.equal(senior.incident.state, 'FOLLOW_UP_OPEN');
  assert.match(JSON.stringify((await service.snapshot(ctx.person('sam'))).evidence), /heart failure/);
});
test('declined sharing produces no care task', async () => {
  const ctx = await setup(), { principal, run, draft } = await ready(ctx);
  await ctx.service.confirm(principal, run.id, draft.id, false);
  await assert.rejects(ctx.service.confirm(principal, run.id, draft.id, true), /CONFIRMATION_REQUIRED/);
  assert.equal((await ctx.service.snapshot(principal)).tasks.length, 0);
});
test('TV cough is dismissed without a patient symptom or handoff', async () => {
  const { service, person } = await setup(), senior = person('margaret');
  const run = await service.startRun(senior, true);
  const observation = { window_id: 'tv', label: 'Cough', start_ms: 0, end_ms: 975, score: .9, quality: 'uncertain' };
  await service.observe(senior, run.id, observation);
  assert.equal((await service.observe(senior, run.id, observation)).duplicate, true);
  await service.report(senior, run.id, 'No, it was the TV.');
  const state = await service.snapshot(senior);
  assert.equal(state.incident.state, 'DISMISSED_BY_USER'); assert.equal(state.incident.symptom_confirmed, false);
  assert.equal(state.tasks.length, 0);
  assert.equal((await service.agentCall(run.id, 'propose_follow_up', { incident_id: state.incident.id, assistance: 'Review' })).ok, false);
});
test('revoked read capability denies the next MCP call and admin never sees clinical details', async () => {
  const { service, person } = await setup();
  const run = await service.startRun(person('margaret'), true);
  const mcp = await createRunMcp(service, run.id);
  try {
    assert.equal((await mcp.call('get_checkin_context', {})).ok, true);
    await service.revoke(person('admin'), run.id, 'get_checkin_context');
    assert.equal((await mcp.call('get_checkin_context', {})).code, 'GRANT_REVOKED');
    const admin = await service.snapshot(person('admin'));
    assert.ok(admin.receipts.some(r => r.reason === 'GRANT_REVOKED' && !r.effect_started));
    assert.doesNotMatch(JSON.stringify(admin), /heart failure|apixaban/);
  } finally { await mcp.close(); }
});
test('unknown tools, extra fields, wrong residents and guessed run IDs are denied', async () => {
  const { service, person } = await setup(), run = await service.startRun(person('margaret'), true);
  assert.equal((await service.agentCall(run.id, 'acknowledge_task', {})).code, 'TOOL_NOT_ALLOWED');
  assert.equal((await service.agentCall(run.id, 'get_checkin_context', { resident_id: 'daniel' })).code, 'RESIDENT_SCOPE_DENIED');
  await assert.rejects(service.ownedRun(person('daniel'), run.id), /RESIDENT_SCOPE_DENIED/);
  assert.equal((await service.dispatch({ runId: run.id, tool: 'get_checkin_context', args: {}, token: 'valid-machine', capability: 'guessed' })).code, 'AUTH_INVALID');
  assert.equal((await service.snapshot(person('lee'))).tasks.length, 0);
});
test('atomic task transaction fails if database revocation commits first', async () => {
  const ctx = await setup(), { service, store } = ctx, { principal, run, draft } = await ready(ctx);
  const confirmation = await service.confirm(principal, run.id, draft.id, true);
  const transact = store.transact.bind(store);
  let intercepted = false;
  store.transact = async ops => {
    if (!intercepted && ops.some(op => op.item?.type === 'CareTask')) {
      intercepted = true;
      const grant = await store.get(run.pk, `GRANT#${run.id}#create_review_task`);
      await store.put({ ...grant, version: grant.version + 1, revokedAt: new Date().toISOString() });
    }
    return transact(ops);
  };
  const result = await service.agentCall(run.id, 'create_review_task', confirmation);
  assert.equal(result.ok, false); assert.equal(result.code, 'GRANT_REVOKED');
  assert.equal((await store.query(run.pk, 'TASK#')).length, 0);
  assert.equal((await store.get(run.pk, `CONFIRMATION#${confirmation.confirmation_id}`)).consumed_at, null);
});
test('corrections invalidate drafts and preserve provenance', async () => {
  const ctx = await setup(), { principal, run, draft } = await ready(ctx);
  const snapshot = await ctx.service.snapshot(principal);
  const reported = snapshot.evidence.find(e => e.type === 'reported');
  await ctx.service.correct(principal, run.id, reported.id, 'I meant that the cough was on television.');
  await assert.rejects(ctx.service.confirm(principal, run.id, draft.id, true), /CONFIRMATION_REQUIRED/);
  const corrected = await ctx.service.snapshot(principal);
  assert.ok(corrected.evidence.some(e => e.corrects_id === reported.id));
});
test('stop and heartbeat expiry deny actions while preserving existing nurse tasks', async () => {
  const ctx = await setup(), { principal, run, draft } = await ready(ctx);
  const confirm = await ctx.service.confirm(principal, run.id, draft.id, true);
  await ctx.service.agentCall(run.id, 'create_review_task', confirm);
  await ctx.service.stopRun(principal, run.id);
  assert.equal((await ctx.service.agentCall(run.id, 'get_checkin_context', {})).ok, false);
  assert.equal((await ctx.service.snapshot(ctx.person('sam'))).tasks.length, 1);
  const second = await ctx.service.startRun(principal, true); ctx.jump(8100);
  assert.equal((await ctx.service.agentCall(second.id, 'get_checkin_context', {})).code, 'RUN_STOPPED');
  await assert.rejects(ctx.service.heartbeat(principal, second.id), /RUN_STOPPED/);
});
test('emergency guidance appears without chart access or task approval', async () => {
  const { service, person } = await setup(), senior = person('margaret'), run = await service.startRun(senior, true);
  await service.revoke(person('admin'), run.id, 'get_checkin_context');
  const result = await service.report(senior, run.id, 'I cannot breathe.');
  assert.match(result.emergency, /immediate emergency help/);
  assert.equal((await service.snapshot(senior)).tasks.length, 0);
});
test('head injury and pharmacy fixtures use separate routes and owners', async () => {
  const { service, person } = await setup();
  const head = await service.startRun(person('robert'), true);
  await service.report(person('robert'), head.id, 'I fell and hit my head.');
  await service.report(person('robert'), head.id, 'Yes.');
  const ctx = await service.agentCall(head.id, 'get_checkin_context', {});
  assert.equal(ctx.incident.route, 'urgent'); assert.match(JSON.stringify(ctx.context), /apixaban/);
  const pharmacy = await service.startRun(person('grace'), true);
  await service.report(person('grace'), pharmacy.id, 'I could not get to the pharmacy.');
  await service.report(person('grace'), pharmacy.id, 'Yes.');
  await service.report(person('grace'), pharmacy.id, 'Yes.');
  const snapshot = await service.snapshot(person('grace'));
  const proposal = await service.agentCall(pharmacy.id, 'propose_follow_up', { incident_id: snapshot.incident.id, assistance: 'Pickup help' });
  const confirmation = await service.confirm(person('grace'), pharmacy.id, proposal.draft.id, true);
  assert.equal((await service.agentCall(pharmacy.id, 'create_review_task', confirmation)).ok, true);
  assert.equal((await service.snapshot(person('carla'))).tasks.length, 1);
  assert.equal((await service.snapshot(person('sam'))).tasks.length, 1);
});

test('DynamoDB full resident query omits an invalid empty sort-key prefix', async () => {
  const store = new DynamoStore('test-table', 'us-east-1');
  const calls = [];
  store.client.send = async command => { calls.push(command.input); return { Items: [] }; };
  await store.query('resident'); await store.query('resident', 'TASK#');
  assert.equal(calls[0].KeyConditionExpression, 'pk = :pk');
  assert.equal(':prefix' in calls[0].ExpressionAttributeValues, false);
  assert.equal(calls[1].ExpressionAttributeValues[':prefix'], 'TASK#');
  store.client.destroy();
});

test('resident logout denies agent tools even before the run lease expires', async () => {
  const ctx = await setup(); const principal = { ...ctx.person('margaret'), jti: 'login-id' };
  const login = { pk: orgPK, sk: 'LOGIN#login-id', version: 1, sub: principal.sub, active: true };
  await ctx.store.put(login);
  const run = await ctx.service.startRun(principal, true);
  assert.equal((await ctx.service.agentCall(run.id, 'get_checkin_context', {})).ok, true);
  await ctx.store.put({ ...login, active: false, version: 2 });
  assert.equal((await ctx.service.agentCall(run.id, 'get_checkin_context', {})).code, 'AUTH_INVALID');
});

test('lease sweeper does not tear down a heartbeat that won the run lock', async () => {
  const ctx = await setup(), run = await ctx.service.startRun(ctx.person('margaret'), true);
  ctx.jump(8100); let intercepted = false;
  const get = ctx.store.get.bind(ctx.store);
  ctx.store.get = async (pk, sk) => {
    const row = await get(pk, sk);
    if (!intercepted && sk === run.sk) {
      intercepted = true;
      await ctx.store.put({ ...row, version: row.version + 1, leaseUntil: Date.now() + 30000 });
    }
    return row;
  };
  await ctx.service.expireLeases();
  assert.ok(ctx.service.bindings.has(run.id));
  assert.equal((await get(run.pk, run.sk)).state, 'ACTIVE');
});

test('consent withdrawal and assignment removal deny the next protected action', async () => {
  const ctx = await setup(), { principal, run, draft } = await ready(ctx);
  const confirmation = await ctx.service.confirm(principal, run.id, draft.id, true);
  const consent = await ctx.store.get(run.pk, `CONSENT#${run.consent_ref}`);
  await ctx.store.put({ ...consent, version: consent.version + 1, active: false });
  assert.equal((await ctx.service.agentCall(run.id, 'create_review_task', confirmation)).code, 'CONFIRMATION_REQUIRED');
  assert.equal((await ctx.store.query(run.pk, 'TASK#')).length, 0);
  await ctx.store.put({ ...consent, version: consent.version + 2, active: true });
  const owner = await ctx.store.get(orgPK, 'MEMBER#sub-sam');
  await ctx.store.put({ ...owner, version: owner.version + 1, assignments: [] });
  assert.equal((await ctx.service.agentCall(run.id, 'create_review_task', confirmation)).code, 'RESIDENT_SCOPE_DENIED');
});
test('daily question plans are returned only from the authorized resident profile', async () => {
  const { service, store, person } = await setup();
  const record = await store.get(residentPK('margaret'), 'CONTEXT');
  await store.put({ ...record, daily_checkin: { version: 'synthetic-plan-v1', enabled: true, questions: [{ id: 'experience', condition: 'synthetic condition', question: 'How has this affected your day?', required: true }] } });
  const first = await service.startRun(person('margaret'), true), second = await service.startRun(person('daniel'), true);
  const a = await service.agentCall(first.id, 'get_checkin_context', {}), b = await service.agentCall(second.id, 'get_checkin_context', {});
  assert.equal(a.question_mode, 'daily_checkin'); assert.equal(a.daily_checkin.questions[0].id, 'experience');
  assert.equal(b.daily_checkin.configured, false); assert.equal(b.daily_checkin.questions.length, 0);
  await service.revoke(person('admin'), first.id, 'get_checkin_context');
  const denied = await service.agentCall(first.id, 'get_checkin_context', {});
  assert.equal(denied.code, 'GRANT_REVOKED'); assert.equal(denied.daily_checkin, undefined);
});

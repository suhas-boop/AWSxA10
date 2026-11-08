import test from 'node:test';
import assert from 'node:assert/strict';
import maggie from '../config/maggie-demo.json' with { type: 'json' };
import bob from '../config/bob-demo.json' with { type: 'json' };
import { MemoryStore } from '../server/care/store.mjs';
import { CareWorkflow } from '../server/care/workflow.mjs';
import { seedFixtures, people, residentPK } from '../server/care/fixtures.mjs';
import { heartFailureFindings, weightChange, hasHeartFailureDemo } from '../server/care/heart-failure.mjs';
import { validateDailyPlan } from '../server/care/daily-checkin.mjs';

async function setup(username = 'margaret', gain = null) {
  const store = new MemoryStore(), subjects = Object.fromEntries(people.map(p => [p.username, `sub-${p.username}`]));
  await seedFixtures(store, subjects);
  const now = Date.now(), person = name => ({ sub: subjects[name], exp: Math.floor(now / 1000) + 3600 });
  for (const profile of [...maggie.profiles, ...bob.profiles]) {
    validateDailyPlan(profile.daily_checkin);
    const old = await store.get(residentPK(profile.resident_id), 'CONTEXT');
    await store.put({ ...old, ...profile, version: old.version + 1, source_ref: `test:profile:${profile.resident_id}`, verified_at: new Date(now).toISOString() });
  }
  if (gain !== null) {
    const record = await store.get(residentPK(username), 'CONTEXT'), base = record.patient_profile.baseline.weight_lb;
    await store.put({ ...record, measurements: [base, base + gain].map((value, i) => ({ kind: 'weight', value, unit: 'lb', at: new Date(now - (1 - i) * 86400000).toISOString(), source_ref: `test:staff-weight:${i}`, synthetic: true })) });
  }
  const service = new CareWorkflow({ store, clock: () => now, machineClientId: 'test-machine', machineToken: async () => 'test', verifyMachine: async () => {} });
  const senior = person(username), run = await service.startRun(senior, true);
  const report = (text, turn) => service.report(senior, run.id, text, 'speech', turn);
  const context = () => service.agentCall(run.id, 'get_checkin_context', {});
  return { store, service, person, senior, run, report, context };
}

test('two profiles expose their own baseline and questions, never preloaded scenario symptoms', async () => {
  for (const [username, name, weight] of [['margaret', 'Maggie', 150], ['robert', 'Bob', 172]]) {
    const c = await setup(username), context = await c.context();
    assert.equal(context.resident, name); assert.equal(context.context.patient_profile.baseline.weight_lb, weight);
    assert.equal(context.daily_checkin.configured, true); assert.equal(context.incident, null); assert.equal(context.alert, null);
    assert.equal(context.weight_change, null); assert.deepEqual(context.evidence, []);
    assert.equal(context.context.medications.some(m => /apixaban/i.test(m)), false);
  }
  assert.equal(hasHeartFailureDemo({ synthetic: true }), false);
  assert.equal(hasHeartFailureDemo({ id: 'daniel', synthetic: true, demo_care_plan: maggie.profiles[0].demo_care_plan }), false);
});
test('Maggie new cough immediately delivers a simulated alert with only actual reported evidence', async () => {
  const c = await setup();
  const quote = "I've had this dry cough since yesterday. It woke me up a couple of times, but I'm sure it's nothing.";
  const result = await c.report(quote, 'cough-1');
  assert.equal(result.alert.ok, true); assert.equal(result.alert.alert.status, 'SIMULATED_DELIVERED');
  assert.equal(result.alert.alert.external_contact, false); assert.equal(result.incident.route, 'clinical-review');
  const ctx = await c.context();
  assert.equal(ctx.question_mode, 'heart_failure_checkin'); assert.equal(ctx.alert_pending, false);
  assert.match(ctx.response_contract.required_message, /In this demo/);
  assert.equal(ctx.daily_checkin.questions.some(q => q.id === 'onset' || q.id === 'cough'), false);
  assert.ok(ctx.daily_checkin.answered_question_ids.includes('onset'));
  const tasks = (await c.service.snapshot(c.person('sam'))).tasks;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].summary.reported[0].quote, quote);
  assert.equal(tasks[0].summary.recorded.length, 1); assert.equal(tasks[0].acknowledged_by, null);
  assert.equal(tasks[0].summary.reported.some(r => /three pillows|ankles|153.5/.test(r.quote)), false);
});
test('each worsening indicator triggers prompt assessment independently without accumulating symptoms', async () => {
  for (const quote of ['I used three pillows last night. One wasn’t enough.', 'I had to stop on the way to breakfast to catch my breath.', 'Both my ankles look puffy today.']) {
    const c = await setup(); const result = await c.report(quote);
    assert.equal(result.incident.route, 'prompt-assessment', quote); assert.equal(result.alert.alert.status, 'SIMULATED_DELIVERED');
  }
});
test('bingo fatigue alone is supporting context, not a diagnosis or automatic heart failure alert', async () => {
  const c = await setup(); const result = await c.report('Tell Rose I’m skipping bingo. I’m too tired.');
  assert.equal(result.incident.route, 'clarify'); assert.equal(result.alert, undefined);
  assert.equal((await c.service.snapshot(c.person('sam'))).tasks.length, 0);
});
test('recorded 3.5 lb increase is distinct from a spoken weight and can trigger assessment alone', async () => {
  const c = await setup('margaret', 3.5); const result = await c.report('Good morning.');
  assert.equal(result.incident.route, 'prompt-assessment');
  const task = (await c.service.snapshot(c.person('sam'))).tasks[0];
  assert.equal(task.summary.reported.length, 0);
  assert.match(task.summary.recorded[1].statement, /150 to 153.5 lb in 24 hours/);
  assert.equal(task.summary.recorded[1].source_ref, 'test:staff-weight:1');
  const d = await setup(); await d.report('I have a cough. My weight is 153.5 pounds today.');
  const spoken = (await d.service.snapshot(d.person('sam'))).tasks[0];
  assert.equal(spoken.summary.recorded.length, 1); assert.match(spoken.summary.reported[0].quote, /153.5/);
});
test('severe breathlessness activates simulated emergency without routine questions or acknowledgment', async () => {
  const c = await setup(); const result = await c.report('I can’t catch my breath even sitting still.');
  assert.equal(result.incident.route, 'emergency'); assert.match(result.emergency, /911/);
  assert.equal(result.alert.alert.emergency_workflow, 'SIMULATED_ACTIVATED');
  assert.equal(result.alert.alert.acknowledged_by, null); assert.match((await c.context()).guidance, /stop routine questions/i);
});
test('Bob medication concern stays unconfirmed and uses his own recorded medication history', async () => {
  const c = await setup('robert', 0);
  await c.report('This new pill is making me cough. I think I’ll stop taking it tonight.');
  await c.report('The dry tickling cough started four days ago. No breathing difficulty or ankle swelling.');
  const ctx = await c.context(), task = (await c.service.snapshot(c.person('sam'))).tasks[0];
  assert.equal(ctx.resident, 'Bob'); assert.equal(ctx.incident.findings.intends_to_stop_medication, true);
  assert.match(task.summary.request, /Medication and symptom review/);
  assert.match(task.summary.recorded[0].statement, /12 days/); assert.match(task.summary.recorded[1].statement, /172 to 172/);
  assert.match(task.summary.interpretation, /another cause/); assert.match(ctx.instruction, /cause here is UNCONFIRMED/);
  assert.equal(task.route, 'clinical-review');
});
test('Bob lip or tongue swelling escalates on its own and does not recommend continuing a dose', async () => {
  for (const quote of ['My lips are suddenly swelling.', 'My tongue is swollen.']) {
    const c = await setup('robert'); const result = await c.report(quote);
    assert.equal(result.incident.route, 'emergency'); assert.equal(result.alert.alert.emergency_workflow, 'SIMULATED_ACTIVATED');
    assert.match((await c.context()).guidance, /Do not tell someone.*continue a dose/);
  }
});
test('split speech preserves Bob medication intention without treating an unfinished phrase as confirmed', async () => {
  const c = await setup('robert');
  await c.report("this new pill is making me cough i think i'll", 'part-1');
  assert.equal((await c.context()).incident.findings.intends_to_stop_medication, undefined);
  await c.report('stop taking it tonight', 'part-2');
  assert.equal((await c.context()).incident.findings.intends_to_stop_medication, true);
  const task = (await c.service.snapshot(c.person('sam'))).tasks[0];
  assert.ok(task.summary.reported.some(r => r.quote === 'stop taking it tonight'));
  assert.ok(task.summary.reported.some(r => r.quote.endsWith("i think i'll")));
});
test('routing joins authenticated consecutive speech fragments while preserving the original segment', async () => {
  const c = await setup();
  await c.report('I had to stop', 'walk-1');
  const result = await c.service.report(c.senior, c.run.id, 'on the way to breakfast to catch my breath', 'speech', 'walk-2', 'I had to stop');
  assert.equal(result.incident.route, 'prompt-assessment');
  const task = (await c.service.snapshot(c.person('sam'))).tasks[0];
  assert.equal(task.summary.reported[0].quote, 'I had to stop on the way to breakfast to catch my breath');
  assert.equal(task.summary.reported[0].segment_quote, 'on the way to breakfast to catch my breath');
});
test('hypothetical, third-party and negated symptoms do not become affirmative emergency findings', () => {
  for (const text of ['My friend cannot breathe.', 'What if my tongue swells?', 'My lips are not swollen.', 'I do not have chest pain.', 'I am not having severe difficulty breathing.', 'Maybe my ankles are swollen.']) {
    const f = heartFailureFindings(text); assert.equal(!!f.emergency, false, text); assert.equal(!!f.swelling, false, text);
  }
});
test('updates and retries use one task; acknowledgment requires assigned staff and new evidence reopens review', async () => {
  const c = await setup(); const first = await c.report('I have a new cough.', 'one');
  await c.report('I have a new cough.', 'one');
  assert.equal((await c.service.snapshot(c.person('sam'))).tasks.length, 1);
  const taskId = first.alert.alert.task_id;
  await assert.rejects(c.service.taskAction(c.person('lee'), 'margaret', taskId, 'acknowledge'), /RESIDENT_SCOPE_DENIED/);
  await c.service.taskAction(c.person('sam'), 'margaret', taskId, 'acknowledge');
  assert.equal((await c.context()).alert.acknowledged_by, 'Sam Rivera');
  assert.equal((await c.context()).alert.assessment_status, 'PENDING');
  await c.report('My ankles are puffy today.', 'two');
  const tasks = (await c.service.snapshot(c.person('sam'))).tasks;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].id, taskId); assert.equal(tasks[0].acknowledged_by, null);
  assert.equal(tasks[0].previous_acknowledgment.name, 'Sam Rivera'); assert.equal(tasks[0].route, 'prompt-assessment');
});
test('revoked or failed alert tool never yields a delivery receipt; emergency guidance remains available', async () => {
  const c = await setup(); await c.service.revoke(c.person('admin'), c.run.id, 'propose_follow_up');
  const result = await c.report('I cannot catch my breath even sitting still.');
  assert.equal(result.alert.ok, false); assert.match(result.emergency, /911/);
  const ctx = await c.context(); assert.equal(ctx.alert, null); assert.equal(ctx.alert_pending, true);
  assert.match(ctx.response_contract.required_message, /delivery is not confirmed/);
  assert.equal((await c.service.snapshot(c.person('sam'))).tasks.length, 0);
});
test('an uncertain inbox write does not return a successful delivery and can be reconciled without duplicates', async () => {
  const c = await setup(), transact = c.store.transact.bind(c.store);
  let failOnce = true;
  c.store.transact = async ops => {
    await transact(ops);
    if (failOnce && ops.some(op => op.item?.type === 'CareTask')) { failOnce = false; throw new Error('Simulated connection loss after commit'); }
  };
  const result = await c.report('I have a new cough.');
  assert.equal(result.alert.ok, false); assert.equal(result.alert.status, 'UNKNOWN');
  const reconciled = await c.context(); assert.equal(reconciled.alert.status, 'SIMULATED_DELIVERED');
  const retry = await c.service.agentCall(c.run.id, 'propose_follow_up', { incident_id: result.incident.id, assistance: 'Retry simulated delivery' });
  assert.equal(retry.replayed, true); assert.equal((await c.service.snapshot(c.person('sam'))).tasks.length, 1);
});
test('stale or untrusted weight values cannot create a recorded trend', () => {
  const now = Date.now();
  const rows = [150, 153.5].map((value, i) => ({ kind: 'weight', unit: 'lb', value, at: new Date(now - (1 - i) * 86400000).toISOString(), source_ref: `test:${i}`, synthetic: true }));
  assert.equal(weightChange({ measurements: rows }, now).increase_lb, 3.5);
  assert.equal(weightChange({ measurements: rows }, now + 86400001), null);
  assert.equal(weightChange({ measurements: rows.map(x => ({ ...x, synthetic: false })) }, now), null);
});
test('an unrelated TV reference does not hide direct personal emergency symptoms', () => {
  assert.equal(heartFailureFindings('The TV is loud, but I cannot catch my breath.').emergency, true);
});
test('corrected statements remain traceable and do not silently resolve a previously delivered alert', async () => {
  const c = await setup(); await c.report('My ankles are swollen.');
  const context = await c.context(), evidence = context.evidence[0];
  await c.service.correct(c.senior, c.run.id, evidence.id, 'My ankles are not swollen.');
  const updated = await c.context(); assert.equal(updated.incident.findings.swelling, false);
  const task = (await c.service.snapshot(c.person('sam'))).tasks[0];
  assert.equal(task.correction_pending, true); assert.notEqual(task.status, 'RESOLVED');
  assert.equal((await c.store.get(residentPK('margaret'), `EVIDENCE#${evidence.id}`)).superseded, true);
});

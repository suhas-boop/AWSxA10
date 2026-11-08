import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../server/care/store.mjs';
import { CareWorkflow } from '../server/care/workflow.mjs';
import { seedFixtures, people, residents, orgPK, TOOL_NAMES } from '../server/care/fixtures.mjs';
import { StaffPortal } from '../server/care/portal.mjs';
import { AgentPrintBridge } from '../server/care/agentprint.mjs';
import { companionTools, COMPANION_PROMPT } from '../server/care/companion-tools.mjs';
import { CARE_PROMPT } from '../server/care/voice.mjs';
const manifests = { social: { model: 'amazon.nova-2-sonic-v1:0', prompt: COMPANION_PROMPT, tools: companionTools.map(t => t.name) }, clinical: { model: 'amazon.nova-2-sonic-v1:0', prompt: CARE_PROMPT, tools: TOOL_NAMES } };
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'humanloop-print-')), bridge = new AgentPrintBridge({ keyFile: join(dir, 'keys.json') });
  t.after(async () => { bridge.close(); await rm(dir, { recursive: true, force: true }); });
  await bridge.initialize(manifests, residents.map(r => r.id));
  const store = new MemoryStore(), subjects = Object.fromEntries(people.map(p => [p.username, `sub-${p.username}`])); await seedFixtures(store, subjects);
  const care = new CareWorkflow({ store, machineClientId: 'machine', machineToken: async () => 'valid', verifyMachine: async () => {} });
  const portal = new StaffPortal({ care, bridge }); await portal.seed(); care.authorizeAgent = portal.authorizeClinical.bind(portal);
  const person = name => ({ sub: subjects[name], exp: Math.floor(Date.now() / 1000) + 3600 });
  const run = await care.startRun(person('margaret'), true, 'social');
  return { bridge, store, care, portal, person, run };
}
test('AgentPrint checks changed policy on the same signed grant', async t => {
  const { portal, run, person, store } = await setup(t);
  const allowed = await portal.call(run.id, 'check_friend_attendance', { friend: 'Rose', activity_id: 'bingo' });
  assert.equal(allowed.ok, true); assert.equal(allowed.attending, true); assert.match(allowed.agentprint.print_id, /^ap1:/);
  await portal.updatePolicy(person('admin'), 'margaret', { capability: 'attendance', enabled: false });
  const denied = await portal.call(run.id, 'check_friend_attendance', { friend: 'Rose', activity_id: 'bingo' });
  assert.equal(denied.ok, false); assert.equal(denied.rule, 'capability-disabled');
  const decisions = (await store.query(orgPK, 'COMPANION_DECISION#')).filter(d => d.tool === 'check_friend_attendance');
  assert.equal(decisions[0].grant_session, decisions[1].grant_session); assert.ok(decisions.every(d => d.audit_hash));
});
test('admin permission cannot override consent or expose clinical tools to social sessions', async t => {
  const { portal, care, run, person, store } = await setup(t);
  const row = await store.get(run.pk, 'SOCIAL_CONSENT'); await store.put({ ...row, version: row.version + 1, capabilities: { ...row.capabilities, attendance: false } });
  await portal.updatePolicy(person('admin'), 'margaret', { capability: 'attendance', enabled: true });
  assert.equal((await portal.call(run.id, 'check_friend_attendance', { friend: 'Rose', activity_id: 'bingo' })).rule, 'resident-consent');
  assert.equal((await care.agentCall(run.id, 'get_checkin_context', {})).ok, false);
  assert.equal((await store.query(run.pk, `GRANT#${run.id}`)).length, 0);
  const bob = await care.startRun(person('robert'), true, 'social');
  assert.equal((await portal.call(bob.id, 'check_friend_attendance', { friend: 'Rose', activity_id: 'bingo' })).rule, 'attendance-consent');
});
test('other resident medical access and conversational staff impersonation produce sanitized denials', async t => {
  const { portal, run, person } = await setup(t);
  assert.equal((await portal.call(run.id, 'check_access', { action: 'read_clinical_information', resident: 'Rose' })).rule, 'patient-binding');
  assert.equal((await portal.call(run.id, 'check_access', { action: 'claim_staff_privileges', resident: 'self' })).rule, 'staff-authentication');
  const log = (await portal.snapshot(person('admin'))).decisions;
  assert.equal(log.filter(d => d.decision === 'Denied').length, 2);
  assert.doesNotMatch(JSON.stringify(log), /heart failure|apixaban|quote|password|Bearer/);
});
test('only explicit speech creates a request; assigned staff response is returned from actual storage', async t => {
  const { portal, run, person } = await setup(t), quote = 'Please ask a caregiver to help me get to bingo.';
  assert.equal((await portal.call(run.id, 'request_caregiver_help', { quote })).ok, false);
  await portal.recordSpeech(run.id, quote);
  const result = await portal.call(run.id, 'request_caregiver_help', { quote }); assert.equal(result.ok, true);
  assert.equal((await portal.call(run.id, 'request_caregiver_help', { quote })).request_id, result.request_id);
  assert.equal((await portal.snapshot(person('sam'))).requests.length, 1);
  assert.equal((await portal.snapshot(person('lee'))).requests.length, 0);
  assert.equal((await portal.snapshot(person('admin'))).requests.length, 0);
  await assert.rejects(portal.respond(person('lee'), 'margaret', result.request_id, 'Coming'), /RESIDENT_SCOPE_DENIED/);
  await assert.rejects(portal.respond(person('admin'), 'margaret', result.request_id, 'Coming'), /RESIDENT_SCOPE_DENIED/);
  await portal.respond(person('sam'), 'margaret', result.request_id, 'I can meet you in the lobby at 2:45.');
  const reply = await portal.call(run.id, 'get_request_status', { request_id: result.request_id });
  assert.equal(reply.reply.author, 'Sam Rivera'); assert.equal(reply.reply.text, 'I can meet you in the lobby at 2:45.');
  assert.doesNotMatch(JSON.stringify((await portal.snapshot(person('admin'))).decisions), /lobby|2:45|Please ask/);
});
test('pause stops voice and prevents a new run; caregiver cannot edit policy', async t => {
  const { portal, care, run, person } = await setup(t); let stopped = false;
  care.voiceStops.set(run.id, async () => { stopped = true; });
  await assert.rejects(portal.updatePolicy(person('sam'), 'margaret', { paused: true }), /TOOL_NOT_ALLOWED/);
  await portal.updatePolicy(person('admin'), 'margaret', { paused: true }); assert.equal(stopped, true);
  assert.equal((await portal.call(run.id, 'read_activity_schedule', {})).ok, false);
  await assert.rejects(portal.beforeStart(person('margaret'), 'clinical'), /COMPANION_PAUSED/);
  await portal.updatePolicy(person('admin'), 'margaret', { paused: false }); await portal.beforeStart(person('margaret'), 'social');
});
test('policy revocation during authorization prevents a write despite a signed allow', async t => {
  const { portal, bridge, store, run } = await setup(t); await portal.recordSpeech(run.id, 'Please ask staff to help me.');
  const authorize = bridge.authorize.bind(bridge);
  bridge.authorize = async value => { const result = await authorize(value), p = await portal.policy('margaret'); await store.put({ ...p, version: p.version + 1, capabilities: { ...p.capabilities, help: false } }); return result; };
  assert.equal((await portal.call(run.id, 'request_caregiver_help', { quote: 'Please ask staff to help me.' })).ok, false);
  assert.equal((await store.query(run.pk, 'SOCIAL_REQUEST#')).length, 0);
});
test('withdrawn run consent blocks social access; clinical context still passes the real AgentPrint gateway', async t => {
  const { portal, care, store, run, person } = await setup(t);
  const consent = await store.get(run.pk, `CONSENT#${run.consent_ref}`); await store.put({ ...consent, active: false, version: consent.version + 1 });
  assert.equal((await portal.call(run.id, 'read_activity_schedule', {})).ok, false);
  const clinical = await care.startRun(person('margaret'), true);
  assert.equal((await care.agentCall(clinical.id, 'get_checkin_context', {})).ok, true);
  assert.ok((await portal.snapshot(person('admin'))).decisions.some(d => d.workflow === 'clinical' && d.print_id && d.decision === 'Allowed'));
});
test('registered identity survives bridge restart using persisted backend key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'humanloop-print-stable-')), keyFile = join(dir, 'keys.json');
  const a = new AgentPrintBridge({ keyFile }); await a.initialize(manifests, ['margaret']); const identity = a.identities[0]; a.close();
  const b = new AgentPrintBridge({ keyFile }); t.after(async () => { b.close(); await rm(dir, { recursive: true, force: true }); });
  await b.initialize(manifests, ['margaret']); assert.equal(b.identities[0].print_id, identity.print_id); assert.equal(b.identities[0].key_thumbprint, identity.key_thumbprint);
});
test('negated, hypothetical and unrequested help is not sent to the care team', async t => {
  const { portal, run, store } = await setup(t);
  for (const quote of ["I don't need help from staff.", 'If I need help I will ask a caregiver.', 'The nurse helped me yesterday.']) {
    await portal.recordSpeech(run.id, quote);
    assert.equal((await portal.call(run.id, 'request_caregiver_help', { quote })).code, 'EXPLICIT_REQUEST_REQUIRED');
  }
  assert.equal((await store.query(run.pk, 'SOCIAL_REQUEST#')).length, 0);
});

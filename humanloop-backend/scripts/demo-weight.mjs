// Explicit scenario selection only. Never interprets speech as a recorded measurement.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { DynamoStore } from '../server/care/store.mjs';
import { residentPK } from '../server/care/fixtures.mjs';
import { hasHeartFailureDemo } from '../server/care/heart-failure.mjs';
const residentId = process.argv[2], mode = process.argv[3];
if (!['margaret', 'robert'].includes(residentId)) throw new Error('Choose margaret or robert.');
if (!['baseline', 'weight-gain'].includes(mode)) throw new Error('Usage: node scripts/demo-weight.mjs margaret|robert baseline|weight-gain');
const cloud = JSON.parse(await readFile('.carealong-cloud.json'));
const identity = JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], { encoding: 'utf8' }));
if (identity.Account !== '389415889552' || cloud.account !== identity.Account) throw new Error('Wrong AWS account.');
const store = new DynamoStore(cloud.table, cloud.region), record = await store.get(residentPK(residentId), 'CONTEXT');
if (!hasHeartFailureDemo(record)) throw new Error('Apply the corresponding demo profile first.');
const now = Date.now();
const baseline = record.patient_profile.baseline.weight_lb;
const measurements = [baseline, mode === 'weight-gain' ? baseline + 3.5 : baseline].map((value, i) => ({
  kind: 'weight', value, unit: 'lb', at: new Date(now - (1 - i) * 86400000).toISOString(), synthetic: true,
  source_ref: `demo:staff-weight-record:${mode}:${now}:${i}`, source: 'Explicitly selected fictional staff-recorded morning weight; not a real scale reading',
}));
await store.transact([{ kind: 'put', item: { ...record, version: record.version + 1, measurements }, expectedVersion: record.version }]);
console.log(JSON.stringify({ resident: residentId, mode, measurements, simulation: true, note: 'Used at the next check-in turn. Baseline restores stable weights; speech remains separately reported.' }));

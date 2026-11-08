// Explicitly imports supplied demonstration profiles; never manufactures clinical question sets.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import Ajv from 'ajv';
import { DynamoStore } from '../server/care/store.mjs';
import { residentPK, residents } from '../server/care/fixtures.mjs';
import { validateDailyPlan } from '../server/care/daily-checkin.mjs';
const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/apply-patient-profiles.mjs <ignored-profile-file.json>');
const body = JSON.parse(await readFile(file, 'utf8'));
const schema = { type: 'object', required: ['profiles'], additionalProperties: false, properties: { profiles: { type: 'array', minItems: 1, maxItems: 20, items: {
  type: 'object', required: ['resident_id', 'daily_checkin'], additionalProperties: false, properties: {
    resident_id: { type: 'string', enum: residents.map(r => r.id) }, preferred_name: { anyOf: [{ type: 'string', minLength: 1, maxLength: 100 }, { type: 'null' }] },
    conditions: { anyOf: [{ type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 300 } }, { type: 'null' }] }, daily_checkin: { type: 'object' },
  },
} } } };
if (!new Ajv({ strict: true }).compile(schema)(body)) throw new Error('Invalid profile file. See config/patient-profiles.example.json.');
if (new Set(body.profiles.map(p => p.resident_id)).size !== body.profiles.length) throw new Error('Duplicate resident profile.');
for (const profile of body.profiles) validateDailyPlan(profile.daily_checkin);
const cloud = JSON.parse(await readFile('.carealong-cloud.json'));
const identity = JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], { encoding: 'utf8' }));
if (identity.Account !== '389415889552' || cloud.account !== identity.Account) throw new Error('Wrong AWS account.');
const store = new DynamoStore(cloud.table, cloud.region), ops = [];
for (const profile of body.profiles) {
  const old = await store.get(residentPK(profile.resident_id), 'CONTEXT');
  if (!old) throw new Error('Provision the resident before importing a profile.');
  const next = { ...old, version: old.version + 1, daily_checkin: profile.daily_checkin,
    ...(profile.preferred_name ? { preferred_name: profile.preferred_name } : {}), ...(profile.conditions !== null && profile.conditions !== undefined ? { conditions: profile.conditions } : {}),
    profile_source: 'User-supplied demonstration profile', profile_updated_at: new Date().toISOString() };
  ops.push({ kind: 'put', item: next, expectedVersion: old.version });
}
await store.transact(ops);
console.log(JSON.stringify({ updatedProfiles: body.profiles.map(p => p.resident_id), clinicalValidation: false }));

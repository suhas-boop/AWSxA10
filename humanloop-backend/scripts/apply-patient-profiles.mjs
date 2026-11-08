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
    medications: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 500 } },
    patient_profile: { type: 'object', additionalProperties: false, required: ['full_name', 'age', 'setting', 'personality', 'interests', 'baseline'], properties: { full_name: { type: 'string', maxLength: 100 }, age: { type: 'integer', minimum: 18, maximum: 120 }, setting: { type: 'string', maxLength: 300 }, personality: { type: 'string', maxLength: 1000 }, interests: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 300 } }, baseline: { type: 'object', additionalProperties: false, required: ['activity', 'sleep', 'weight_lb', 'weight_history', 'symptoms'], properties: { activity: { type: 'string', maxLength: 1000 }, sleep: { type: 'string', maxLength: 1000 }, weight_lb: { type: 'number', minimum: 50, maximum: 1000 }, weight_history: { type: 'string', maxLength: 1000 }, symptoms: { type: 'string', maxLength: 1000 } } } } },
    medication_history: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['name', 'started_days_before_profile'], properties: { name: { type: 'string', maxLength: 100 }, started_days_before_profile: { type: 'integer', minimum: 0, maximum: 365 } } } },
    demo_care_plan: { type: 'object', additionalProperties: false, required: ['id', 'simulated_alerts'], properties: { id: { enum: ['maggie-heart-failure-v1', 'bob-heart-failure-v1'] }, simulated_alerts: { const: true } } },
    conditions: { anyOf: [{ type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 300 } }, { type: 'null' }] }, daily_checkin: { type: 'object' },
  },
} } } };
if (!new Ajv({ strict: true }).compile(schema)(body)) throw new Error('Invalid profile file. See config/patient-profiles.example.json.');
if (new Set(body.profiles.map(p => p.resident_id)).size !== body.profiles.length) throw new Error('Duplicate resident profile.');
for (const profile of body.profiles) { validateDailyPlan(profile.daily_checkin); if (profile.demo_care_plan && profile.resident_id !== ({ 'maggie-heart-failure-v1': 'margaret', 'bob-heart-failure-v1': 'robert' })[profile.demo_care_plan.id]) throw new Error('Demo care plan does not match its bound resident.'); }
const cloud = JSON.parse(await readFile('.carealong-cloud.json'));
const identity = JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], { encoding: 'utf8' }));
if (identity.Account !== '389415889552' || cloud.account !== identity.Account) throw new Error('Wrong AWS account.');
const store = new DynamoStore(cloud.table, cloud.region), ops = [];
for (const profile of body.profiles) {
  const old = await store.get(residentPK(profile.resident_id), 'CONTEXT');
  if (!old) throw new Error('Provision the resident before importing a profile.');
  const next = { ...old, version: old.version + 1, daily_checkin: profile.daily_checkin,
    ...Object.fromEntries(['medications', 'patient_profile', 'demo_care_plan'].filter(key => profile[key] !== undefined).map(key => [key, profile[key]])),
    ...(profile.patient_profile ? { age: profile.patient_profile.age, name: profile.patient_profile.full_name } : {}),
    ...(profile.medication_history ? { medication_history: profile.medication_history.map(m => ({ name: m.name, started_at: new Date(Date.now() - m.started_days_before_profile * 86400000).toISOString(), source: 'User-supplied fictional medication record', days_before_profile: m.started_days_before_profile })) } : {}),
    source: 'User-supplied fictional demonstration profile', source_ref: `demo-profile:${profile.resident_id}:${profile.daily_checkin.version}`, verified_at: new Date().toISOString(),
    ...(profile.preferred_name ? { preferred_name: profile.preferred_name } : {}), ...(profile.conditions !== null && profile.conditions !== undefined ? { conditions: profile.conditions } : {}),
    profile_source: 'User-supplied demonstration profile', profile_updated_at: new Date().toISOString() };
  ops.push({ kind: 'put', item: next, expectedVersion: old.version });
}
await store.transact(ops);
console.log(JSON.stringify({ updatedProfiles: body.profiles.map(p => p.resident_id), clinicalValidation: false }));

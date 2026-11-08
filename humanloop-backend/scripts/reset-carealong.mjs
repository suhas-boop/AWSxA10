// Deliberate, account-scoped reset of synthetic application state; never deletes cloud resources.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoStore } from '../server/care/store.mjs';
import { orgPK, residents, residentPK } from '../server/care/fixtures.mjs';
const cloud = JSON.parse(await readFile('.carealong-cloud.json'));
const who = JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], { encoding: 'utf8' }));
if (who.Account !== '389415889552' || cloud.account !== who.Account || !/^carealong-[a-z0-9]+-state$/.test(cloud.table)) throw new Error('Reset target is not the configured hackathon demo');
const store = new DynamoStore(cloud.table, cloud.region);
const rows = (await Promise.all([orgPK, ...residents.map(r => residentPK(r.id))].map(pk => store.query(pk)))).flat();
const removable = rows.filter(r => r.sk !== 'CONTEXT' && !r.sk.startsWith('MEMBER#'));
console.log(JSON.stringify({ account: who.Account, table: cloud.table, syntheticRowsToDelete: removable.length, retained: 'Resident fixtures, memberships, Cognito identities and cloud resources' }));
if (!process.argv.includes('--confirm-synthetic-reset')) { console.log('Dry run only. Stop the backend, then add --confirm-synthetic-reset to delete these synthetic sessions, tasks, evidence, grants and logins.'); process.exit(0); }
let running = false;
try { running = (await fetch(`http://127.0.0.1:${process.env.PORT || 8080}/ping`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
if (running) throw new Error('Stop the backend before resetting synthetic state');
for (const row of removable) await store.client.send(new DeleteCommand({ TableName: cloud.table, Key: { pk: row.pk, sk: row.sk },
  ConditionExpression: '#v = :version', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':version': row.version } }));
console.log(`Reset ${removable.length} synthetic records. Restart the backend and sign in again.`);
store.client.destroy();

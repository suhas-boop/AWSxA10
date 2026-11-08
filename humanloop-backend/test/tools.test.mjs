import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRunner } from '../server/tool-runner.mjs';
import { principal, testTool, until } from './helpers.mjs';
const call = (id = 'call-1', content = '{}') => ({ toolUseId: id, toolName: 'test_tool', content });
function setup(options = {}) {
  const events = [];
  return { events, runner: new ToolRunner({ tools: [testTool()], principal: principal(), authorize: async () => true, emit: e => events.push(e), ...options }) };
}
test('duplicate tool events execute once', async () => {
  let count = 0;
  const { runner, events } = setup({ tools: [testTool({ execute: async () => { count++; return 'done'; } })] });
  const [a, b] = await Promise.all([runner.execute(call()), runner.execute(call())]);
  assert.equal(count, 1); assert.deepEqual(a, b); assert.equal(a.ok, true);
  assert.deepEqual(events.map(x => x.status), ['requested', 'allowed', 'completed']);
});
test('unknown tools, invalid arguments and missing permission never execute', async () => {
  let count = 0;
  const { runner } = setup({ tools: [testTool({ execute: async () => { count++; } })], authorize: async () => false });
  assert.equal((await runner.execute(call())).ok, false);
  assert.equal((await runner.execute(call('invalid', '{"userId":"someone-else"}'))).ok, false);
  assert.equal((await runner.execute({ ...call('unknown'), toolName: 'delete_all' })).ok, false);
  assert.equal(count, 0);
});
test('expired identities and revoked access are rejected', async () => {
  const { runner } = setup({ principal: { ...principal(), expiresAt: 0 } });
  assert.equal((await runner.execute(call())).error, 'Authentication expired');
  runner.principal = principal(); runner.setEnabled(false);
  assert.equal((await runner.execute(call('new'))).error, 'Tool access revoked');
});
test('revocation during authorization prevents execution', async () => {
  let release, count = 0;
  const { runner } = setup({ authorize: () => new Promise(resolve => { release = resolve; }), tools: [testTool({ execute: async () => { count++; return {}; } })] });
  const pending = runner.execute(call());
  await until(() => release); runner.setEnabled(false); release(true);
  assert.equal((await pending).ok, false); assert.equal(count, 0);
});
test('timeouts and thrown failures return a tool error without exposing secrets', async () => {
  const { runner } = setup({ timeoutMs: 5, tools: [testTool({ execute: () => new Promise(() => {}) })] });
  assert.equal((await runner.execute(call())).error, 'Tool timed out');
  const { runner: failing } = setup({ tools: [testTool({ execute: async () => { throw new Error('private credentials'); } })] });
  assert.equal((await failing.execute(call())).error, 'Tool execution failed');
});
test('each new call rechecks the authoritative policy', async () => {
  let granted = true;
  const { runner } = setup({ authorize: async () => granted });
  assert.equal((await runner.execute(call('a'))).ok, true);
  granted = false;
  assert.equal((await runner.execute(call('b'))).ok, false);
});

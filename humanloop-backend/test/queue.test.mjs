import test from 'node:test';
import assert from 'node:assert/strict';
import { EventQueue } from '../server/queue.mjs';
test('queue wakes its consumer and drains before closing', async () => {
  const queue = new EventQueue();
  const waiting = queue.next(); queue.push(1);
  assert.deepEqual(await waiting, { value: 1, done: false });
  queue.push(2); queue.close();
  assert.deepEqual(await queue.next(), { value: 2, done: false });
  assert.equal((await queue.next()).done, true);
  assert.throws(() => queue.push(3), /closed/);
});
test('audio congestion is bounded', () => {
  const queue = new EventQueue(1); queue.push(1);
  assert.throws(() => queue.push(2), /congested/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { demoPrefillAllowed } from '../server/care/demo-prefill.mjs';
const request = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers: { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080', ...headers }, socket: { remoteAddress } });
test('password prefill requires explicit local demo enablement', () => {
  assert.equal(demoPrefillAllowed(request(), { enabled: false, host: '127.0.0.1' }), false);
  assert.equal(demoPrefillAllowed(request(), { enabled: true, host: '127.0.0.1' }), true);
  assert.equal(demoPrefillAllowed(request(), { enabled: true, host: '0.0.0.0' }), false);
});
test('password prefill rejects remote, forwarded and non-local browser hosts', () => {
  const options = { enabled: true, host: '127.0.0.1' };
  for (const r of [request({}, '192.168.1.5'), request({ host: 'demo.example.com' }), request({ origin: 'https://demo.example.com' }), request({ 'x-forwarded-for': '127.0.0.1' }), request({ forwarded: 'for=127.0.0.1' })]) assert.equal(demoPrefillAllowed(r, options), false);
  assert.equal(demoPrefillAllowed(request({ host: 'localhost:8080', origin: 'http://localhost:5173' }, '::ffff:127.0.0.1'), options), true);
});

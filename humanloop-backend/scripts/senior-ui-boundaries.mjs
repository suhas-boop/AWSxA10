// Browser-only lifecycle checks with explicitly mocked API/voice events.
import { chromium, expect } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ permissions: ['microphone'] });
const page = await context.newPage(), errors = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  window.__boundary = { tracks: [], playbackStops: 0 };
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async c => { const s = await capture(c); window.__boundary.tracks.push(...s.getTracks()); return s; };
  const create = AudioContext.prototype.createBufferSource;
  AudioContext.prototype.createBufferSource = function () { const source = create.call(this), stop = source.stop.bind(source); source.stop = (...args) => { window.__boundary.playbackStops++; return stop(...args); }; return source; };
});
let releaseStart, starts = 0, stops = 0, socket, reconnects = 0;
const pendingStart = new Promise(r => { releaseStart = r; });
const state = { actor: { name: 'Test resident', role: 'resident', username: 'margaret' }, tasks: [], drafts: [], run: null };
await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  if (path === '/api/config') return json({ identities: [{ username: 'margaret', name: 'Test resident', role: 'resident' }] });
  if (path === '/api/login') return json({ token: 'synthetic-browser-test-token' });
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(state)}\n\n` });
  if (path === '/api/state') return json(state);
  if (path === '/api/runs') { starts++; const id = `mock-run-${starts}`; if (starts === 1) await pendingStart; state.run = { id, state: 'ACTIVE' }; return json({ id, createdAt: new Date().toISOString() }); }
  if (path.endsWith('/stop')) { stops++; state.run.state = 'STOPPED'; }
  return json({ ok: true });
});
await page.routeWebSocket('**/ws?*', ws => { socket = ws; setTimeout(() => ws.send(JSON.stringify({ type: 'status', status: 'listening' })), 100); ws.onMessage(m => { if (typeof m === 'string' && JSON.parse(m).type === 'reconnect') { reconnects++; ws.send(JSON.stringify({ type: 'status', status: 'renewing' })); setTimeout(() => ws.send(JSON.stringify({ type: 'status', status: 'listening' })), 100); } }); });
try {
  await page.goto('http://127.0.0.1:8080'); await page.getByLabel('Password', { exact: true }).fill('test-only'); await page.getByRole('button', { name: 'Sign in securely' }).click();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Start voice', exact: true }).click();
  await expect.poll(() => starts).toBe(1);
  await page.getByRole('button', { name: 'End check-in', exact: true }).click(); releaseStart();
  await expect.poll(() => stops).toBe(1);
  expect(await page.evaluate(() => window.__boundary.tracks.filter(t => t.readyState === 'live').length)).toBe(0);
  expect(socket).toBeUndefined(); checks.push('cancel during delayed run creation closes microphone and stops late-created run without opening a socket');
  await page.getByRole('button', { name: 'Start voice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reconnect voice' })).toBeVisible();
  const send = m => socket.send(JSON.stringify(m));
  send({ type: 'transcript', id: 'same-turn', role: 'USER', text: 'Hello', final: false });
  send({ type: 'transcript', id: 'same-turn', role: 'USER', text: 'Hello there.', final: true });
  await expect(page.locator('[data-turn-id="same-turn"]')).toHaveCount(1);
  await expect(page.locator('[data-turn-id="same-turn"]')).toContainText('Hello there.');
  send({ type: 'audio', data: Buffer.alloc(96000).toString('base64') });
  await expect(page.getByText('Your companion is speaking', { exact: true })).toBeVisible();
  send({ type: 'interrupt' }); await expect.poll(() => page.evaluate(() => window.__boundary.playbackStops)).toBeGreaterThan(0);
  send({ type: 'audio', data: Buffer.alloc(96000).toString('base64') });
  await expect(page.getByText('Your companion is speaking', { exact: true })).toBeVisible();
  checks.push('partial/final captions replace by ID; interruption clears queued audio and later audio still plays');
  await page.getByRole('button', { name: 'Reconnect voice' }).click(); await expect.poll(() => reconnects).toBe(1);
  await expect(page.getByText('Listening…', { exact: true })).toBeVisible();
  await expect(page.getByText('Reconnecting. Repeat your last sentence when Listening returns.', { exact: true })).toHaveCount(0);
  const box = await page.getByLabel('Type your response').boundingBox(); expect(box.width).toBeGreaterThan(250);
  send({ type: 'error', message: 'Synthetic disconnect for regression check.' });
  await expect(page.getByRole('button', { name: 'Start voice', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__boundary.tracks.filter(t => t.readyState === 'live').length)).toBe(0);
  await expect(page.locator('[data-turn-id]')).toHaveCount(1);
  checks.push('reconnect notice clears, text input has usable width, and disconnect stops capture without a scripted reply');
  expect(errors).toEqual([]);
} finally {
  await context.close(); await browser.close(); await mkdir('data', { recursive: true });
  await writeFile('data/senior-ui-boundaries.json', JSON.stringify({ at: new Date().toISOString(), source: 'Mocked browser API and voice events; actual audio capture/playback lifecycle', checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }));
}

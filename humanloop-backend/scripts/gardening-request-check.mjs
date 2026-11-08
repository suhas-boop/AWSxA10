// Real root-page voice -> assigned staff browser -> saved reply -> spoken reply.
// Input is generated speech through Chromium's fake microphone, not a human mic.
import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const origin = 'http://127.0.0.1:8080';
await mkdir('data/gardening-request', { recursive: true });
const chunks = [Buffer.alloc(32000 * 18)];
for (const [i, line] of ['Uh can you ask the caregiver to help me', 'with gardening?'].entries()) {
  const file = `data/gardening-request/part-${i}`;
  execFileSync('say', ['-o', file + '.aiff', line]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', file + '.aiff', file + '.wav']);
  const wav = await readFile(file + '.wav');
  for (let p = 12; p < wav.length;) { const n = wav.readUInt32LE(p + 4); if (wav.toString('ascii', p, p + 4) === 'data') { chunks.push(wav.subarray(p + 8, p + 8 + n)); break; } p += 8 + n + n % 2; }
  chunks.push(Buffer.alloc(i ? 32000 * 180 : 32000 * 0.3));
}
const pcm = Buffer.concat(chunks), header = Buffer.alloc(44);
header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
await writeFile('data/gardening-request/microphone.wav', Buffer.concat([header, pcm]));
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve('data/gardening-request/microphone.wav')}`, '--autoplay-policy=no-user-gesture-required'] });
const report = { at: new Date().toISOString(), checks: [], errors: [] };
let resident, staff;
const state = page => page.evaluate(async () => fetch('/api/state', { headers: { Authorization: `Bearer ${sessionStorage.getItem('carealong-session')}` } }).then(r => r.json()));
try {
  const staffContext = await browser.newContext(), residentContext = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1200, height: 1000 } });
  staff = await staffContext.newPage(); resident = await residentContext.newPage();
  for (const page of [staff, resident]) page.on('pageerror', e => report.errors.push(e.message));
  await resident.addInitScript(() => {
    window.__gardening = { turns: [], audio: 0, errors: [] }; const Base = window.WebSocket;
    window.WebSocket = class extends Base { constructor(...args) { super(...args); this.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.type === 'transcript' && m.final) window.__gardening.turns.push({ role: m.role, text: m.text }); if (m.type === 'audio') window.__gardening.audio++; if (m.type === 'error') window.__gardening.errors.push(m.message); }); } };
  });
  await staff.goto(origin + '/#/staff');
  await expect(staff.getByLabel('Who is signing in?')).toHaveValue('sam');
  await expect.poll(async () => (await staff.getByLabel('Password', { exact: true }).inputValue()).length).toBeGreaterThan(0);
  await staff.getByRole('button', { name: 'Sign in securely' }).click(); await expect(staff.locator('.staff-shell')).toBeVisible({ timeout: 25000 });
  await resident.goto(origin);
  await expect.poll(async () => (await resident.getByLabel('Password', { exact: true }).inputValue()).length).toBeGreaterThan(0);
  await resident.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(resident.getByRole('button', { name: 'Start voice', exact: true }).first()).toBeVisible({ timeout: 25000 });
  await resident.getByRole('button', { name: 'Start voice', exact: true }).first().click();
  await expect.poll(async () => (await state(resident)).run?.workflow, { timeout: 25000 }).toBe('social');
  report.runId = (await state(resident)).run.id; report.checks.push('Root user view starts an authenticated everyday companion run');
  let request;
  await expect.poll(async () => { request = (await state(staff)).requests.find(r => r.run_id === report.runId && /gardening/i.test(r.quote)); return !!request; }, { timeout: 90000 }).toBe(true);
  expect(request.status).toBe('NEEDS_ATTENTION'); report.requestId = request.id;
  const card = staff.locator('.staff-request').filter({ has: staff.locator(`#reply-${request.id}`) });
  await expect(card.locator('blockquote')).toContainText(/gardening/i, { timeout: 15000 });
  await expect(card.getByText('Needs attention', { exact: true })).toBeVisible();
  await card.screenshot({ path: 'data/gardening-request/staff-inbox.png' });
  report.checks.push('Actual spoken gardening request appears as Needs attention in Sam’s live browser without refreshing');
  const before = await resident.evaluate(() => window.__gardening.turns.length);
  await card.getByRole('textbox').fill('I can meet you in the courtyard at 10 to help with gardening.');
  await card.getByRole('button', { name: 'Send reply', exact: true }).click();
  await expect(card.getByText('Reply saved', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => resident.evaluate(n => window.__gardening.turns.slice(n).filter(t => t.role === 'ASSISTANT').map(t => t.text).join(' '), before), { timeout: 60000 }).toMatch(/Sam.*courtyard|courtyard.*Sam/is);
  report.metrics = await resident.evaluate(() => window.__gardening);
  expect(report.metrics.audio).toBeGreaterThan(0); expect(report.metrics.errors).toEqual([]); expect(report.errors).toEqual([]);
  report.checks.push('Sam’s saved reply is automatically fetched and spoken through the same live conversation'); report.passed = true;
} finally {
  if (resident) await resident.getByRole('button', { name: 'End check-in', exact: true }).first().click({ timeout: 3000 }).catch(() => {});
  for (const page of [resident, staff].filter(Boolean)) await page.evaluate(async () => { const token = sessionStorage.getItem('carealong-session'); if (token) await fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }); }).catch(() => {});
  await browser.close(); await writeFile('data/gardening-request-check.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: !!report.passed, checks: report.checks, errors: report.errors, runId: report.runId, requestId: report.requestId }));
}

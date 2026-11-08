import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const origin = process.env.CAREALONG_URL || 'http://127.0.0.1:8080';
const passwords = JSON.parse(await readFile('.carealong-secrets.json')).passwords;
await mkdir('data/ui-voice', { recursive: true }); await mkdir('data/screenshots', { recursive: true });
const lines = ['I have a cough.', "It's new.", 'Not severe but a little bit uncomfortable.', 'Thank you for listening to me. Can you still hear me?'];
const chunks = [Buffer.alloc(16000 * 2 * 12)];
for (let i = 0; i < lines.length; i++) {
  const base = `data/ui-voice/line-${i}`;
  execFileSync('say', ['-o', base + '.aiff', lines[i]]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', base + '.aiff', base + '.wav']);
  const wav = await readFile(base + '.wav');
  for (let p = 12; p < wav.length;) { const n = wav.readUInt32LE(p + 4); if (wav.toString('ascii', p, p + 4) === 'data') { chunks.push(wav.subarray(p + 8, p + 8 + n)); break; } p += 8 + n + n % 2; }
  chunks.push(Buffer.alloc(16000 * 2 * (i === 2 ? 35 : 22)));
}
const audio = Buffer.concat(chunks), header = Buffer.alloc(44);
header.write('RIFF'); header.writeUInt32LE(36 + audio.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(audio.length, 40);
await writeFile('data/ui-voice/fixture.wav', Buffer.concat([header, audio]));
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve('data/ui-voice/fixture.wav')}`, '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 1100 } });
const page = await context.newPage(), errors = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  window.__voiceCheck = { audio: 0, input: 0, streamErrors: [], finalUsers: 0, finalAssistant: 0, statuses: [], authorizedSocket: false, tracks: [], turns: [] };
  const Base = window.WebSocket;
  window.WebSocket = class extends Base {
    constructor(url, protocols) { super(url, protocols); window.__voiceSocket = this; window.__voiceCheck.authorizedSocket = Array.isArray(protocols) && protocols.includes('carealong') && protocols.some(p => p.startsWith('carealong-token.'));
      this.addEventListener('message', e => { try { const m = JSON.parse(e.data), c = window.__voiceCheck; if (m.type === 'error') c.streamErrors.push(m.message); if (m.type === 'audio') c.audio++; if (m.type === 'status') c.statuses.push(m.status); if (m.type === 'transcript' && m.final) { if (m.role === 'USER') c.finalUsers++; else c.finalAssistant++; c.turns.push({ role: m.role, text: m.text }); } } catch {} });
    }
    send(data) { if (typeof data !== 'string') window.__voiceCheck.input++; super.send(data); }
  };
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => { const stream = await capture(constraints); window.__voiceCheck.tracks.push(...stream.getTracks()); return stream; };
});
let runId;
const metrics = () => page.evaluate(() => { const { tracks, ...rest } = window.__voiceCheck; return { ...rest, liveTracks: tracks.filter(t => t.readyState === 'live').length }; });
try {
  await page.goto(origin); await page.getByLabel('Who is signing in?').selectOption('daniel'); await page.getByLabel('Password', { exact: true }).fill(passwords.daniel); await page.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(page.getByRole('button', { name: 'Start voice', exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('button', { name: 'Start voice', exact: true })).toBeEnabled();
  await expect(page.locator('footer.stage-controls')).toHaveCount(0);
  expect((await metrics()).liveTracks).toBe(0);
  await expect(page.getByText('Dr. Miller', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'data/screenshots/humanloop-senior-idle.png', fullPage: true });
  checks.push('real resident login opens committed voice stage directly; microphone remains off until companion is tapped');
  await page.getByRole('button', { name: 'Start voice', exact: true }).click();
  await expect(page.getByText('Listening…', { exact: true })).toBeVisible({ timeout: 25000 });
  await expect.poll(async () => (await metrics()).finalAssistant, { timeout: 10000 }).toBeGreaterThan(0);
  expect((await metrics()).finalUsers).toBe(0);
  checks.push('agent begins with its own spoken greeting before any resident speech');
  await expect(page.locator('.current-question')).toContainText('Is the cough new', { timeout: 30000 });
  await expect(page.locator('.current-question')).toContainText('severe difficulty breathing', { timeout: 35000 });
  await expect(page.locator('.current-question')).toContainText('prepare a request', { timeout: 35000 });
  await expect.poll(async () => (await metrics()).finalAssistant, { timeout: 25000 }).toBeGreaterThanOrEqual(3);
  await expect.poll(async () => { const turns = (await metrics()).turns; const answer = turns.findIndex(t => t.role === 'USER' && /not severe/i.test(t.text)); return turns.slice(answer + 1).filter(t => t.role === 'ASSISTANT').map(t => t.text).join(' '); }, { timeout: 25000 }).toMatch(/prepare.*request|care team.*review|discomfort|uncomfortable/i);
  const beforeReconnect = await metrics(); expect(beforeReconnect.input).toBeGreaterThan(100); expect(beforeReconnect.audio).toBeGreaterThan(0); expect(beforeReconnect.authorizedSocket).toBe(true); expect(beforeReconnect.finalUsers).toBeGreaterThanOrEqual(3); expect(beforeReconnect.turns.some(t => /application event:/i.test(t.text))).toBe(false);
  checks.push('real browser microphone, shared AudioWorklet, authenticated Bedrock stream, audio and captions across three scenario turns');
  const state = await page.evaluate(async () => fetch('/api/state', { headers: { Authorization: `Bearer ${sessionStorage.getItem('carealong-session')}` } }).then(r => r.json())); runId = state.run.id;
  expect(state.incident.phase).toBe('ready'); expect(state.incident.severe_breathing).toBe(false);
  expect(state.evidence.some(e => /not severe.*uncomfortable/i.test(e.statement))).toBe(true);
  checks.push('spoken indirect answer advances real controller and retains discomfort');
  await page.evaluate(() => window.__voiceSocket.send(JSON.stringify({ type: 'reconnect' })));
  await expect.poll(async () => (await metrics()).statuses.filter(s => s === 'listening').length, { timeout: 20000 }).toBe(2);
  await expect.poll(async () => (await metrics()).finalUsers, { timeout: 55000 }).toBeGreaterThan(beforeReconnect.finalUsers);
  await expect.poll(async () => (await metrics()).audio, { timeout: 20000 }).toBeGreaterThan(beforeReconnect.audio);
  await expect.poll(async () => (await metrics()).finalAssistant, { timeout: 20000 }).toBeGreaterThan(beforeReconnect.finalAssistant);
  checks.push('reconnect keeps microphone alive and receives another actual spoken response');
  await page.screenshot({ path: 'data/screenshots/humanloop-senior-live.png', fullPage: true });
  await page.getByRole('button', { name: 'End check-in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start voice', exact: true })).toBeVisible({ timeout: 20000 });
  expect((await metrics()).liveTracks).toBe(0);
  checks.push('end check-in releases every microphone track');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.screenshot({ path: 'data/screenshots/humanloop-senior-mobile.png', fullPage: true });
  checks.push('390px layout without horizontal overflow');
  expect(errors).toEqual([]);
} finally {
  const result = { at: new Date().toISOString(), source: 'Generated speech through Chromium fake microphone into real Cognito/DynamoDB/Bedrock; not a human microphone', checks, errors, runId, metrics: await metrics().catch(() => null) };
  await page.evaluate(async () => { const headers = { Authorization: `Bearer ${sessionStorage.getItem('carealong-session')}`, 'Content-Type': 'application/json' }; const state = await fetch('/api/state', { headers }).then(r => r.json()); if (state.run?.state === 'ACTIVE') await fetch(`/api/runs/${state.run.id}/stop`, { method: 'POST', headers, body: '{}' }); }).catch(() => {});
  await context.close(); await browser.close(); await writeFile('data/senior-ui-check.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}

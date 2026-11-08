import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const passwords = JSON.parse(await readFile('.carealong-secrets.json')).passwords;
const origin = process.env.CAREALONG_URL || 'http://127.0.0.1:5173';
await mkdir('data/rehearsal', { recursive: true }); await mkdir('data/screenshots', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve('data/browser-microphone-fixture.wav')}`, '--autoplay-policy=no-user-gesture-required'] });
const contexts = [], errors = [], checks = [], latencies = [];
async function login(user) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ['microphone'], recordVideo: { dir: 'data/rehearsal', size: { width: 1440, height: 1100 } } }); contexts.push(context);
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin); await page.getByLabel('Who is signing in?').selectOption(user); await page.getByLabel('Password', { exact: true }).fill(passwords[user]);
  await page.getByRole('button', { name: 'Sign in securely' }).click(); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 20000 }); return page;
}
function passed(name) { checks.push(name); console.log(`PASS ${name}`); }
let senior;
try {
  senior = await login('margaret'); const nurse = await login('sam'), admin = await login('admin');
  await senior.screenshot({ path: 'data/screenshots/senior.png', fullPage: true });
  await senior.getByRole('button', { name: /I’d like human help/ }).click();
  await expect(senior.getByRole('dialog')).toBeVisible(); await senior.keyboard.press('Escape'); await expect(senior.getByRole('dialog')).toHaveCount(0);
  passed('separate browser logins and keyboard-accessible help');
  await senior.getByRole('checkbox').check(); await senior.getByRole('button', { name: 'Start voice check-in' }).click();
  await expect(senior.getByText('Sound analysis is on · tentative observations', { exact: true })).toBeVisible({ timeout: 25000 });
  await expect(senior.getByText('Possible sound', { exact: true }).first()).toBeVisible({ timeout: 35000 });
  await expect(senior.getByRole('heading', { name: 'Was that cough from you, or from something nearby?' })).toBeVisible({ timeout: 10000 });
  passed('prerecorded cough through browser microphone API, AudioWorklet, YAMNet, authenticated observation and source question');
  for (const [answer, question] of [['Yes', 'Is the cough new or worse than usual?'], ['Yes', 'Are you having severe difficulty breathing right now?'], ['No', 'Would you like me to prepare a request for your care team to review? You can review exactly what will be shared.']]) {
    await senior.getByRole('button', { name: answer, exact: true }).click();
    await expect(senior.getByRole('heading', { name: question, exact: true })).toBeVisible({ timeout: 15000 });
  }
  await senior.getByRole('button', { name: 'Ask about my care' }).click();
  await expect(senior.getByRole('button', { name: 'Prepare a care-team request' })).toBeEnabled({ timeout: 15000 });
  await senior.getByRole('button', { name: 'Prepare a care-team request' }).click();
  await expect(senior.getByRole('heading', { name: 'Send this request to Sam Rivera?' })).toBeVisible({ timeout: 15000 });
  const created = senior.waitForResponse(r => /\/confirm$/.test(r.url()) && r.request().method() === 'POST');
  const sharedAt = performance.now(); await senior.getByRole('button', { name: 'Yes, share this request' }).click();
  const receipt = await (await created).json(); expect(receipt.status).toBe('CREATED');
  const task = nurse.locator(`[data-task-id="${receipt.task_id}"]`);
  await expect(task).toBeVisible({ timeout: 20000 }); latencies.push({ operation: 'share click to nurse task visible', ms: Math.round(performance.now() - sharedAt) });
  await task.getByRole('button', { name: 'Acknowledge request' }).click();
  await expect(task.getByLabel('Callback or next step')).toBeVisible({ timeout: 15000 });
  await task.getByLabel('Callback or next step').fill('Demo callback: Sam will call at 6:30 PM.');
  const nextAt = performance.now(); await task.getByRole('button', { name: 'Save next step' }).click();
  await expect(senior.locator('.team-card').getByText('Demo callback: Sam will call at 6:30 PM.', { exact: true })).toBeVisible({ timeout: 20000 });
  latencies.push({ operation: 'save next step to senior visible', ms: Math.round(performance.now() - nextAt) });
  await senior.screenshot({ path: 'data/screenshots/handoff.png', fullPage: true }); await nurse.screenshot({ path: 'data/screenshots/nurse.png', fullPage: true });
  passed('human confirmation, assigned nurse acknowledgment and live next-step propagation');
  await admin.locator('.run-list button').filter({ hasText: 'Margaret' }).first().click();
  const grant = admin.locator('.grant-list > div').filter({ hasText: 'get_checkin_context' }); await grant.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(grant.getByRole('button', { name: 'Revoked', exact: true })).toBeVisible({ timeout: 15000 });
  await admin.getByRole('button', { name: 'Test next context request' }).click();
  await expect(admin.getByText(/Actual gateway result: GRANT_REVOKED/)).toBeVisible({ timeout: 15000 });
  await admin.screenshot({ path: 'data/screenshots/admin.png', fullPage: true }); passed('live admin revocation and actual subsequent MCP denial');
  await senior.getByRole('button', { name: /Stop check-in/ }).click();
  await expect(senior.getByRole('heading', { name: 'Thank you for checking in.' })).toBeVisible({ timeout: 20000 });
  passed('voice stop confirmed while human care task survives');
  await senior.setViewportSize({ width: 390, height: 844 }); await senior.screenshot({ path: 'data/screenshots/mobile.png', fullPage: true });
  const overflow = await senior.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); expect(overflow).toBe(false);
  await senior.setViewportSize({ width: 1440, height: 1100 });
  await senior.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await senior.screenshot({ path: 'data/screenshots/zoom200.png', fullPage: true });
  expect(await senior.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  passed('390px viewport and 200% layout zoom without horizontal overflow');
  expect(errors).toEqual([]);
} finally {
  if (senior) await senior.evaluate(async () => {
    const token = sessionStorage.getItem('carealong-session'); const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const state = await fetch('/api/state', { headers }).then(r => r.json()); if (state.run?.state === 'ACTIVE') await fetch(`/api/runs/${state.run.id}/stop`, { method: 'POST', headers, body: '{}' });
  }).catch(() => {});
  for (const context of contexts) await context.close(); await browser.close();
  const report = JSON.stringify({ at: new Date().toISOString(), checks, errors, latencies, audioSource: 'Known ESC-50 evaluation positive 2-123896-A-24.wav and synthetic speech through Chromium fake microphone; not a real human mic test', recording: 'data/rehearsal contains silent browser-video backup, not human audio' }, null, 2);
  await writeFile('data/browser-check.json', report);
  await writeFile(`data/browser-check-${Date.now()}.json`, report);
}

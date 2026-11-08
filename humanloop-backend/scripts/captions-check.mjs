// Focused UI regression: mocked voice events, real sign-in/run, no Bedrock claim.
import { chromium, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
const origin = process.env.CAREALONG_URL || 'http://127.0.0.1:8080';
const passwords = JSON.parse(await readFile('.carealong-secrets.json')).passwords;
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 1100 } });
const page = await context.newPage(), errors = [], checks = [];
let socket, reconnects = 0;
page.on('pageerror', e => errors.push(e.message));
await page.routeWebSocket('**/ws?*', ws => {
  socket = ws;
  setTimeout(() => ws.send(JSON.stringify({ type: 'status', status: 'listening' })), 100);
  ws.onMessage(data => {
    if (typeof data !== 'string') return;
    if (JSON.parse(data).type === 'reconnect') {
      reconnects++;
      ws.send(JSON.stringify({ type: 'status', status: 'renewing' }));
      setTimeout(() => ws.send(JSON.stringify({ type: 'status', status: 'listening' })), 200);
    }
  });
});
const send = (i) => socket.send(JSON.stringify({ type: 'transcript', id: `fixture-${i}`, role: i % 2 ? 'ASSISTANT' : 'USER', text: `Synthetic caption ${i}. This paragraph exercises scrolling during a continuing conversation.`, final: true }));
const gap = () => page.locator('.transcript').evaluate(p => p.scrollHeight - p.scrollTop - p.clientHeight);
try {
  await page.goto(origin + '/#/check-in'); await page.getByLabel('Who is signing in?').selectOption('robert');
  await page.getByLabel('Password', { exact: true }).fill(passwords.robert);
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Start voice check-in' }).click();
  await expect(page.getByRole('button', { name: 'Reconnect voice' })).toBeEnabled({ timeout: 20000 });
  for (let i = 0; i < 18; i++) { send(i); await expect(page.locator('.turn')).toHaveCount(i + 1); await expect.poll(gap).toBeLessThan(2); }
  checks.push('18 caption blocks remain visible at the bottom as new captions arrive');
  await page.locator('.transcript').evaluate(p => { p.scrollTop = 0; });
  await expect(page.getByRole('button', { name: 'Jump to latest captions' })).toBeVisible();
  send(18); await expect(page.locator('.turn')).toHaveCount(19);
  expect(await page.locator('.transcript').evaluate(p => p.scrollTop)).toBe(0);
  await page.getByRole('button', { name: 'Jump to latest captions' }).click();
  await expect.poll(gap).toBeLessThan(2);
  checks.push('reading earlier captions is preserved and Jump to latest restores following');
  await page.getByRole('button', { name: 'Reconnect voice' }).click();
  await expect.poll(() => reconnects).toBe(1);
  await expect(page.getByRole('button', { name: 'Reconnect voice' })).toBeEnabled();
  send(19); await expect(page.locator('.turn')).toHaveCount(20); await expect.poll(gap).toBeLessThan(2);
  checks.push('reconnect control resumes capture and keeps existing captions');
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'data/screenshots/captions-follow.png', fullPage: true });
} finally {
  await page.evaluate(async () => {
    const headers = { Authorization: `Bearer ${sessionStorage.getItem('carealong-session')}`, 'Content-Type': 'application/json' };
    const state = await fetch('/api/state', { headers }).then(r => r.json());
    if (state.run?.state === 'ACTIVE') await fetch(`/api/runs/${state.run.id}/stop`, { method: 'POST', headers, body: '{}' });
  }).catch(() => {});
  await context.close(); await browser.close();
  const report = { at: new Date().toISOString(), source: 'Mocked voice WebSocket events in compiled UI; real Cognito sign-in and run lifecycle', checks, errors };
  await writeFile('data/captions-check.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}

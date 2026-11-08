import { chromium, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const passwords = JSON.parse(await readFile('.carealong-secrets.json')).passwords;
const origin = 'http://127.0.0.1:8080', errors = [], checks = [];
await mkdir('data/screenshots', { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
async function login(username, width=1440) {
  const context = await browser.newContext({ viewport: { width, height: 1050 } }), page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message)); await page.goto(origin + '/#/staff');
  await page.getByLabel('Who is signing in?').selectOption(username); await page.getByLabel('Password', { exact: true }).fill(passwords[username]);
  await page.getByRole('button', { name: 'Sign in securely' }).click(); await expect(page.locator('.staff-shell')).toBeVisible({ timeout: 25000 });
  return { context, page };
}
try {
  const { page, context } = await login('admin');
  await expect(page.getByRole('heading', { name: 'A familiar face. Clear boundaries.' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Read activity schedule' })).toBeVisible();
  const switcher = page.getByRole('switch', { name: 'Read personal reminders' }), before = await switcher.getAttribute('aria-checked');
  await switcher.click(); await expect(switcher).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true', { timeout: 15000 });
  await switcher.click(); await expect(switcher).toHaveAttribute('aria-checked', before, { timeout: 15000 });
  checks.push('Real administrator login, policy persistence and live updates');
  await page.screenshot({ path: 'data/screenshots/humanloop-agentprint-desktop.png', fullPage: true });
  await page.getByText('Inspect AgentPrint identity', { exact: true }).click();
  await expect(page.getByText('humanloop:margaret:social', { exact: true }).first()).toBeVisible();
  checks.push('Technical identity expands to actual registered backend print');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('Inspect AgentPrint identity', { exact: true }).click();
  await page.screenshot({ path: 'data/screenshots/humanloop-agentprint-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true }).last()).toBeVisible();
  checks.push('390px mobile layout has no page overflow and retains sign-out'); await context.close();
  const staff = await login('sam');
  await expect(staff.page.getByRole('heading', { name: 'Who needs my attention?' })).toBeVisible();
  await expect(staff.page.getByRole('button', { name: /Permissions & activity/ })).toHaveCount(0);
  const draft = staff.page.locator('.staff-reply-form input').first();
  if (await draft.count()) { await draft.fill('Unsaved draft for persistence check'); await staff.page.waitForTimeout(3500); await expect(draft).toHaveValue('Unsaved draft for persistence check'); await draft.fill(''); checks.push('Live updates preserve unsent caregiver reply drafts'); }
  await staff.page.screenshot({ path: 'data/screenshots/humanloop-caregiver-overview.png', fullPage: true });
  await staff.page.getByRole('button', { name: 'Residents', exact: true }).click();
  await expect(staff.page.getByRole('heading', { name: 'Preferences', exact: true })).toBeVisible();
  await expect(staff.page.getByLabel('Preferred name')).toHaveValue('Maggie');
  await staff.page.screenshot({ path: 'data/screenshots/humanloop-resident-details.png', fullPage: true });
  const denied = await staff.page.evaluate(async () => { const r = await fetch('/api/staff/residents/margaret/policy', { method:'POST', headers: { 'Content-Type':'application/json', Authorization:'Bearer '+sessionStorage.getItem('carealong-session') }, body:JSON.stringify({ paused:true }) }); return r.status; });
  expect(denied).toBe(403); checks.push('Assigned caregiver views render; server denies nurse policy changes'); await staff.context.close();
  expect(errors).toEqual([]);
} finally { await browser.close(); await writeFile('data/portal-browser-check.json', JSON.stringify({ at:new Date().toISOString(), checks, errors }, null, 2)); console.log(JSON.stringify({ checks, errors })); }

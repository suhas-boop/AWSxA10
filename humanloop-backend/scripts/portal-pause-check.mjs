import { chromium, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
const origin='http://127.0.0.1:8080', passwords=JSON.parse(await readFile('.carealong-secrets.json')).passwords;
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const checks=[]; let adminToken;
async function api(token,path,body) { const r=await fetch(origin+'/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()}; }
try {
  adminToken=(await api(null,'/login',{username:'admin',password:passwords.admin})).data.token;
  const initial=(await api(adminToken,'/state')).data.profiles.find(p=>p.residentId==='daniel');expect(initial.policy.paused).toBe(false);
  const senior=await browser.newContext({permissions:['microphone']}); const page=await senior.newPage();
  await page.addInitScript(()=>{window.__tracks=[];const base=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async opts=>{const stream=await base(opts);window.__tracks.push(...stream.getTracks());return stream;};});
  await page.goto(origin+'/#/companion');await page.getByLabel('Who is signing in?').selectOption('daniel');await page.getByLabel('Password',{exact:true}).fill(passwords.daniel);await page.getByRole('button',{name:'Sign in securely'}).click();
  await expect(page.getByRole('button',{name:'Start voice',exact:true})).toBeVisible({timeout:25000});await page.getByRole('button',{name:'Start voice',exact:true}).click();
  await expect(page.getByText('Listening…',{exact:true})).toBeVisible({timeout:25000});
  expect(await page.evaluate(()=>window.__tracks.filter(t=>t.readyState==='live').length)).toBeGreaterThan(0);
  const staff=await browser.newContext();await staff.addInitScript(token=>sessionStorage.setItem('carealong-session',token),adminToken);const admin=await staff.newPage();await admin.goto(origin+'/#/staff');
  await admin.locator('.staff-person-tabs button').filter({hasText:'Daniel'}).click();await admin.getByRole('button',{name:'Pause companion',exact:true}).click();
  await expect(admin.getByRole('button',{name:'Resume companion',exact:true})).toBeVisible({timeout:20000});
  await expect.poll(()=>page.evaluate(()=>window.__tracks.filter(t=>t.readyState==='live').length),{timeout:15000}).toBe(0);
  await expect(page.getByRole('button',{name:'Start voice',exact:true})).toBeDisabled({timeout:10000});
  checks.push('Admin pause terminates live Nova socket and releases browser microphone');
  const token=await page.evaluate(()=>sessionStorage.getItem('carealong-session'));expect((await api(token,'/runs',{consent:true,workflow:'social'})).status).toBe(403);
  checks.push('Paused resident cannot start another session through the API');
  await admin.getByRole('button',{name:'Resume companion',exact:true}).click();await expect(page.getByRole('button',{name:'Start voice',exact:true})).toBeEnabled({timeout:15000});
  expect(await page.evaluate(()=>window.__tracks.filter(t=>t.readyState==='live').length)).toBe(0);checks.push('Resume permits explicit restart without turning microphone on automatically');
  await api(token,'/logout',{});
} finally { if(adminToken){await api(adminToken,'/staff/residents/daniel/policy',{paused:false}).catch(()=>{});await api(adminToken,'/logout',{}).catch(()=>{});}await browser.close();await writeFile('data/portal-pause-check.json',JSON.stringify({at:new Date().toISOString(),checks},null,2));console.log(JSON.stringify({checks})); }

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import Ajv from 'ajv';
import { DynamoStore } from './store.mjs';
import { createIdentity } from './identity.mjs';
import { CareWorkflow } from './workflow.mjs';
import { CareError } from './service.mjs';
import { createRunMcp } from './mcp.mjs';
import { createCareVoice } from './voice.mjs';
import { people, residents } from './fixtures.mjs';
import { AgentPrintBridge } from './agentprint.mjs';
import { StaffPortal } from './portal.mjs';
import { companionTools, COMPANION_PROMPT } from './companion-tools.mjs';
import { CARE_PROMPT } from './voice.mjs';
import { toolDefinitions } from './service.mjs';
import { createCompanionVoice } from './companion-voice.mjs';
import { demoPrefillAllowed } from './demo-prefill.mjs';

const cloud = JSON.parse(await readFile('.carealong-cloud.json', 'utf8'));
const secrets = JSON.parse(await readFile('.carealong-secrets.json', 'utf8'));
const store = new DynamoStore(cloud.table, cloud.region);
const identity = createIdentity(cloud, secrets, store);
const service = new CareWorkflow({ store, verifyMachine: identity.machine, machineToken: identity.machineToken, machineClientId: cloud.machineClientId });
const bridge = new AgentPrintBridge();
await bridge.initialize({ social: { model: 'amazon.nova-2-sonic-v1:0', prompt: COMPANION_PROMPT, tools: companionTools.map(t => t.name) }, clinical: { model: 'amazon.nova-2-sonic-v1:0', prompt: CARE_PROMPT, tools: toolDefinitions.map(t => t.name) } }, residents.map(r => r.id));
const portal = new StaffPortal({ care: service, bridge });
await portal.seed();
service.authorizeAgent = portal.authorizeClinical.bind(portal);
const port = Number(process.env.PORT || 8080), host = process.env.HOST || '127.0.0.1';
const origins = new Set((process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080,http://127.0.0.1:8080').split(','));
const root = process.env.CAREALONG_WEB_ROOT ? resolve(process.env.CAREALONG_WEB_ROOT) : fileURLToPath(new URL('../../../humanloop/dist/', import.meta.url));
const clients = new Set(), sseClients = new Set();
const ajv = new Ajv({ strict: true });
const validators = new Map();
const string = { type: 'string', minLength: 1, maxLength: 100 };
const text = { type: 'string', minLength: 1, maxLength: 2000 };
function validate(body, properties) {
  const key = JSON.stringify(properties);
  if (!validators.has(key)) validators.set(key, ajv.compile({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false }));
  if (!validators.get(key)(body)) throw new CareError('EXECUTION_FAILED', 400);
  return body;
}
async function bodyOf(request) {
  let bytes = 0; const chunks = [];
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 16384) throw new CareError('EXECUTION_FAILED', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new CareError('EXECUTION_FAILED', 400); }
}
const bearer = request => request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
const loginLimits = new Map();
const mcpSessions = new Map();
async function call(runId, tool, args) {
  if (!mcpSessions.has(runId)) mcpSessions.set(runId, await createRunMcp(service, runId));
  return mcpSessions.get(runId).call(tool, args);
}
function publicError(error) {
  return { code: error instanceof CareError ? error.code : 'EXECUTION_FAILED', message: error instanceof CareError && error.code === 'AUTH_INVALID' ? 'Sign in again to continue.' : 'The request could not be completed. Your care records have not been assumed to be absent.' };
}

const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
  const json = (code, data) => { if (!response.headersSent) response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
  const path = new URL(request.url, 'http://localhost').pathname;
  try {
    if (request.headers.origin && !origins.has(request.headers.origin)) throw new CareError('AUTH_INVALID');
    if (path === '/ping') return json(200, { status: clients.size ? 'HealthyBusy' : 'Healthy' });
    const demoPrefill = demoPrefillAllowed(request, { enabled: process.env.CAREALONG_DEMO_PASSWORD_PREFILL === '1', host });
    if (path === '/api/config') return json(200, { product: 'CareAlong', region: cloud.region, account: cloud.account, identities: people.map(({ username, name, role }) => ({ username, name, role })), synthetic: true, demo_password_prefill: demoPrefill });
    if (path === '/api/demo-password' && request.method === 'POST') {
      if (!demoPrefill) return json(404, { message: 'Not available.' });
      const { username } = validate(await bodyOf(request), { username: string });
      if (!people.some(p => p.username === username) || !Object.hasOwn(secrets.passwords || {}, username)) return json(404, { message: 'Not available.' });
      return json(200, { password: secrets.passwords[username] });
    }
    if (path === '/api/login' && request.method === 'POST') {
      const key = request.socket.remoteAddress; let limit = loginLimits.get(key);
      if (!limit || Date.now() > limit.until) { limit = { count: 0, until: Date.now() + 60000 }; loginLimits.set(key, limit); }
      if (++limit.count > 20) throw new CareError('AUTH_INVALID', 429);
      const body = validate(await bodyOf(request), { username: string, password: { type: 'string', minLength: 1, maxLength: 256 } });
      return json(200, await identity.login(body.username, body.password));
    }
    if (path.startsWith('/api/')) {
      const principal = await identity.human(bearer(request));
      if (path === '/api/logout' && request.method === 'POST') { await identity.logout(principal); return json(200, { signed_out: true }); }
      if (path === '/api/state' && request.method === 'GET') return json(200, await portal.snapshot(principal));
      if (path === '/api/events' && request.method === 'GET') {
        await service.member(principal);
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write(': connected\n\n'); sseClients.add(response);
        let closed = false;
        response.on('close', () => { closed = true; sseClients.delete(response); });
        while (!closed && !response.destroyed) {
          try {
            // Revalidate the login and membership for every event, not only at subscription time.
            const current = await identity.human(bearer(request));
            const snapshot = await portal.snapshot(current);
            if (response.writableLength > 256000) break;
            response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
          } catch { response.write('event: auth-error\ndata: {}\n\n'); break; }
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
        response.end(); sseClients.delete(response); return;
      }
      if (path === '/api/runs' && request.method === 'POST') {
        const raw = await bodyOf(request);
        const body = validate({ workflow: 'clinical', ...raw }, { consent: { type: 'boolean' }, workflow: { type: 'string', enum: ['social', 'clinical'] } });
        await portal.beforeStart(principal, body.workflow);
        return json(201, await service.startRun(principal, body.consent, body.workflow));
      }
      const staffRoute = path.match(/^\/api\/staff\/residents\/([^/]+)\/(policy|preferences|reminders|requests\/([^/]+)\/respond)$/);
      if (staffRoute && request.method === 'POST') {
        const [, rid, action, requestId] = staffRoute, body = await bodyOf(request);
        if (action === 'policy') {
          validate(body, 'paused' in body ? { paused: { type: 'boolean' } } : { capability: string, enabled: { type: 'boolean' } });
          return json(200, await portal.updatePolicy(principal, rid, body));
        }
        if (action === 'preferences') return json(200, await portal.updatePreferences(principal, rid, body));
        if (action === 'reminders') { validate(body, { activity_id: string }); return json(201, await portal.addReminder(principal, rid, body.activity_id)); }
        validate(body, { text: { type: 'string', maxLength: 500 } });
        return json(200, await portal.respond(principal, rid, requestId, body.text));
      }
      let match = path.match(/^\/api\/runs\/([^/]+)\/(heartbeat|stop|analysis|turns|observations|correct|context|propose|confirm|probe|revoke)$/);
      if (match && request.method === 'POST') {
        const [, runId, action] = match, body = await bodyOf(request);
        if (!['heartbeat', 'stop', 'revoke', 'probe'].includes(action)) { const { run } = await service.ownedRun(principal, runId); if (run.workflow === 'social') throw new CareError('TOOL_NOT_ALLOWED'); }
        if (action === 'heartbeat') { validate(body, {}); return json(200, await service.heartbeat(principal, runId)); }
        if (action === 'stop') {
          validate(body, {}); const result = await service.stopRun(principal, runId);
          await mcpSessions.get(runId)?.close(); mcpSessions.delete(runId); return json(200, result);
        }
        if (action === 'revoke') { validate(body, { tool: string }); return json(200, await service.revoke(principal, runId, body.tool)); }
        if (action === 'probe') {
          validate(body, {}); if ((await service.member(principal)).role !== 'admin') throw new CareError('TOOL_NOT_ALLOWED');
          const result = await call(runId, 'get_checkin_context', {});
          return json(200, { ok: result.ok, code: result.code || 'ALLOWED', clinical_result_withheld: true });
        }
        // Mutation handlers perform their own fresh ownership check under the run lock.
        // Gateway proxy handlers still need human ownership before invoking the agent.
        if (['context', 'propose'].includes(action)) await service.ownedRun(principal, runId);
        if (action === 'analysis') { validate(body, { analysis: string, detector: string }); return json(200, await service.setAnalysis(principal, runId, body.analysis, body.detector)); }
        if (action === 'turns') {
          validate(body, { text, turn_id: string }); return json(200, await service.report(principal, runId, body.text, 'typed', body.turn_id));
        }
        if (action === 'observations') {
          validate(body, { window_id: string, label: { type: 'string', enum: ['Cough', 'Throat clearing'] }, score: { type: 'number', minimum: 0, maximum: 1 }, start_ms: { type: 'number', minimum: 0 }, end_ms: { type: 'number', minimum: 0 }, quality: { type: 'string', enum: ['uncertain', 'usable', 'clipped'] } });
          return json(201, await service.observe(principal, runId, body));
        }
        if (action === 'correct') { validate(body, { evidence_id: string, text }); return json(200, await service.correct(principal, runId, body.evidence_id, body.text)); }
        if (action === 'context') { validate(body, {}); return json(200, await call(runId, 'get_checkin_context', {})); }
        if (action === 'propose') { validate(body, { incident_id: string, assistance: text }); return json(200, await call(runId, 'propose_follow_up', body)); }
        if (action === 'confirm') {
          validate(body, { draft_id: string, accepted: { type: 'boolean' } });
          const confirmation = await service.confirm(principal, runId, body.draft_id, body.accepted);
          if (confirmation.declined) return json(200, confirmation);
          return json(200, await call(runId, 'create_review_task', confirmation));
        }
      }
      match = path.match(/^\/api\/tasks\/([^/]+)\/(acknowledge|next-step|resolve)$/);
      if (match && request.method === 'POST') {
        const body = validate(await bodyOf(request), { resident_id: string, ...(match[2] === 'next-step' ? { text } : {}) });
        return json(200, await service.taskAction(principal, body.resident_id, match[1], match[2], body.text));
      }
      match = path.match(/^\/api\/requests\/([^/]+)$/);
      if (match && request.method === 'GET') return json(200, await service.reconcile(principal, match[1]));
      return json(404, { code: 'TOOL_NOT_ALLOWED' });
    }
    if (request.method !== 'GET') return json(405, { code: 'TOOL_NOT_ALLOWED' });
    const file = resolve(root, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
    if (!file.startsWith(resolve(root) + '/') || !(await stat(file)).isFile()) return json(404, { message: 'Not found' });
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream' };
    response.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream'); response.end(await readFile(file));
  } catch (error) { json(error.status || 500, publicError(error)); }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false,
  handleProtocols: protocols => protocols.has('carealong') ? 'carealong' : false });
server.on('upgrade', async (request, socket, head) => {
  socket.on('error', () => {});
  const deadline = setTimeout(() => socket.destroy(), 10000);
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/ws' || !origins.has(request.headers.origin)) throw new CareError('AUTH_INVALID');
    const protocols = request.headers['sec-websocket-protocol']?.split(',').map(x => x.trim());
    const encoded = protocols?.find(x => x.startsWith('carealong-token.'))?.slice('carealong-token.'.length);
    const token = encoded ? Buffer.from(encoded, 'base64url').toString() : null;
    const principal = await identity.human(token);
    const runId = url.searchParams.get('run'); const { run } = await service.ownedRun(principal, runId);
    await portal.checkRun(run);
    if (service.voiceStops.has(runId)) throw new CareError('AUTH_INVALID');
    if (!socket.destroyed) wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, { principal, run, token }));
  } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); }
  finally { clearTimeout(deadline); }
});
wss.on('connection', async (ws, { principal, run, token }) => {
  clients.add(ws);
  let voice, closed = false, stopping, lastAudio = Date.now(), frames = 0, frameStart = Date.now(), reconnecting = false, lastReconnect = 0;
  const emit = message => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1048576) { ws.close(1013, 'Playback congested'); return; }
    ws.send(JSON.stringify(message));
  };
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      closed = true; clearInterval(heartbeat);
      await voice?.stop();
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Stopped');
      clients.delete(ws);
    })(); return stopping;
  };
  service.voiceStops.set(run.id, stop);
  const heartbeat = setInterval(async () => {
    try { await identity.human(token); await service.ownedRun(principal, run.id); await portal.checkRun(run); if (Date.now() - lastAudio > 8000) throw new Error(); }
    catch { emit({ type: 'error', message: 'The session is no longer active. Direct human help remains available.' }); void stop(); }
  }, 2000);
  ws.on('message', (data, binary) => {
    if (closed) return;
    try {
      if (!binary) {
        const control = JSON.parse(data.toString());
        if (Object.keys(control).length !== 1 || control.type !== 'reconnect') throw new Error();
        if (reconnecting || Date.now() - lastReconnect < 10000) return;
        reconnecting = true; lastReconnect = Date.now();
        void (async () => {
          try {
            await identity.human(token); await service.ownedRun(principal, run.id);
            if (!voice?.session.active) throw new Error();
            await voice.session.renew();
          } catch { emit({ type: 'error', message: 'Voice could not reconnect. Please start a new check-in.' }); await stop(); }
          finally { reconnecting = false; }
        })();
        return;
      }
      if (Date.now() - frameStart > 1000) { frameStart = Date.now(); frames = 0; }
      if (++frames > 100) throw new Error();
      lastAudio = Date.now(); voice?.session.audio(data);
    } catch { void stop(); }
  });
  ws.on('error', () => void stop());
  ws.on('close', () => { void stop(); void service.stopRun(principal, run.id).catch(() => {}); });
  try {
    voice = run.workflow === 'social' ? await createCompanionVoice({ portal, run, emit, region: cloud.region }) : await createCareVoice({ service, portal, run, principal, emit, region: cloud.region });
    if (closed) { await voice.stop(); return; }
    await voice.session.start();
  } catch { emit({ type: 'error', message: 'Voice could not connect. Typed support and direct help remain available.' }); await stop(); }
});

let sweeping = false;
const reaper = setInterval(async () => { if (sweeping) return; sweeping = true; try { await service.expireLeases(); } catch { /* Protected calls still check expiry strongly. */ } finally { sweeping = false; } }, 1000);
server.listen(port, host, () => console.log(`CareAlong: http://${host}:${port} · real Cognito + DynamoDB · synthetic residents`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  clearInterval(reaper); bridge.close();
  for (const response of sseClients) response.end();
  for (const ws of clients) ws.close(1001, 'Server stopping');
  for (const mcp of mcpSessions.values()) await mcp.close();
  server.close(); setTimeout(() => process.exit(0), 5000).unref();
});

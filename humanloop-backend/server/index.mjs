import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { readConfig } from './config.mjs';
import { createAuth } from './auth.mjs';
import { createState } from './state.mjs';
import { createTransport } from './bedrock.mjs';
import { tools } from './tools.mjs';
import { ToolRunner } from './tool-runner.mjs';
import { SonicSession } from './session.mjs';

const config = readConfig();
const authenticate = createAuth(config);
const state = await createState(config.table, config.region);
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const active = new Set();
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  const url = new URL(request.url, 'http://localhost');
  const json = (code, body) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (request.method === 'GET' && url.pathname === '/ping') return json(200, { status: active.size ? 'HealthyBusy' : 'Healthy' });
  if (request.method === 'GET' && url.pathname === '/api/config') return json(200, { authMode: config.authMode, region: config.region, model: config.modelId, storage: config.table ? 'DynamoDB' : 'Local summaries' });
  if (request.method !== 'GET') return json(405, { error: 'Use the /ws WebSocket endpoint for voice sessions.' });
  try {
    let path = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (path !== resolve(root) && !path.startsWith(resolve(root) + sep)) return json(403, { error: 'Forbidden' });
    if (url.pathname === '/') path = resolve(root, 'index.html');
    if (!(await stat(path)).isFile()) return json(404, { error: 'Not found' });
    response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' });
    response.end(await readFile(path));
  } catch { json(404, { error: 'Page not built. Run npm run dev, or npm run build before npm start.' }); }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false,
  handleProtocols: protocols => protocols.has('base64UrlBearerAuthorization') ? 'base64UrlBearerAuthorization' : false,
});

server.on('upgrade', async (request, socket, head) => {
  socket.on('error', () => {});
  const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
  const timeout = setTimeout(() => socket.destroy(), 10000);
  try {
    if (new URL(request.url, 'http://localhost').pathname !== '/ws') return reject('404 Not Found');
    // Local mode always requires a browser origin, preventing other websites from spending local AWS credentials.
    const origin = request.headers.origin;
    if ((origin && !config.origins.includes(origin)) || (!origin && config.authMode === 'local')) return reject('403 Forbidden');
    if (active.size >= 10) return reject('503 Service Unavailable');
    const principal = await authenticate(request);
    if (!socket.destroyed) wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, principal));
  } catch { reject('401 Unauthorized'); }
  finally { clearTimeout(timeout); }
});

wss.on('connection', (ws, principal) => {
  active.add(ws);
  let session, transport, expiryTimer, finished = false, started = false;
  let alive = true;
  let lastAudio = Date.now();
  let windowStart = Date.now(), frames = 0, controls = 0;
  const emit = message => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, 'Client is too slow'); return; }
    ws.send(JSON.stringify(message));
  };
  const finish = async () => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat); clearTimeout(expiryTimer); clearTimeout(startDeadline);
    await session?.stop();
    if (session) {
      try { await state.save(principal, session.summary()); }
      catch { emit({ type: 'warning', message: 'Conversation ended, but the session summary could not be saved.' }); }
    }
    transport?.destroy();
    active.delete(ws);
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Session ended');
  };
  const heartbeat = setInterval(() => {
    if (!alive || (session && Date.now() - lastAudio > 15000)) { ws.terminate(); return; }
    alive = false; ws.ping();
  }, 5000);
  const startDeadline = setTimeout(() => ws.close(1008, 'Start timed out'), 15000);
  ws.on('pong', () => { alive = true; });
  if (Number.isFinite(principal.expiresAt)) expiryTimer = setTimeout(() => {
    emit({ type: 'error', message: 'Your sign-in expired. Sign in again to continue.' }); void finish();
  }, Math.max(0, principal.expiresAt - Date.now()));
  ws.on('message', (data, binary) => {
    if (finished) return;
    if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); frames = 0; controls = 0; }
    try {
      if (binary) {
        if (++frames > 100) throw new Error('Audio rate exceeded');
        lastAudio = Date.now(); session?.audio(data); return;
      }
      if (++controls > 20) throw new Error('Control rate exceeded');
      const message = JSON.parse(data.toString());
      if (message.type === 'start' && !started) {
        started = true; clearTimeout(startDeadline);
        transport = createTransport(config);
        const runner = new ToolRunner({ tools, principal, authorize: state.authorize, emit });
        session = new SonicSession({ transport, runner, emit, voice: config.voice });
        emit({ type: 'status', status: 'connecting' });
        void session.start();
      } else if (message.type === 'tools' && typeof message.enabled === 'boolean') {
        session?.runner.setEnabled(message.enabled);
        emit({ type: 'permissions', enabled: message.enabled });
      } else if (message.type === 'stop') void finish();
      else throw new Error('Invalid control message');
    } catch { emit({ type: 'error', message: 'Invalid or congested audio stream. Please start a new session.' }); void finish(); }
  });
  ws.on('close', () => void finish());
  ws.on('error', () => void finish());
  emit({ type: 'ready', authMode: config.authMode, tools: tools.map(({ name, description }) => ({ name, description })) });
});

server.listen(config.port, config.host, () => console.log(`Voice backend: http://${config.host}:${config.port} (${config.authMode} authentication)`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  for (const ws of active) ws.close(1001, 'Server stopping');
  server.close();
  setTimeout(() => process.exit(0), 6000).unref();
});

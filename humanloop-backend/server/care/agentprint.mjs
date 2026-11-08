import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export class AgentPrintBridge {
  constructor({ keyFile, python } = {}) {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    this.pending = new Map(); this.sequence = 0; this.identities = [];
    this.child = spawn(python || process.env.AGENTPRINT_PYTHON || resolve(root, '.venv-agentprint/bin/python'), ['-u', '-m', 'hospiceprint.humanloop_bridge'], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HUMANLOOP_KEY_FILE: keyFile || resolve(root, 'humanloop-backend/.carealong-agentprint-keys.json') },
    });
    this.child.stderr.on('data', () => {}); this.child.stdin.on('error', () => this.fail());
    this.child.on('error', () => this.fail()); this.child.on('exit', () => this.fail());
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => { try { const message = JSON.parse(line), item = this.pending.get(message.id); if (!item) return; clearTimeout(item.timer); this.pending.delete(message.id); message.error ? item.reject(new Error('AgentPrint verification unavailable')) : item.resolve(message.result); } catch { this.fail(); } });
  }
  fail() { this.unavailable = true; for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('AgentPrint verification unavailable')); } this.pending.clear(); }
  call(value) {
    if (this.unavailable) return Promise.reject(new Error('AgentPrint verification unavailable'));
    return new Promise((resolve, reject) => { const id = ++this.sequence; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('AgentPrint verification timed out')); }, 5000);
      this.pending.set(id, { resolve, reject, timer }); this.child.stdin.write(JSON.stringify({ ...value, id }) + '\n', error => { if (error) this.fail(); }); });
  }
  async initialize(manifests, residents) { const result = await this.call({ op: 'initialize', manifests, residents }); this.identities = result.identities; }
  authorize(value) { return this.call({ op: 'authorize', ...value }); }
  close() { this.fail(); this.child.kill(); }
}

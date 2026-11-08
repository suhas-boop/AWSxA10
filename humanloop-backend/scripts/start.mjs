import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const python = process.env.AGENTPRINT_PYTHON || fileURLToPath(new URL('../../.venv-agentprint/bin/python', import.meta.url));
const bridgeCheck = spawnSync(python, ['-c', 'import jwt; import cryptography'], { stdio: 'ignore' });
if (bridgeCheck.status !== 0) { console.error('AgentPrint Python environment is missing. From the repository root: python3.13 -m venv .venv-agentprint && .venv-agentprint/bin/python -m pip install -r requirements-agentprint.txt'); process.exit(1); }

for (const file of ['.carealong-cloud.json', '.carealong-secrets.json']) {
  if (!existsSync(file)) { console.error('CareAlong cloud configuration is missing. Run npm run provision with the hackathon AWS credentials first.'); process.exit(1); }
}
const webRoot = process.env.CAREALONG_WEB_ROOT || fileURLToPath(new URL('../../humanloop/dist/', import.meta.url));
if (!existsSync(resolve(webRoot, 'index.html'))) { console.error('HumanLoop build is missing. Run npm --prefix ../humanloop ci and npm --prefix ../humanloop run build first.'); process.exit(1); }
const check = spawnSync(process.execPath, ['scripts/preflight.mjs', '--identity-only'], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status || 1);
const child = spawn(process.execPath, [...(process.argv.includes('--watch') ? ['--watch'] : []), 'server/care/index.mjs'], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));

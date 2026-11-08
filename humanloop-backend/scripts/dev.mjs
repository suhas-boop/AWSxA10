import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) loadEnvFile('.env');
try {
  for (const dependency of ['vite', 'ws', 'react', 'react-dom', 'ajv', 'jose', '@aws-sdk/client-bedrock-runtime', '@smithy/node-http-handler']) {
    import.meta.resolve(dependency);
  }
} catch {
  console.error('Dependencies are missing. Run npm install --cache ./.npm-cache, then npm run dev.');
  process.exit(1);
}
// Check the identity in the same environment inherited by the voice backend.
// Model metadata permissions are not required to start an inference session.
const identity = spawnSync(process.execPath, ['scripts/preflight.mjs', '--identity-only'], { stdio: 'inherit' });
if (identity.status !== 0) process.exit(identity.status || 1);

const processes = [
  spawn(process.execPath, ['--watch', '--env-file-if-exists=.env', 'server/care/index.mjs'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of processes) {
  child.on('exit', code => stop(code || 0));
  child.on('error', error => { console.error(error.message); stop(1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

for (const file of ['.carealong-cloud.json', '.carealong-secrets.json']) {
  if (!existsSync(file)) { console.error('CareAlong cloud configuration is missing. Run npm run provision with the hackathon AWS credentials first.'); process.exit(1); }
}
if (!existsSync('dist/index.html')) { console.error('Frontend build is missing. Run npm run prepare:audio and npm run build first.'); process.exit(1); }
const check = spawnSync(process.execPath, ['scripts/preflight.mjs', '--identity-only'], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status || 1);
const child = spawn(process.execPath, [...(process.argv.includes('--watch') ? ['--watch'] : []), 'server/care/index.mjs'], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const backend = fileURLToPath(new URL('../../humanloop-backend/', import.meta.url));
const ui = fileURLToPath(new URL('../dist/', import.meta.url));
const child = spawn('npm', ['start'], { cwd: backend, stdio: 'inherit', env: { ...process.env, CAREALONG_WEB_ROOT: ui } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));

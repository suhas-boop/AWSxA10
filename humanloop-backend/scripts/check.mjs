import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
let count = 0;
for (const dir of ['server', 'scripts', 'test', 'web']) {
  for (const file of await readdir(dir, { recursive: true })) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${dir}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
    count++;
  }
}
console.log(`Syntax checked ${count} JavaScript modules. Run npm run build to validate React and browser assets.`);

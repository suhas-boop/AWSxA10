import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../../humanloop-backend/public/', import.meta.url));
const target = fileURLToPath(new URL('../public/', import.meta.url));
await mkdir(target, { recursive: true });
for (const name of ['models', 'mediapipe']) await cp(`${source}/${name}`, `${target}/${name}`, { recursive: true });

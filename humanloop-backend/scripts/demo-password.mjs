import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const username = process.argv[2];
const passwords = JSON.parse(await readFile('.carealong-secrets.json')).passwords;
if (!username || !Object.hasOwn(passwords, username)) {
  console.error('Usage: npm run password -- margaret (or daniel, robert, grace, sam, lee, carla, admin)'); process.exit(1);
}
if (process.platform !== 'darwin') { console.error('Clipboard helper is for macOS. Read the requested username in the local .carealong-secrets.json file.'); process.exit(1); }
execFileSync('pbcopy', { input: passwords[username] });
console.log(`Copied ${username}'s demo sign-in password to the clipboard. Paste it into CareAlong. No AWS credentials were copied.`);

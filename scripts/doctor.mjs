import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const checks = [];
async function check(label, action) {
  try { await action(); checks.push([label, true]); }
  catch (error) { checks.push([label, false, error.message]); }
}

await check('Node.js 18 or newer', async () => {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error(`found ${process.versions.node}`);
});
await check('Extension manifest is valid', async () => {
  JSON.parse(await readFile(resolve(root, 'extension/manifest.json'), 'utf8'));
});
await check('Extension worker exists', () => access(resolve(root, 'extension/background.js'), constants.R_OK));
await check('MCP server is built', () => access(resolve(root, 'server/dist/cli.js'), constants.R_OK));

for (const [label, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
if (checks.some(([, ok]) => !ok)) process.exitCode = 1;

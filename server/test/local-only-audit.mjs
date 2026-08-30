import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = [
  resolve(here, '../src/bridge.ts'),
  resolve(here, '../src/server.ts'),
  resolve(here, '../src/cli.ts'),
  resolve(here, '../../extension/background.js'),
  resolve(here, '../../extension/manifest.json'),
];
const forbidden = [
  /wss:\/\//i,
  /relay\.api/i,
  /remoteUuid/i,
  /remoteRelay/i,
  /auth_ack/i,
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /sendBeacon/,
];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `${file} contains forbidden control-plane pattern ${pattern}`);
  }
}
const bridge = await readFile(files[0], 'utf8');
const extension = await readFile(files[3], 'utf8');
assert.match(bridge, /host: '127\.0\.0\.1'/);
assert.match(extension, /ws:\/\/127\.0\.0\.1:19889/);
console.log('local-only source audit ok');

/**
 * Source audit: no relay, remote URL, telemetry, or non-loopback control
 * plane may appear anywhere in server or extension source.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = [
  resolve(here, '../src/bridge.ts'),
  resolve(here, '../src/server.ts'),
  resolve(here, '../src/cli.ts'),
  resolve(here, '../src/contract.ts'),
  resolve(here, '../../extension/background.js'),
  resolve(here, '../../extension/tools.js'),
  resolve(here, '../../extension/config.js'),
  resolve(here, '../../extension/options.js'),
  resolve(here, '../../extension/popup.js'),
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
assert.match(bridge, /host: '127\.0\.0\.1'/, 'bridge binds explicitly to IPv4 loopback');

const background = await readFile(files[4], 'utf8');
assert.match(
  background,
  /new WebSocket\(`ws:\/\/127\.0\.0\.1:\$\{activeConfig\.port\}`\)/,
  'extension builds its endpoint only from loopback + configured port',
);
assert.equal(
  (background.match(/ws:\/\/(?!127\.0\.0\.1)/g) || []).length,
  0,
  'every ws:// literal in the extension targets 127.0.0.1',
);

const config = await readFile(files[6], 'utf8');
assert.match(config, /port: 19889/, 'config.js default port is 19889');
assert.match(config, /profile: null/, 'config.js default profile is null');

console.log('local-only source audit ok');

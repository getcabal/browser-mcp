/** Deterministic locked-profile packaging and inert doctor verification. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const packageArgs = [
  resolve(root, 'scripts/package-extension.mjs'),
  '--profile', 'test-a:21901',
  '--profile', 'test-b:21902',
];

await run(process.execPath, packageArgs, { cwd: root });
const first = JSON.parse(await readFile(resolve(root, 'dist/artifacts.json'), 'utf8'));
await run(process.execPath, packageArgs, { cwd: root });
const second = JSON.parse(await readFile(resolve(root, 'dist/artifacts.json'), 'utf8'));
assert.deepEqual(second, first, 'repeated package produces identical artifact metadata and hashes');
assert.equal(second.profiles.length, 2);

for (const profile of second.profiles) {
  const source = await readFile(resolve(root, profile.dir, 'config.js'), 'utf8');
  const match = source.match(/Object\.freeze\((\{.*\})\)/);
  assert.ok(match, `${profile.name} config is inert JSON inside Object.freeze`);
  const config = JSON.parse(match[1]);
  assert.deepEqual(config, { port: profile.port, profile: profile.name, locked: true });
}

const { stdout: doctorOutput } = await run(process.execPath, [
  resolve(root, 'scripts/doctor.mjs'),
  '--extension-dir', resolve(root, second.profiles[0].dir),
], { cwd: root });
assert.match(doctorOutput, /PASS  Installed content hash matches a packaged artifact/);
assert.match(doctorOutput, /PASS  Installed config is inert and routing state is explicit/);
assert.match(doctorOutput, /effective route is locked to test-a:21901/);

const doctorSource = await readFile(resolve(root, 'scripts/doctor.mjs'), 'utf8');
assert.ok(
  doctorSource.indexOf("Installed content hash matches a packaged artifact")
    < doctorSource.indexOf("Installed config is inert and routing state is explicit"),
  'doctor hashes an installed copy before parsing its config',
);
const optionsSource = await readFile(resolve(root, 'extension/options.js'), 'utf8');
assert.match(optionsSource, /DEFAULT_CONFIG\.locked === true/);
assert.match(optionsSource, /portInput\.disabled = true/);

console.log('deployment ok: deterministic artifacts, locked routes, inert hash-first doctor verification');

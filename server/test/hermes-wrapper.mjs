/** Lifecycle acceptance for the lease-aware Hermes Browser MCP adapter. */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const wrapper = resolve(repoRoot, 'scripts/hermes-profile-browser-mcp');
const temp = await mkdtemp(join(tmpdir(), 'browser-mcp-hermes-wrapper-'));
const hermesHome = join(temp, 'hermes');
const launcher = join(hermesHome, 'bin', 'default-browser-native');
const stateDir = join(hermesHome, 'profiles', 'default', 'cache', 'browser-mcp');
const fakeRoot = join(temp, 'browser-mcp');
const fakeCli = join(fakeRoot, 'server', 'dist', 'cli.js');
const actions = join(temp, 'actions.log');
const argsFile = join(temp, 'args.json');

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

try {
  await mkdir(dirname(launcher), { recursive: true });
  await mkdir(dirname(fakeCli), { recursive: true });
  await writeFile(launcher, `#!/bin/zsh
set -e
print -r -- "$1:$2" >> "$BROWSER_MCP_TEST_ACTIONS"
case "$1" in
  launch) print -r -- '{"lease_id":"lease-test","pid":123,"window_id":456}' ;;
  renew|release) ;;
  *) exit 64 ;;
esac
`);
  await writeFile(fakeCli, `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.BROWSER_MCP_TEST_ARGS, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
`);
  await chmod(launcher, 0o755);

  const env = {
    ...process.env,
    HERMES_HOME: hermesHome,
    BROWSER_MCP_BROWSER_LAUNCHER: launcher,
    BROWSER_MCP_STATE_DIR: stateDir,
    BROWSER_MCP_EXTENSION_PORT: '21122',
    BROWSER_MCP_PROFILE: 'default',
    BROWSER_MCP_CONNECT_TIMEOUT_MS: '45000',
    BROWSER_MCP_ROOT: fakeRoot,
    BROWSER_MCP_NODE: process.execPath,
    BROWSER_MCP_TEST_ACTIONS: actions,
    BROWSER_MCP_TEST_ARGS: argsFile,
  };

  const child = spawn(wrapper, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  await waitFor(async () => {
    try { await stat(argsFile); return true; } catch { return false; }
  });
  const args = JSON.parse(await readFile(argsFile, 'utf8'));
  assert.deepEqual(args, [
    'start', '--port', '21122', '--profile', 'default', '--require-extension',
    '--extension-connect-timeout', '45000',
  ]);

  const lease = JSON.parse(await readFile(join(stateDir, 'browser-lease.json'), 'utf8'));
  assert.equal(lease.lease_id, 'lease-test');
  assert.match(lease.task_url, /^https:\/\/example\.com\/#hermes-browser-mcp-task-/);

  child.stdin.end();
  const exit = await new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  await assert.rejects(() => stat(join(stateDir, 'browser-lease.json')));
  const actionLog = await readFile(actions, 'utf8');
  assert.match(actionLog, /^launch:/m);
  assert.match(actionLog, /^release:lease-test$/m);

  const invalid = spawnSync(wrapper, [], {
    env: { ...env, BROWSER_MCP_EXTENSION_PORT: '80' },
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 64);
  assert.match(invalid.stderr, /extension port must be an unprivileged integer/);

  console.log('Hermes wrapper ok: lease lifecycle, exact locked route, fail-closed validation');
} finally {
  await rm(temp, { recursive: true, force: true });
}

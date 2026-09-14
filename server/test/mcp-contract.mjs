/** Actual stdio MCP acceptance: CLI compatibility + exact tools/list. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FakeExtension, freePort, sleep } from './fake-extension.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(resolve(here, 'fixtures/vibe-tools-0.3.6.json'), 'utf8'));
const { TOOLS } = await import(pathToFileURL(resolve(here, '../../extension/tools.js')).href);
const port = await freePort();
const profile = 'stdio-contract';
const client = new Client({ name: 'stdio-contract-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    resolve(here, '../dist/cli.js'),
    'start',
    '--port', String(port),
    '--profile', profile,
    '--require-extension',
    '--extension-connect-timeout', '5000',
  ],
  stderr: 'pipe',
});

let fake = null;
try {
  const connecting = client.connect(transport);
  let lastError = null;
  for (let attempt = 0; attempt < 30 && !fake; attempt += 1) {
    const candidate = new FakeExtension({ port, profile, tools: TOOLS });
    try {
      await candidate.connect();
      fake = candidate;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  if (!fake) throw lastError || new Error('extension could not connect');
  await connecting;
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 24);
  const core = structuredClone(listed.tools.slice(0, 22));
  const press = core.find(tool => tool.name === 'press_key');
  for (const field of ['xRatio', 'yRatio']) {
    assert.equal(press.inputSchema.properties[field].type, 'number');
    delete press.inputSchema.properties[field];
  }
  assert.deepEqual(core, fixture.tools, 'stdio advertises Vibe plus the two protected coordinate fields');
  const refused = await client.callTool({name: 'press_key', arguments: {tabId: 7, keys: 'Enter', xRatio: 0.4, yRatio: 0.5}});
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, 'Error: Credential coordinates require protected CMD+V');
  assert.deepEqual(listed.tools.slice(22).map((tool) => tool.name), ['get_text', 'evaluate']);
  console.log('stdio MCP contract ok: compatible 22 tools with protected coordinate recovery advertised');
} finally {
  fake?.close();
  await client.close().catch(() => {});
}

const eofPort = await freePort();
const eofProfile = 'stdio-eof';
const eofChild = spawn(process.execPath, [
  resolve(here, '../dist/cli.js'),
  'start',
  '--port', String(eofPort),
  '--profile', eofProfile,
  '--require-extension',
  '--extension-connect-timeout', '5000',
], { stdio: ['pipe', 'pipe', 'pipe'] });
let eofFake = null;
let eofStderr = '';
eofChild.stderr.on('data', (chunk) => { eofStderr += chunk; });
try {
  let lastError = null;
  for (let attempt = 0; attempt < 30 && !eofFake; attempt += 1) {
    const candidate = new FakeExtension({ port: eofPort, profile: eofProfile, tools: TOOLS });
    try {
      await candidate.connect();
      eofFake = candidate;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  if (!eofFake) throw lastError || new Error('EOF lifecycle extension could not connect');
  eofChild.stdin.end();
  const eofExit = await Promise.race([
    new Promise((resolveExit) => eofChild.once('exit', (code, signal) => resolveExit({ code, signal }))),
    sleep(2_000).then(() => ({ timeout: true })),
  ]);
  assert.deepEqual(eofExit, { code: 0, signal: null }, eofStderr);
} finally {
  eofFake?.close();
  if (eofChild.exitCode === null) eofChild.kill('SIGKILL');
}

console.log('stdio MCP lifecycle ok: client EOF releases the extension bridge');

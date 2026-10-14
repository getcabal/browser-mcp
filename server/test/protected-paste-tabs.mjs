/** Tab-bound protected paste: agents sharing one browser never take each other's secrets. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  captureProtectedServiceTitanSms,
  deliverProtectedClipboardPaste,
  ProfileCredentialBroker,
  ProtectedPasteState,
} from '../dist/protected-paste.js';
import { FakeExtension, freePort, sleep } from './fake-extension.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function socketExchange(path, request) {
  return new Promise((resolveExchange, reject) => {
    const client = createConnection(path);
    const chunks = [];
    client.on('connect', () => client.end(request));
    client.on('data', (chunk) => chunks.push(chunk));
    client.on('error', reject);
    client.on('end', () => resolveExchange(String(Buffer.concat(chunks))));
  });
}

const frame = (value, tabId) => Buffer.concat([
  Buffer.from(tabId === undefined
    ? `HERMES-CREDENTIAL/1 ${Buffer.byteLength(value)}\n`
    : `HERMES-CREDENTIAL/2 ${tabId} ${Buffer.byteLength(value)}\n`, 'ascii'),
  Buffer.from(value, 'utf8'),
]);

function fillRecorder() {
  const calls = [];
  return {
    calls,
    bridge: {
      async callTool(name, args) {
        calls.push({ name, args: { ...args } });
        return { content: [{ type: 'text', text: '{"pasted":true}' }] };
      },
    },
  };
}

// State: each tab takes only its own value; the untagged slot is the fallback.
{
  const state = new ProtectedPasteState();
  state.storeCredential(Buffer.from('value-for-12'), 12);
  state.storeCredential(Buffer.from('value-for-13'), 13);
  assert.equal(state.takeCredential(14), null);
  assert.equal(state.takeCredential(), null, 'an untagged take never reaches tab-bound values');
  assert.equal(String(state.takeCredential(13)), 'value-for-13');
  assert.equal(String(state.takeCredential(12)), 'value-for-12');
  assert.equal(state.takeCredential(12), null, 'one use');

  state.storeCredential(Buffer.from('legacy'));
  state.storeCredential(Buffer.from('tab-12'), 12);
  assert.equal(String(state.takeCredential(12)), 'tab-12', 'the tab value wins over the legacy slot');
  assert.equal(String(state.takeCredential(12)), 'legacy', 'the legacy slot remains the v1 fallback');

  state.storeCredential(Buffer.from('a'), 12);
  state.storeCredential(Buffer.from('b'), 13);
  state.clearCredential(12);
  assert.equal(state.takeCredential(12), null);
  assert.equal(String(state.takeCredential(13)), 'b', 'clearing one tab leaves the others');

  state.storeCredential(Buffer.from('kept'), 12);
  state.storeCredential(Buffer.from('legacy'));
  state.storeSmsCode(Buffer.from('123456'));
  state.clear();
  assert.equal(String(state.takeCredential(12)), 'kept', 'an SMS reset does not wipe tab-bound credentials');
  assert.equal(state.takeCredential(), null, 'an SMS reset still clears the legacy slot');

  state.storeCredential(Buffer.from('gone'), 12);
  state.clearAll();
  assert.equal(state.takeCredential(12), null);

  for (const bad of [0, -1, 1.5, '12', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => state.storeCredential(Buffer.from('x'), bad), /exact tab ID/);
  }
  for (let tab = 1; tab <= 32; tab += 1) state.storeCredential(Buffer.from('x'), tab);
  assert.throws(() => state.storeCredential(Buffer.from('x'), 33), /Too many/);
  state.storeCredential(Buffer.from('replaced'), 32);
  assert.equal(String(state.takeCredential(32)), 'replaced', 'restaging an existing tab is not capped');
  state.clearAll();
}

// State: tab-bound values expire.
{
  const state = new ProtectedPasteState(20);
  state.storeCredential(Buffer.from('short-lived'), 12);
  await sleep(60);
  assert.equal(state.takeCredential(12), null);
}

// State: a bound SMS code is released only to its tab.
{
  const state = new ProtectedPasteState();
  state.storeSmsCode(Buffer.from('123456'), 'servicetitan', 41);
  assert.equal(state.takeSmsCode(42), null);
  assert.equal(state.takeSmsCode(), null);
  const code = state.takeSmsCode(41);
  assert.equal(String(code.value), '123456');
  state.storeSmsCode(Buffer.from('654321'));
  assert.equal(String(state.takeSmsCode(99).value), '654321', 'an unbound code keeps the old behaviour');
}

// Paste: another tab's staged value is never delivered, and nothing is consumed.
{
  const state = new ProtectedPasteState();
  state.storeCredential(Buffer.from('value-for-12'), 12);
  state.storeCredential(Buffer.from('value-for-13'), 13);
  const recorder = fillRecorder();
  await assert.rejects(
    deliverProtectedClipboardPaste(recorder.bridge, { tabId: 14, keys: 'CMD+V', index: 4 }, null, state),
    /Protected clipboard paste is unavailable/,
  );
  assert.equal(recorder.calls.length, 0);
  await deliverProtectedClipboardPaste(recorder.bridge, { tabId: 13, keys: 'CMD+V', index: 4 }, null, state);
  await deliverProtectedClipboardPaste(recorder.bridge, { tabId: 12, keys: 'CMD+V', index: 7 }, null, state);
  assert.deepEqual(recorder.calls.map(call => [call.args.tabId, call.args.uid, call.args.value]), [
    [13, 4, 'value-for-13'],
    [12, 7, 'value-for-12'],
  ]);
}

// Paste: a code bound to tab 41 is not taken by a paste on tab 50.
{
  const state = new ProtectedPasteState();
  state.storeSmsCode(Buffer.from('123456'), 'servicetitan', 41);
  state.storeCredential(Buffer.from('own-value'), 50);
  const recorder = fillRecorder();
  await deliverProtectedClipboardPaste(recorder.bridge, { tabId: 50, keys: 'CMD+V', index: 3 }, null, state);
  assert.deepEqual(recorder.calls.map(call => [call.name, call.args.value]), [['fill', 'own-value']]);
  assert.equal(String(state.takeSmsCode(41).value), '123456');
}

// SMS capture: targetTabId binds the captured code; baselines and bad IDs are refused.
{
  const state = new ProtectedPasteState();
  const bridge = { async callTool() { return { content: [{ type: 'text', text: '{"code":"246810"}' }] }; } };
  await assert.rejects(
    captureProtectedServiceTitanSms(bridge, { tabId: 9, keys: 'CMD+SHIFT+B', targetTabId: 41 }, state),
    /targetTabId/,
  );
  for (const bad of [0, -2, 1.5, '41']) {
    await assert.rejects(
      captureProtectedServiceTitanSms(bridge, { tabId: 9, keys: 'CMD+SHIFT+C', targetTabId: bad }, state),
      /targetTabId/,
    );
  }
  const captured = await captureProtectedServiceTitanSms(bridge, { tabId: 9, keys: 'CMD+SHIFT+C', targetTabId: 41 }, state);
  assert.equal(captured.content[0].text, 'Pressed CMD+SHIFT+C');
  assert.equal(state.takeSmsCode(9), null);
  assert.equal(String(state.takeSmsCode(41).value), '246810');
}

// Broker: v2 frames bind to tabs, CLEAR/2 clears one tab, malformed frames are refused.
{
  const root = await mkdtemp(join(tmpdir(), 'tab-bound-broker-'));
  const socket = join(root, 'credential.sock');
  const state = new ProtectedPasteState();
  const broker = new ProfileCredentialBroker(socket, state);
  await broker.start();
  try {
    assert.equal(await socketExchange(socket, frame('value-for-12', 12)), 'STAGED\n');
    assert.equal(await socketExchange(socket, frame('value-for-13', 13)), 'STAGED\n');
    assert.equal(await socketExchange(socket, Buffer.from('CLEAR/2 12\n')), 'CLEARED\n');
    assert.equal(state.takeCredential(12), null);
    assert.equal(String(state.takeCredential(13)), 'value-for-13');
    assert.equal(await socketExchange(socket, frame('legacy')), 'STAGED\n', 'v1 still works without strict mode');
    assert.equal(String(state.takeCredential(77)), 'legacy');
    for (const bad of [
      Buffer.from('HERMES-CREDENTIAL/2 0 5\nabcde'),
      Buffer.from('HERMES-CREDENTIAL/2 12 6\nabcde'),
      Buffer.from('HERMES-CREDENTIAL/2 x 5\nabcde'),
      Buffer.from('HERMES-CREDENTIAL/2 12\nabcde'),
      Buffer.from('HERMES-CREDENTIAL/2 99999999999999999 5\nabcde'),
      Buffer.concat([Buffer.from('HERMES-CREDENTIAL/2 1'), Buffer.from([0xb2]), Buffer.from(' 5\nabcde')]),
      Buffer.from('CLEAR/2 0\n'),
      Buffer.from('CLEAR/2 12'),
    ]) {
      assert.equal(await socketExchange(socket, bad), 'ERROR\n', String(bad));
    }
  } finally {
    await broker.stop();
    await rm(root, { recursive: true, force: true });
  }
}

// Broker: strict mode refuses untagged v1 frames and keeps v2.
{
  const root = await mkdtemp(join(tmpdir(), 'tab-bound-strict-'));
  const socket = join(root, 'credential.sock');
  const state = new ProtectedPasteState();
  const broker = new ProfileCredentialBroker(socket, state, undefined, undefined, undefined, { requireTabBound: true });
  await broker.start();
  try {
    assert.equal(await socketExchange(socket, frame('legacy')), 'ERROR\n');
    assert.equal(state.takeCredential(5), null);
    assert.equal(await socketExchange(socket, frame('tagged', 5)), 'STAGED\n');
    assert.equal(await socketExchange(socket, Buffer.from('CLEAR\n')), 'CLEARED\n');
    assert.equal(String(state.takeCredential(5)), 'tagged', 'an untagged CLEAR leaves tab-bound values');
  } finally {
    await broker.stop();
    await rm(root, { recursive: true, force: true });
  }
}

// Stdio: the real CLI in strict mode delivers each tab only its own value.
{
  const { TOOLS } = await import(pathToFileURL(resolve(here, '../../extension/tools.js')).href);
  const stateDir = await mkdtemp(join(tmpdir(), 'tab-bound-stdio-'));
  const socket = join(stateDir, 'credential.sock');
  const port = await freePort();
  const profile = 'tab-bound';
  const fills = [];
  const client = new Client({ name: 'tab-bound-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(here, '../dist/cli.js'), 'start', '--port', String(port), '--profile', profile,
      '--require-extension', '--extension-connect-timeout', '5000'],
    env: { ...process.env, BROWSER_MCP_STATE_DIR: stateDir, BROWSER_MCP_REQUIRE_TAB_BOUND_SECRETS: '1' },
    stderr: 'pipe',
  });
  let fake = null;
  try {
    const connecting = client.connect(transport);
    for (let attempt = 0; attempt < 30 && !fake; attempt += 1) {
      const candidate = new FakeExtension({
        port, profile, tools: TOOLS,
        handlers: { fill: (args) => { fills.push({ tabId: args.tabId, uid: args.uid, value: args.value }); return '{"pasted":true}'; } },
      });
      try {
        await candidate.connect();
        fake = candidate;
      } catch {
        await sleep(100);
      }
    }
    assert.ok(fake, 'fake extension connected');
    await connecting;
    assert.equal(await socketExchange(socket, frame('legacy')), 'ERROR\n', 'strict CLI refuses v1');
    assert.equal(await socketExchange(socket, frame('agent-a', 12)), 'STAGED\n');
    assert.equal(await socketExchange(socket, frame('agent-b', 13)), 'STAGED\n');
    const other = await client.callTool({ name: 'press_key', arguments: { tabId: 14, keys: 'CMD+V', index: 2 } });
    assert.equal(other.isError, true);
    assert.equal(other.content[0].text, 'Error: Protected clipboard paste is unavailable');
    for (const tabId of [13, 12]) {
      const pasted = await client.callTool({ name: 'press_key', arguments: { tabId, keys: 'CMD+V', index: 2 } });
      assert.equal(pasted.isError, undefined);
      assert.equal(pasted.content[0].text, 'Pressed CMD+V');
      assert.equal(JSON.stringify(pasted).includes('agent-'), false);
    }
    assert.deepEqual(fills, [
      { tabId: 13, uid: 2, value: 'agent-b' },
      { tabId: 12, uid: 2, value: 'agent-a' },
    ]);
  } finally {
    fake?.close();
    await client.close().catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
}

console.log('tab-bound protected paste ok: per-tab one-use slots, v1 fallback, strict mode and SMS binding');

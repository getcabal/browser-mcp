/**
 * Bridge end-to-end against a fake extension: handshake accept/reject paths,
 * tool round-trips, progress-extends-timeout, and replay semantics.
 */
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LocalExtensionBridge } from '../dist/bridge.js';
import { FakeExtension, freePort, sleep } from './fake-extension.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { TOOLS } = await import(pathToFileURL(resolve(here, '../../extension/tools.js')).href);

const text = (result) => result.content?.[0]?.text ?? '';

// --- 1. Happy path: hello -> pong -> tools -> call round-trip -------------
{
  const port = await freePort();
  const bridge = new LocalExtensionBridge({ port, profile: 'alpha' });
  await bridge.start();
  const fake = new FakeExtension({
    port,
    profile: 'alpha',
    tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }],
    handlers: { echo: (args) => `echo:${args.value}` },
  });
  await fake.connect();
  const pong = await fake.waitForMessage((m) => m.type === 'pong', 3000, 'pong');
  assert.equal(pong.protocolVersion, 2);
  assert.equal(pong.expectedProfile, 'alpha');
  assert.match(String(pong.version), /^\d+\.\d+\.\d+$/);
  await fake.waitForMessage((m) => m.type === 'list_tools', 3000, 'list_tools');
  await bridge.waitForTools(3000);
  assert.equal(bridge.getTools().length, 1);
  assert.equal(bridge.getTools()[0].name, 'echo');
  const result = await bridge.callTool('echo', { value: 'hi' });
  assert.equal(text(result), 'echo:hi');
  // A one-tool extension does not satisfy the Vibe compatibility contract.
  const status = bridge.contractStatus();
  assert.equal(status.ok, false);
  assert.ok(status.problems.includes('missing tool: list_pages'));

  // --- 2. Wrong profile is rejected with 4403 and never displaces ---------
  const wrongProfile = new FakeExtension({ port, profile: 'beta' });
  await wrongProfile.connect();
  const closed = await wrongProfile.waitForClose();
  assert.equal(closed.code, 4403);
  assert.match(closed.reason, /Expected profile "alpha", got "beta"/);
  assert.equal(bridge.isConnected(), true, 'promoted socket survives a rejected connection');
  assert.equal(bridge.getTools().length, 1, 'tools survive a rejected connection');
  assert.equal(text(await bridge.callTool('echo', { value: 'still' })), 'echo:still');

  // --- 3. Wrong protocol version is rejected with 4426 --------------------
  const wrongProtocol = new FakeExtension({ port, profile: 'alpha', protocolVersion: 1 });
  await wrongProtocol.connect();
  const protocolClose = await wrongProtocol.waitForClose();
  assert.equal(protocolClose.code, 4426);
  assert.match(protocolClose.reason, /Protocol version 2 required/);
  assert.equal(bridge.isConnected(), true);

  fake.close();
  await bridge.stop();
  console.log('e2e: handshake happy path + 4403/4426 rejections ok');
}

// --- 4. No hello within the handshake window -> 4400 ----------------------
{
  const port = await freePort();
  const bridge = new LocalExtensionBridge({ port, profile: null, handshakeTimeoutMs: 300 });
  await bridge.start();
  const silent = new FakeExtension({ port, autoHello: false });
  await silent.connect();
  const closed = await silent.waitForClose(2000);
  assert.equal(closed.code, 4400);
  assert.match(closed.reason, /Handshake required/);
  // Null profile on both sides matches (strict equality of null === null).
  const nullProfile = new FakeExtension({ port, profile: null, tools: [] });
  await nullProfile.connect();
  const pong = await nullProfile.waitForMessage((m) => m.type === 'pong', 3000, 'pong');
  assert.equal(pong.expectedProfile, null);
  nullProfile.close();
  await bridge.stop();
  console.log('e2e: 4400 handshake timeout + null-profile match ok');
}

// --- 5. tool_progress resets the pending-call deadline --------------------
{
  const port = await freePort();
  const bridge = new LocalExtensionBridge({ port });
  await bridge.start();
  const fake = new FakeExtension({
    port,
    tools: [],
    handlers: {
      slow: async (args, ext, message) => {
        for (let i = 0; i < 3; i += 1) {
          await sleep(220);
          ext.send({ type: 'tool_progress', requestId: message.requestId, message: 'still running' });
        }
        await sleep(150);
        ext.send({
          type: 'tool_result',
          requestId: message.requestId,
          result: { content: [{ type: 'text', text: 'finished late' }] },
        });
        return undefined;
      },
      slow_silent: async () => {
        await sleep(900);
        return 'too late';
      },
    },
  });
  await fake.connect();
  await fake.waitForMessage((m) => m.type === 'pong');
  // Runs ~810ms against a 500ms budget; progress frames keep it alive.
  const result = await bridge.callTool('slow', {}, 500);
  assert.equal(text(result), 'finished late');
  // Without progress the same budget times out.
  await assert.rejects(
    () => bridge.callTool('slow_silent', {}, 400),
    /timed out after 400ms/,
  );
  fake.close();
  await bridge.stop();
  console.log('e2e: tool_progress extends the call deadline ok');
}

// --- 6. Calls queued before/across connections replay to the promoted socket
{
  const port = await freePort();
  const bridge = new LocalExtensionBridge({ port });
  await bridge.start();
  // Queued before any extension exists.
  const early = bridge.callTool('echo', { value: 'queued' }, 8000);
  await sleep(100);
  const fakeA = new FakeExtension({ port, tools: [], handlers: { echo: (args) => `A:${args.value}` } });
  await fakeA.connect();
  assert.equal(text(await early), 'A:queued');
  // In flight across a reconnect: A never answers, B (fresh socket) does.
  fakeA.handlers.pending_call = async () => undefined; // swallow
  const inFlight = bridge.callTool('pending_call', {}, 8000);
  await sleep(150);
  fakeA.close();
  await sleep(100);
  const fakeB = new FakeExtension({ port, tools: [], handlers: { pending_call: () => 'answered by B' } });
  await fakeB.connect();
  assert.equal(text(await inFlight), 'answered by B');
  fakeB.close();
  await bridge.stop();
  console.log('e2e: pending-call replay across reconnect ok');
}

// --- 7. Full contract advertisement satisfies waitForContract -------------
{
  const port = await freePort();
  const bridge = new LocalExtensionBridge({ port, profile: 'fleet-check' });
  await bridge.start();
  const pendingCheck = bridge.waitForContract(3000);
  const fake = new FakeExtension({ port, profile: 'fleet-check', tools: TOOLS });
  await fake.connect();
  const status = await pendingCheck;
  assert.equal(status.ok, true, `contract should validate, got: ${status.problems.join('; ')}`);
  // Losing the extension clears tools and fails the contract again.
  fake.close();
  await sleep(150);
  assert.equal(bridge.getTools().length, 0);
  assert.equal(bridge.contractStatus().ok, false);
  await bridge.stop();
  console.log('e2e: waitForContract with the real 24-tool list ok');
}

console.log('bridge e2e ok');

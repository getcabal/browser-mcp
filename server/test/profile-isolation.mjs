/**
 * Fleet isolation: 12 bridge/extension pairs, each with its own port and
 * profile, operating concurrently without cross-talk; wrong-profile
 * connections fail closed without disturbing the fleet.
 */
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LocalExtensionBridge } from '../dist/bridge.js';
import { FakeExtension, freePort, sleep } from './fake-extension.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { TOOLS } = await import(pathToFileURL(resolve(here, '../../extension/tools.js')).href);

const FLEET_SIZE = 12;
const CALL_DELAY_MS = 200;
const text = (result) => result.content?.[0]?.text ?? '';

const ports = [];
for (let i = 0; i < FLEET_SIZE; i += 1) ports.push(await freePort());
assert.equal(new Set(ports).size, FLEET_SIZE, 'each instance gets its own port');

const bridges = ports.map((port, i) => new LocalExtensionBridge({ port, profile: `fleet-${i}` }));
await Promise.all(bridges.map((bridge) => bridge.start()));

const fakes = ports.map((port, i) => new FakeExtension({
  port,
  profile: `fleet-${i}`,
  tools: TOOLS,
  handlers: {
    evaluate: async () => {
      await sleep(CALL_DELAY_MS);
      return `fleet-${i}`;
    },
  },
}));
await Promise.all(fakes.map((fake) => fake.connect()));

// Every instance is promoted with its own expected profile and full contract.
for (const [i, fake] of fakes.entries()) {
  const pong = await fake.waitForMessage((m) => m.type === 'pong', 3000, `pong ${i}`);
  assert.equal(pong.expectedProfile, `fleet-${i}`);
}
const statuses = await Promise.all(bridges.map((bridge) => bridge.waitForContract(3000)));
for (const [i, status] of statuses.entries()) {
  assert.equal(status.ok, true, `fleet-${i} contract: ${status.problems.join('; ')}`);
}

// A wrong-profile extension knocking on bridge 0 is rejected closed...
const impostor = new FakeExtension({ port: ports[0], profile: 'fleet-1', tools: TOOLS });
await impostor.connect();
const closed = await impostor.waitForClose();
assert.equal(closed.code, 4403);
assert.match(closed.reason, /Expected profile "fleet-0", got "fleet-1"/);
// ...and bridge 0 keeps its promoted extension and tools.
assert.equal(bridges[0].isConnected(), true);
assert.equal(bridges[0].getTools().length, TOOLS.length);

// 12 concurrent calls each route to their own profile, in parallel.
const started = Date.now();
const results = await Promise.all(bridges.map((bridge) => bridge.callTool('evaluate', { expression: 'profile' }, 5000)));
const elapsed = Date.now() - started;
for (const [i, result] of results.entries()) {
  assert.equal(text(result), `fleet-${i}`, `call ${i} answered by its own extension`);
}
const serialFloor = FLEET_SIZE * CALL_DELAY_MS;
assert.ok(elapsed < serialFloor / 2, `concurrent fleet calls took ${elapsed}ms (serial would be >= ${serialFloor}ms)`);

// One instance dying does not affect the rest.
fakes[5].close();
await sleep(150);
assert.equal(bridges[5].isConnected(), false);
assert.equal(bridges[4].isConnected(), true);
assert.equal(text(await bridges[4].callTool('evaluate', { expression: 'profile' }, 5000)), 'fleet-4');

for (const fake of fakes) fake.close();
await Promise.all(bridges.map((bridge) => bridge.stop()));
console.log(`profile isolation ok: ${FLEET_SIZE} concurrent instances, ${elapsed}ms for ${FLEET_SIZE} parallel calls, wrong-profile rejected with 4403`);

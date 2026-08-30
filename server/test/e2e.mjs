import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import { LocalExtensionBridge } from '../dist/bridge.js';

const port = await freePort();
const bridge = new LocalExtensionBridge(port);
await bridge.start();
const extension = new WebSocket(`ws://127.0.0.1:${port}`);
const seen = [];
extension.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  seen.push(message);
  if (message.type === 'list_tools') extension.send(JSON.stringify({
    type: 'tools_list', requestId: message.requestId,
    data: [{ name: 'echo', description: 'test', inputSchema: { type: 'object', properties: {} } }],
  }));
  if (message.type === 'call_tool') extension.send(JSON.stringify({
    type: 'tool_result', requestId: message.requestId,
    data: { content: [{ type: 'text', text: `ok:${message.data.arguments.value}` }] },
  }));
});
await new Promise((resolve, reject) => { extension.once('open', resolve); extension.once('error', reject); });
extension.send(JSON.stringify({ type: 'connected' }));
await bridge.waitForTools(2_000);
assert.equal(bridge.getTools()[0].name, 'echo');
const result = await bridge.callTool('echo', { value: 42 }, 2_000);
assert.equal(result.content[0].text, 'ok:42');
assert.ok(seen.some((message) => message.type === 'call_tool'));
extension.close();
await bridge.stop();
console.log('local bridge e2e ok');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

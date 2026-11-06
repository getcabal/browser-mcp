/**
 * Window mode for a browser several jobs share (BROWSER_MCP_PAGE_ISOLATION=window):
 * page tools must name their page, an older extension cannot silently fall
 * back to shared tabs, every call carries the mode to the extension, and the
 * default mode is exactly as before.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  describeWindowMode,
  MISSING_PAGE_MESSAGE,
  OLD_EXTENSION_MESSAGE,
  PAGE_REQUIRED_TOOLS,
  parsePageIsolation,
  requireOwnPage,
  WINDOW_ISOLATION_CAPABILITY,
} from '../dist/page-isolation.js';
import { CONTRACT_TOOLS } from '../dist/contract.js';
import { FakeExtension, freePort, sleep } from './fake-extension.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { TOOLS } = await import(pathToFileURL(resolve(here, '../../extension/tools.js')).href);
const cli = resolve(here, '../dist/cli.js');

// --- Parsing the mode -------------------------------------------------------
assert.equal(parsePageIsolation(undefined), 'none');
assert.equal(parsePageIsolation(''), 'none');
assert.equal(parsePageIsolation(' none '), 'none');
assert.equal(parsePageIsolation('window'), 'window');
assert.throws(() => parsePageIsolation('tabs'), /must be "window" or empty/);
assert.throws(() => parsePageIsolation('WINDOW'), /must be "window" or empty/);

// --- Page ids are required only in window mode, only for fallback tools ------
assert.deepEqual([...PAGE_REQUIRED_TOOLS].sort(), [
  'evaluate', 'evaluate_script', 'get_text', 'take_snapshot', 'wait_for_condition',
  'wait_for_network_idle', 'wait_for_url',
]);
for (const name of PAGE_REQUIRED_TOOLS) {
  assert.throws(() => requireOwnPage('window', name, {}), (error) => error.message === MISSING_PAGE_MESSAGE);
  assert.throws(() => requireOwnPage('window', name, { pageId: 0 }), /shared by several jobs/);
  assert.throws(() => requireOwnPage('window', name, { tabId: '12' }), /shared by several jobs/);
  assert.throws(() => requireOwnPage('window', name, { pageId: 1.5 }), /shared by several jobs/);
  requireOwnPage('window', name, { pageId: 12 });
  requireOwnPage('window', name, { tabId: 12 });
  requireOwnPage('none', name, {});
}
for (const name of ['list_pages', 'new_page', 'navigate_page', 'click', 'press_key', 'take_screenshot']) {
  requireOwnPage('window', name, {});
}

// --- Descriptions explain the mode; the wire contract is untouched ------------
{
  const before = structuredClone(CONTRACT_TOOLS);
  const described = CONTRACT_TOOLS.map(describeWindowMode);
  assert.deepEqual(CONTRACT_TOOLS, before, 'describing never mutates the contract copy');
  const byName = new Map(described.map((tool) => [tool.name, tool]));
  assert.match(byName.get('new_page').description, /own window/);
  assert.match(byName.get('new_page').description, /never brought to the front/);
  assert.match(byName.get('new_page').inputSchema.properties.focus.description, /^Ignored in this browser/);
  assert.match(byName.get('switch_to_page').description, /without bringing the window to the front/);
  assert.match(byName.get('take_snapshot').inputSchema.properties.pageId.description, /^Required in this shared browser/);
  assert.match(byName.get('evaluate_script').inputSchema.properties.tabId.description, /^Required in this shared browser/);
  assert.match(byName.get('wait_for_url').inputSchema.properties.tabId.description, /^Required in this shared browser/);
  assert.equal(byName.get('wait_for_url').inputSchema.properties.pageId, undefined, 'no invented properties');
  assert.deepEqual(byName.get('click'), CONTRACT_TOOLS.find((tool) => tool.name === 'click'));
}

// --- A bad mode value stops the connector before it listens -------------------
{
  const child = spawnSync(process.execPath, [cli, 'start', '--port', String(await freePort())], {
    env: { ...process.env, BROWSER_MCP_PAGE_ISOLATION: 'tabs' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /BROWSER_MCP_PAGE_ISOLATION must be "window" or empty/);
}

// --- Real stdio connector against fake extensions -----------------------------
async function startConnector(mode, profile) {
  const port = await freePort();
  const env = { ...process.env };
  delete env.BROWSER_MCP_PAGE_ISOLATION;
  if (mode !== undefined) env.BROWSER_MCP_PAGE_ISOLATION = mode;
  const client = new Client({ name: `page-isolation-${profile}`, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'start', '--port', String(port), '--profile', profile],
    env,
    stderr: 'pipe',
  });
  await client.connect(transport);
  return { client, port };
}

const calls = (fake, name) => fake.messages.filter((m) => m.type === 'call_tool' && m.name === name);
const handlers = {
  take_snapshot: (args) => `snapshot of ${args.pageId ?? args.tabId ?? 'active'}`,
  evaluate_script: () => '"ok"',
  new_page: () => 'Opened new page in its own window 9, not brought to the front\nTab ID: 41\nTitle: \nURL: about:blank',
  switch_to_page: (args) => `Switched to page ${args.pageId}\nTab ID: ${args.pageId}`,
  list_pages: () => 'Found 0 page(s):',
};

async function connectFake(port, profile, capabilities) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const fake = new FakeExtension({ port, profile, tools: TOOLS, handlers, capabilities });
    try {
      await fake.connect();
      await fake.waitForMessage((m) => m.type === 'list_tools', 3000, 'list_tools');
      return fake;
    } catch {
      await sleep(100);
    }
  }
  throw new Error('fake extension could not connect');
}

const textOf = (result) => result.content?.[0]?.text ?? '';

// Window mode with an extension that predates it: refuse, never forward.
{
  const { client, port } = await startConnector('window', 'marketing-old-extension');
  const fake = await connectFake(port, 'marketing-old-extension', null);
  try {
    const listed = await client.listTools();
    const newPage = listed.tools.find((tool) => tool.name === 'new_page');
    assert.match(newPage.description, /own window/, 'tools/list explains window mode');

    const missing = await client.callTool({ name: 'take_snapshot', arguments: { format: 'markdown' } });
    assert.equal(missing.isError, true);
    assert.equal(textOf(missing), `Error: ${MISSING_PAGE_MESSAGE}`);
    const missingEval = await client.callTool({ name: 'evaluate_script', arguments: { function: '() => 1' } });
    assert.equal(missingEval.isError, true);
    assert.equal(calls(fake, 'take_snapshot').length + calls(fake, 'evaluate_script').length, 0,
      'a call naming no page never reaches the extension');

    for (const [name, args] of [['new_page', { url: 'https://example.com/' }], ['switch_to_page', { pageId: 41 }]]) {
      const refused = await client.callTool({ name, arguments: args });
      assert.equal(refused.isError, true, `${name} is refused by an old extension`);
      assert.equal(textOf(refused), `Error: ${OLD_EXTENSION_MESSAGE}`);
      assert.equal(calls(fake, name).length, 0, `${name} was not forwarded to the old extension`);
    }

    const named = await client.callTool({ name: 'take_snapshot', arguments: { pageId: 41 } });
    assert.equal(named.isError, undefined);
    assert.equal(textOf(named), 'snapshot of 41');
    assert.deepEqual(calls(fake, 'take_snapshot')[0].options, { pageIsolation: 'window' },
      'every call carries the mode to the extension');
  } finally {
    fake.close();
    await client.close().catch(() => {});
  }
}

// Window mode with a capable extension: forwarded with the mode.
{
  const { client, port } = await startConnector('window', 'marketing-window');
  const fake = await connectFake(port, 'marketing-window', [WINDOW_ISOLATION_CAPABILITY, 'unrelated']);
  try {
    const opened = await client.callTool({ name: 'new_page', arguments: { url: 'https://example.com/', focus: true } });
    assert.equal(opened.isError, undefined);
    assert.match(textOf(opened), /^Tab ID: 41$/m);
    const [forwarded] = calls(fake, 'new_page');
    assert.deepEqual(forwarded.options, { pageIsolation: 'window' });
    assert.deepEqual(forwarded.args, { url: 'https://example.com/', focus: true }, 'arguments pass through unchanged');

    const switched = await client.callTool({ name: 'switch_to_page', arguments: { pageId: 41 } });
    assert.equal(textOf(switched).split('\n')[0], 'Switched to page 41');
    assert.deepEqual(calls(fake, 'switch_to_page')[0].options, { pageIsolation: 'window' });

    await client.callTool({ name: 'list_pages', arguments: {} });
    assert.deepEqual(calls(fake, 'list_pages')[0].options, { pageIsolation: 'window' });
  } finally {
    fake.close();
    await client.close().catch(() => {});
  }
}

// Default mode: exactly the old wire behaviour.
{
  const { client, port } = await startConnector(undefined, 'finance-default');
  const fake = await connectFake(port, 'finance-default', null);
  try {
    const listed = await client.listTools();
    const newPage = listed.tools.find((tool) => tool.name === 'new_page');
    assert.equal(newPage.description, 'Open a new page and optionally navigate to a URL.');
    const snapshot = await client.callTool({ name: 'take_snapshot', arguments: {} });
    assert.equal(textOf(snapshot), 'snapshot of active', 'the active-page fallback still works by default');
    const opened = await client.callTool({ name: 'new_page', arguments: { url: 'https://example.com/' } });
    assert.equal(opened.isError, undefined, 'an extension without the capability still opens pages by default');
    for (const message of fake.messages.filter((m) => m.type === 'call_tool')) {
      assert.equal(Object.hasOwn(message, 'options'), false, 'default calls carry no options');
    }
  } finally {
    fake.close();
    await client.close().catch(() => {});
  }
}

console.log('page isolation ok: window mode requires own pages, refuses old extensions, default unchanged');

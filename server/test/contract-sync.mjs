/**
 * Contract acceptance test.
 *
 * The golden fixture was captured from a live @vibebrowser/mcp@0.3.6
 * tools/list response. It is intentionally independent of both production
 * contract copies and is the migration compatibility boundary.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(resolve(here, 'fixtures/vibe-tools-0.3.6.json'), 'utf8'));
const golden = fixture.tools;
const extension = await import(pathToFileURL(resolve(here, '../../extension/tools.js')).href);
const contract = await import(pathToFileURL(resolve(here, '../dist/contract.js')).href);

assert.equal(fixture.source.package, '@vibebrowser/mcp');
assert.equal(fixture.source.packageVersion, '0.3.6');
assert.equal(golden.length, 22, 'golden fixture contains 22 Vibe core tools');
assert.deepEqual(contract.CONTRACT_TOOLS, golden, 'server contract exactly matches captured Vibe tools/list');
assert.deepEqual(extension.CONTRACT_TOOLS, golden, 'extension contract exactly matches captured Vibe tools/list');

const expectedExtras = ['get_text', 'evaluate'];
assert.equal(extension.TOOLS.length, 24, 'extension advertises 22 compatible tools plus two local extras');
assert.deepEqual(extension.EXTRA_TOOLS.map((tool) => tool.name), expectedExtras);
assert.deepEqual(contract.EXTRA_TOOLS.map((tool) => tool.name), expectedExtras);

for (const legacy of ['list_tabs', 'snapshot', 'navigate', 'new_tab', 'select_tab', 'close_tab', 'screenshot', 'scroll']) {
  assert.ok(!extension.TOOLS.some((tool) => tool.name === legacy), `prototype tool name ${legacy} is absent`);
}

const schema = (name) => golden.find((tool) => tool.name === name).inputSchema;
const required = (name) => schema(name).required ?? [];
const expectedRequired = {
  navigate_page: ['type', 'pageId'],
  list_pages: [],
  new_page: [],
  switch_to_page: ['pageId'],
  close_page: ['pageId'],
  click: ['tabId', 'uid'],
  fill: ['tabId', 'uid', 'value'],
  fill_form: ['tabId', 'elements'],
  upload_file: ['tabId', 'uid'],
  type_text: ['tabId', 'text'],
  scroll_page: ['tabId', 'direction', 'numPages'],
  wait_for: ['tabId', 'text'],
  wait_for_url: ['pattern'],
  wait_for_network_idle: [],
  wait_for_condition: ['expression'],
  evaluate_script: ['function'],
  press_key: ['tabId', 'keys'],
  hover: ['tabId', 'index'],
  drag: ['tabId', 'source', 'target'],
  resize_page: ['tabId', 'width', 'height'],
  take_screenshot: ['tabId'],
  take_snapshot: [],
};
for (const [name, fields] of Object.entries(expectedRequired)) {
  assert.deepEqual(required(name), fields, `${name} required fields match Vibe`);
  assert.deepEqual(schema(name).properties.pageStateFormat.enum, ['markdown', 'accessibility_tree'], `${name} accepts pageStateFormat`);
}
assert.ok(!('filePath' in schema('upload_file').properties), 'upload_file cannot expose arbitrary host paths');
assert.equal(schema('new_page').properties.focus.default, false);
assert.equal(schema('new_page').properties.waitForReady.default, true);
assert.equal(schema('navigate_page').properties.timeoutMs.default, 45000);
assert.equal(schema('wait_for').properties.timeout.default, 10000);
assert.equal(schema('wait_for_url').properties.timeout.default, 15000);
assert.equal(schema('wait_for_network_idle').properties.idleMs.default, 800);
assert.equal(schema('wait_for_condition').properties.pollMs.default, 250);
assert.equal(schema('take_snapshot').properties.format.default, 'markdown');

assert.deepEqual(contract.validateExtensionTools(extension.TOOLS), []);
const schemaDrift = extension.TOOLS.map((tool) => tool.name === 'click'
  ? { ...tool, inputSchema: { type: 'object', properties: {} } }
  : tool);
assert.ok(contract.validateExtensionTools(schemaDrift).some((problem) => problem.includes('click') && problem.includes('inputSchema')));
const descriptionDrift = extension.TOOLS.map((tool) => tool.name === 'click'
  ? { ...tool, description: 'Almost the same' }
  : tool);
assert.ok(contract.validateExtensionTools(descriptionDrift).some((problem) => problem.includes('click') && problem.includes('description')));
assert.ok(contract.validateExtensionTools(extension.TOOLS.filter((tool) => tool.name !== 'drag')).includes('missing tool: drag'));
assert.ok(contract.validateExtensionTools([...extension.TOOLS, {
  name: 'set_remote', description: 'unsafe', inputSchema: { type: 'object', properties: {} },
}]).includes('unexpected tool: set_remote'));

const enrichedCore = contract.enrichTools(extension.TOOLS).slice(0, golden.length);
assert.deepEqual(enrichedCore, golden, 'MCP enrichment returns the exact captured Vibe contract');
for (const tool of contract.ALL_TOOLS) {
  assert.equal(typeof tool.title, 'string', `${tool.name} has title`);
  for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
    assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name} has ${hint}`);
  }
}

assert.equal(extension.PROTOCOL_VERSION, contract.PROTOCOL_VERSION, 'protocol versions match');
const rootPkg = JSON.parse(await readFile(resolve(here, '../../package.json'), 'utf8'));
const serverPkg = JSON.parse(await readFile(resolve(here, '../package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(here, '../../extension/manifest.json'), 'utf8'));
const lock = JSON.parse(await readFile(resolve(here, '../../package-lock.json'), 'utf8'));
assert.equal(rootPkg.version, contract.VERSION);
assert.equal(serverPkg.version, contract.VERSION);
assert.equal(manifest.version, contract.VERSION);
assert.equal(lock.version, contract.VERSION);
assert.equal(lock.packages[''].version, contract.VERSION);
assert.equal(lock.packages.server.version, contract.VERSION);

console.log(`contract sync ok: exact ${fixture.source.package}@${fixture.source.packageVersion} 22-tool contract + 2 local extras, version ${contract.VERSION}`);

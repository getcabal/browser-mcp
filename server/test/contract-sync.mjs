/**
 * Guards the dual-data contract: extension/tools.js (what the extension
 * advertises) must byte-match server/src/contract.ts (the reviewed contract),
 * and both must match the established 22-tool surface from browser.md.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extension = await import(pathToFileURL(resolve(here, '../../extension/tools.js')).href);
const contract = await import(pathToFileURL(resolve(here, '../dist/contract.js')).href);

// The established contract surface, hard-coded independently of both modules.
const EXPECTED_CONTRACT_NAMES = [
  'list_pages', 'new_page', 'close_page', 'navigate_page', 'switch_to_page',
  'take_snapshot', 'click', 'fill', 'fill_form', 'type_text',
  'wait_for', 'wait_for_url', 'wait_for_network_idle', 'wait_for_condition',
  'scroll_page', 'press_key', 'hover', 'drag', 'take_screenshot',
  'evaluate_script', 'upload_file', 'resize_page',
];
const EXPECTED_EXTRA_NAMES = ['get_text', 'evaluate'];

assert.equal(extension.TOOLS.length, 24, 'extension advertises exactly 24 tools');
assert.equal(extension.CONTRACT_TOOLS.length, 22, '22 reviewed contract tools');
assert.deepEqual(
  [...extension.CONTRACT_TOOLS.map((tool) => tool.name)].sort(),
  [...EXPECTED_CONTRACT_NAMES].sort(),
  'contract tool names match the established surface',
);
assert.deepEqual(extension.EXTRA_TOOLS.map((tool) => tool.name), EXPECTED_EXTRA_NAMES);

// Old prototype names must be gone.
for (const legacy of ['list_tabs', 'snapshot', 'navigate', 'new_tab', 'select_tab', 'close_tab', 'screenshot', 'scroll']) {
  assert.ok(!extension.TOOLS.some((tool) => tool.name === legacy), `legacy tool name ${legacy} removed`);
}

// Deep equality between the two data sources, entry by entry, in order.
assert.equal(contract.ALL_TOOLS.length, extension.TOOLS.length);
for (const [index, expected] of contract.ALL_TOOLS.entries()) {
  const actual = extension.TOOLS[index];
  assert.equal(actual.name, expected.name, `tool #${index} name matches`);
  assert.equal(actual.description, expected.description, `${expected.name} description matches contract.ts`);
  assert.deepEqual(actual.inputSchema, expected.inputSchema, `${expected.name} inputSchema matches contract.ts`);
}

// Required-parameter spot checks (browser.md spellings: tabId/uid/keys/value).
const schema = (name) => extension.TOOLS.find((tool) => tool.name === name).inputSchema;
const required = (name) => schema(name).required ?? [];
assert.deepEqual(required('click'), ['uid']);
assert.deepEqual(required('fill'), ['uid', 'value']);
assert.deepEqual(required('fill_form'), ['elements']);
assert.deepEqual(required('press_key'), ['keys']);
assert.deepEqual(required('drag'), ['from_uid', 'to_uid']);
assert.deepEqual(required('resize_page'), ['width', 'height']);
assert.deepEqual(required('switch_to_page'), ['tabId']);
assert.deepEqual(required('evaluate_script'), ['function']);
assert.deepEqual(required('new_page'), ['url']);
assert.deepEqual(required('navigate_page'), ['url']);
assert.deepEqual(required('wait_for'), ['text']);
assert.deepEqual(required('wait_for_url'), ['url']);
assert.deepEqual(required('wait_for_condition'), ['condition']);
assert.deepEqual(required('type_text'), ['text']);
assert.deepEqual(required('upload_file'), ['uid']);
assert.deepEqual(required('hover'), ['uid']);
assert.deepEqual(required('evaluate'), ['expression']);
assert.equal(required('list_pages').length, 0);
assert.ok('tabId' in schema('click').properties, 'click accepts tabId');
assert.ok('uid' in schema('click').properties, 'click uses uid, not ref');
assert.ok(!('ref' in schema('click').properties), 'click has no legacy ref parameter');
assert.ok('value' in schema('fill').properties, 'fill uses value, not text');
assert.ok(!('text' in schema('fill').properties), 'fill has no legacy text parameter');
assert.ok('keys' in schema('press_key').properties, 'press_key uses keys, not key');
assert.ok(!('key' in schema('press_key').properties), 'press_key has no legacy key parameter');
assert.deepEqual(schema('navigate_page').properties.type.enum, ['url', 'back', 'forward', 'reload']);
assert.ok(Array.isArray(schema('wait_for').properties.text.anyOf), 'wait_for text accepts string or array');

// validateExtensionTools: passes on the real list, catches drift.
assert.deepEqual(contract.validateExtensionTools(extension.TOOLS), []);
const mutated = extension.TOOLS.map((tool) => (tool.name === 'click' ? { ...tool, inputSchema: { type: 'object' } } : tool));
assert.ok(contract.validateExtensionTools(mutated).some((problem) => problem.includes('click')), 'schema drift detected');
assert.ok(
  contract.validateExtensionTools(extension.TOOLS.filter((tool) => tool.name !== 'drag'))
    .includes('missing tool: drag'),
  'missing tool detected',
);
assert.ok(
  contract.validateExtensionTools([...extension.TOOLS, { name: 'set_remote', inputSchema: { type: 'object' } }])
    .some((problem) => problem.includes('set_remote')),
  'unexpected tool detected',
);

// Annotations: present for all 24, with the reviewed classification.
const annotations = (name) => contract.ALL_TOOLS.find((tool) => tool.name === name).annotations;
for (const tool of contract.ALL_TOOLS) {
  assert.ok(tool.annotations && typeof tool.annotations.title === 'string' && tool.annotations.title.length, `${tool.name} has a title`);
  for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
    assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name} has ${hint}`);
  }
}
const readOnly = contract.ALL_TOOLS.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name).sort();
assert.deepEqual(readOnly, ['get_text', 'list_pages', 'take_screenshot', 'take_snapshot', 'wait_for', 'wait_for_network_idle', 'wait_for_url'].sort());
for (const name of ['evaluate_script', 'wait_for_condition', 'evaluate']) {
  assert.equal(annotations(name).destructiveHint, true, `${name} is destructive (runs arbitrary JS)`);
  assert.equal(annotations(name).openWorldHint, true, `${name} is open-world`);
}
assert.equal(annotations('press_key').destructiveHint, true, 'press_key destructive (chords like Control+w)');
assert.equal(annotations('close_page').destructiveHint, true);

// enrichTools merges title + annotations onto extension definitions.
const enriched = contract.enrichTools(extension.TOOLS);
assert.equal(enriched.length, 24);
assert.equal(enriched.find((tool) => tool.name === 'click').title, 'Click Element');
assert.deepEqual(enriched.find((tool) => tool.name === 'click').annotations, annotations('click'));
assert.equal(enriched.find((tool) => tool.name === 'get_text').title, 'Get Page Text');

// Protocol and product versions stay in lock-step everywhere.
assert.equal(extension.PROTOCOL_VERSION, contract.PROTOCOL_VERSION, 'protocol versions match');
const rootPkg = JSON.parse(await readFile(resolve(here, '../../package.json'), 'utf8'));
const serverPkg = JSON.parse(await readFile(resolve(here, '../package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(here, '../../extension/manifest.json'), 'utf8'));
assert.equal(rootPkg.version, contract.VERSION, 'root package.json version matches contract');
assert.equal(serverPkg.version, contract.VERSION, 'server package.json version matches contract');
assert.equal(manifest.version, contract.VERSION, 'extension manifest version matches contract');

console.log('contract sync ok: 22 contract tools + 2 local extras, schemas identical, versions aligned at', contract.VERSION);

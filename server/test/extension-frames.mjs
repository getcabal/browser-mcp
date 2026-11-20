import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { isSensitiveInputNode, redactSensitiveAccessibleName } from '../../extension/redaction.js';

const source = await readFile(new URL('../../extension/background.js', import.meta.url), 'utf8');
const ax = (nodeId, backendDOMNodeId, role, name) => ({
  nodeId, backendDOMNodeId, role: { value: role }, name: { value: name },
});
const frame = (id, origin = 'https://example.test') => ({ frame: { id, securityOrigin: origin } });
const tree = frame('main');
tree.childFrames = [frame('logon'), frame('hidden'), frame('foreign', 'https://other.test')];
const trees = {
  main: [ax('1', 1, 'RootWebArea', 'Loading')],
  logon: [ax('1', 2, 'textbox', 'Username'), ax('2', 3, 'textbox', 'Password'), ax('3', 4, 'button', 'Sign in')],
};
const calls = [];
let stale = false;
const context = vm.createContext({
  MAX_SNAPSHOT_LINES: 100, isSensitiveInputNode, redactSensitiveAccessibleName,
  pageLines: async () => 'Tab ID: 7',
  callOnElement: async (_tab, owner) => owner === 'logon',
  cdp: async (tab, method, args) => {
    assert.equal(tab, 7);
    calls.push({ method, args });
    if (method === 'Page.getFrameTree') return { frameTree: tree };
    if (method === 'DOM.getFrameOwner') return { backendNodeId: args.frameId };
    if (method === 'Accessibility.getFullAXTree') {
      assert.ok(trees[args.frameId], 'must not read hidden or foreign frame AX trees');
      return { nodes: trees[args.frameId] };
    }
    if (method === 'DOM.describeNode') {
      if (stale) throw new Error('detached');
      return { node: { attributes: args.backendNodeId === 3 ? ['type', 'password'] : [] } };
    }
    throw new Error(`unexpected ${method}`);
  },
});
vm.runInContext(source.slice(source.indexOf('const snapshots ='), source.indexOf('async function elementCenter')), context);
for (const format of ['markdown', 'accessibility_tree', 'aria']) {
  const snapshot = await vm.runInContext(`takeSnapshotFor(7, {format: '${format}'})`, context);
  for (const name of ['Username', 'Password', 'Sign in']) assert.ok(snapshot.includes(name));
  assert.equal(await vm.runInContext('resolveUid(7, 2, false)', context), 2);
  assert.equal(await vm.runInContext('resolveUid(7, 3, false)', context), 3);
  assert.equal(await vm.runInContext('resolveUid(7, 4, false)', context), 4);
}
// A panel the connector closed to regain the tab is reported once, in the
// next snapshot's header (extension-foreign-panels.mjs covers the closing).
vm.runInContext("closedForeignPanels.set(7, new Set(['1Password']))", context);
assert.match(
  await vm.runInContext("takeSnapshotFor(7, {format: 'markdown'})", context),
  /^Tab ID: 7\nFormat: markdown\nPage changed: (true|false)\nClosed 1Password's panel on this tab to restore page control; no settings changed\.\n/,
);
assert.doesNotMatch(await vm.runInContext("takeSnapshotFor(7, {format: 'markdown'})", context), /Closed 1Password/);
stale = true;
calls.length = 0;
await assert.rejects(vm.runInContext('resolveUid(7, 2, false)', context), /stale/);
assert.deepEqual(calls.map(c => c.method), ['DOM.describeNode'], 'protected targets never relocate by name');
await assert.rejects(vm.runInContext('resolveUid(7, 999, false)', context), /Unknown uid/);

// A child can detach during owner lookup, visibility evaluation, or AX lookup.
// Continue to later siblings, but retain failures for live children and main frames.
for (const failureAt of ['DOM.getFrameOwner', 'visibility', 'Accessibility.getFullAXTree']) {
  for (const detached of [true, false]) {
    const initialTree = frame('main');
    initialTree.childFrames = [frame('gone'), frame('logon'), frame('foreign', 'https://other.test')];
    const currentTree = frame('main');
    currentTree.childFrames = detached ? initialTree.childFrames.slice(1) : initialTree.childFrames;
    const failure = new Error(`child failure at ${failureAt}`);
    let failed = false;
    const maybeFail = (stage, id) => {
      if (stage === failureAt && id === 'gone') {
        failed = true;
        throw failure;
      }
    };
    const race = vm.createContext({
      callOnElement: async (_tab, owner) => { maybeFail('visibility', owner); return true; },
      cdp: async (_tab, method, args) => {
        if (method === 'Page.getFrameTree') return {frameTree: failed ? currentTree : initialTree};
        assert.notEqual(args.frameId, 'foreign', 'foreign frames remain isolated');
        maybeFail(method, args.frameId);
        if (method === 'DOM.getFrameOwner') return {backendNodeId: args.frameId};
        if (method === 'Accessibility.getFullAXTree') return {nodes: trees[args.frameId] || []};
        throw new Error(`unexpected ${method}`);
      },
    });
    const accessibilitySource = source.slice(source.indexOf('async function accessibilityNodes'), source.indexOf('function hashText'));
    vm.runInContext(accessibilitySource, race);
    if (detached) {
      const nodes = await vm.runInContext('accessibilityNodes(7)', race);
      assert.deepEqual(Array.from(nodes, node => node.backendDOMNodeId), [1, 2, 3, 4]);
    } else {
      await assert.rejects(vm.runInContext('accessibilityNodes(7)', race), error => error === failure);
    }
  }
}
for (const failureAt of ['Page.getFrameTree', 'Accessibility.getFullAXTree']) {
  const failure = new Error(`main failure at ${failureAt}`);
  const mainFailure = vm.createContext({
    cdp: async (_tab, method) => {
      if (method === failureAt) throw failure;
      if (method === 'Page.getFrameTree') return {frameTree: tree};
      throw new Error(`unexpected ${method}`);
    },
  });
  vm.runInContext(source.slice(source.indexOf('async function accessibilityNodes'), source.indexOf('function hashText')), mainFailure);
  await assert.rejects(vm.runInContext('accessibilityNodes(7)', mainFailure), error => error === failure);
}

// The native setter and events must come from the field's frame realm.
const child = vm.createContext({});
vm.runInContext(`
  class HTMLInputElement {
    get value() { return this.stored || ''; }
    set value(value) { this.stored = value; }
  }
  class HTMLTextAreaElement extends HTMLInputElement {}
  class Event { constructor(type) { this.type = type; } }
  const view = { HTMLInputElement, HTMLTextAreaElement, Event, frameElement: null,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  const doc = { defaultView: view };
  const field = new HTMLInputElement();
  Object.assign(field, { ownerDocument: doc, tagName: 'INPUT', type: 'password', isConnected: true,
    getBoundingClientRect: () => ({ width: 100, height: 30 }), getRootNode: () => doc,
    focus() { doc.activeElement = this; },
    events: [], dispatchEvent(event) { if (!(event instanceof Event)) throw Error('wrong realm'); this.events.push(event.type); }
  });
  field.value = 'old';
  globalThis.field = field;
`, child);
const setter = vm.runInContext(source.slice(source.indexOf('const SET_VALUE_FN'), source.indexOf('async function setElementValue')) + '\nSET_VALUE_FN', context);
const apply = vm.runInNewContext(`(${setter})`);
assert.equal(apply.call(child.field, 'synthetic-replacement', true).pasted, true);
assert.equal(child.field.value, 'synthetic-replacement');
assert.deepEqual(Array.from(child.field.events), ['input', 'change']);
child.field.disabled = true;
assert.throws(() => apply.call(child.field, 'must-not-type', true), /not editable/);
assert.equal(child.field.value, 'synthetic-replacement');
child.field.disabled = false;
child.field.focus = () => {};
child.field.ownerDocument.activeElement = {};
assert.throws(() => apply.call(child.field, 'must-not-type', true), /could not be focused/);
assert.equal(child.field.value, 'synthetic-replacement');
console.log('same-origin frame snapshots and exact protected entry checks passed');

// Chrome's AX list is not in page order: the snapshot walks childIds from the
// root, and a same-origin frame's nodes sit under the iframe that holds them.
{
  const node = (nodeId, backendDOMNodeId, role, name, parentId, childIds = []) => ({
    ...ax(nodeId, backendDOMNodeId, role, name), parentId, childIds,
  });
  const orderTree = frame('page');
  orderTree.childFrames = [frame('inner')];
  const orderTrees = {
    page: [
      node('5', 15, 'option', 'Annual', '3'),
      node('1', 11, 'RootWebArea', 'Page', undefined, ['2', '6', '7']),
      node('4', 14, 'option', 'Monthly', '3'),
      { ...node('7', 17, 'link', 'Last', '1'), properties: [{ name: 'url', value: { type: 'string', value: 'https://example.test/last?a=1' } }] },
      node('3', 13, 'combobox', 'Plan', '2', ['4', '5']),
      node('2', 12, 'main', 'Main', '1', ['3']),
      node('6', 16, 'Iframe', 'Inner', '1'),
    ],
    inner: [node('2', 22, 'button', 'Inside', '1'), node('1', 21, 'RootWebArea', 'Inner doc', undefined, ['2'])],
  };
  const orderContext = vm.createContext({
    MAX_SNAPSHOT_LINES: 100, isSensitiveInputNode, redactSensitiveAccessibleName,
    pageLines: async () => 'Tab ID: 8',
    callOnElement: async () => true,
    cdp: async (_tab, method, args) => {
      if (method === 'Page.getFrameTree') return { frameTree: orderTree };
      if (method === 'DOM.getFrameOwner') return { backendNodeId: 16 };
      if (method === 'Accessibility.getFullAXTree') return { nodes: orderTrees[args.frameId] };
      if (method === 'DOM.describeNode') return { node: { attributes: [] } };
      throw new Error(`unexpected ${method}`);
    },
  });
  vm.runInContext(source.slice(source.indexOf('const snapshots ='), source.indexOf('async function elementCenter')), orderContext);
  const aria = await vm.runInContext("takeSnapshotFor(8, {format: 'aria'})", orderContext);
  assert.equal(aria.split('\n').slice(3).join('\n'), [
    'RootWebArea "Page" [uid=@e1]',
    '  main "Main" [uid=@e2]',
    '    combobox "Plan" [uid=@e3]',
    '      option "Monthly" [uid=@e4]',
    '      option "Annual" [uid=@e5]',
    '  Iframe "Inner" [uid=@e6]',
    '    RootWebArea "Inner doc" [uid=@e7]',
    '      button "Inside" [uid=@e8]',
    '  link "Last" [uid=@e9]',
    '    /url: https://example.test/last?a=1',
  ].join('\n'));
  // A node whose parent is missing still appears, after the ordered ones.
  orderTrees.page.push(node('9', 19, 'button', 'Orphan', '42'));
  assert.match(await vm.runInContext("takeSnapshotFor(8, {format: 'aria'})", orderContext), /link "Last" \[uid=@e9\]\n    \/url: https:\/\/example\.test\/last\?a=1\nbutton "Orphan" \[uid=@e10\]$/);
  // Only an http(s) link address is shown, and only in the aria format.
  orderTrees.page.push({ ...node('10', 20, 'link', 'Script', '42'), properties: [{ name: 'url', value: { type: 'string', value: 'javascript:void(0)' } }] });
  assert.doesNotMatch(await vm.runInContext("takeSnapshotFor(8, {format: 'aria'})", orderContext), /javascript:/);
  assert.doesNotMatch(await vm.runInContext("takeSnapshotFor(8, {format: 'markdown'})", orderContext), /\/url:/);
  assert.doesNotMatch(await vm.runInContext("takeSnapshotFor(8, {format: 'accessibility_tree'})", orderContext), /\/url:/);
}

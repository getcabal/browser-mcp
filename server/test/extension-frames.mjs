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

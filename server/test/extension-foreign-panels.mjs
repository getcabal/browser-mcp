// Another extension's in-page panel (1Password's passkey offers, save-login
// prompts and suggestion lists) makes Chrome refuse chrome.debugger.attach for
// the whole tab. The extension closes a blocking 1Password panel itself, never
// on a required Google passkey prompt and never another extension's frame,
// and a failed page-state snapshot never turns a completed action into an
// error.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../extension/background.js', import.meta.url), 'utf8');
const slice = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `background.js no longer contains ${from} … ${to}`);
  return source.slice(start, end);
};
const attachSource = slice('const attached = new Set();', 'async function cdp(');
const noteSource = slice('const snapshots = new Map();', 'const INTERACTIVE_ROLES');
const pageStateSource = slice('async function appendRequestedPageState', 'function normalizeUid');
const injectedSource = slice('function removeForeignExtensionFrames', 'async function closeForeignExtensionPanels');

const OWN_ID = 'ownextensionaaaaaaaaaaaaaaaaaaaa';
const ONEPASSWORD = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';
const OTHER = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const BLOCKED = 'Cannot access a chrome-extension:// URL of different extension';
const plain = (value) => JSON.parse(JSON.stringify(value));

// --- A small DOM: just what the injected function touches --------------------

class FakeElement {
  constructor(localName, attrs = {}, children = []) {
    this.localName = localName;
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    this.shadow = null;
    this.shadowMode = null;
    this.contentDocument = null;
    for (const child of children) this.append(child);
  }
  append(child) { child.parent = this; this.children.push(child); return child; }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  get src() { return this.attrs.src ?? ''; }
  get data() { return this.attrs.data ?? ''; }
  get shadowRoot() { return this.shadowMode === 'open' ? this.shadow : null; }
  attach(mode, children) { this.shadowMode = mode; this.shadow = new FakeShadowRoot(this, children); return this; }
  getRootNode() { let node = this; while (node.parent) node = node.parent; return node; }
  get isConnected() {
    let root = this.getRootNode();
    while (root instanceof FakeShadowRoot) root = root.host.getRootNode();
    return root instanceof FakeDocument;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

const matches = (element, selector) => selector.split(',').map((part) => part.trim()).some((part) => {
  if (part === '*') return true;
  if (part === '[contenteditable]') return element.getAttribute('contenteditable') !== null;
  const attribute = part.match(/^([a-z]+)\[([a-z-]+)\]$/);
  if (attribute) return element.localName === attribute[1] && element.getAttribute(attribute[2]) !== null;
  return element.localName === part;
});

class FakeTree {
  constructor(children = []) {
    this.children = [];
    this.parent = null;
    for (const child of children) this.append(child);
  }
  append(child) { child.parent = this; this.children.push(child); return child; }
  descendants() {
    const out = [];
    const walk = (node) => { for (const child of node.children) { out.push(child); walk(child); } };
    walk(this);
    return out;
  }
  querySelectorAll(selector) { return this.descendants().filter((element) => matches(element, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

class FakeShadowRoot extends FakeTree {
  constructor(host, children) { super(children); this.host = host; }
}

class FakeDocument extends FakeTree {
  constructor(body = [], baseURI = 'https://accounts.google.com/v3/signin/identifier') {
    const bodyElement = new FakeElement('body', {}, body);
    const html = new FakeElement('html', {}, [new FakeElement('head'), bodyElement]);
    super([html]);
    this.documentElement = html;
    this.body = bodyElement;
    this.baseURI = baseURI;
  }
}
for (const method of ['descendants', 'querySelectorAll', 'querySelector']) {
  FakeElement.prototype[method] = FakeTree.prototype[method];
}

const el = (name, attrs, children) => new FakeElement(name, attrs, children);
const extensionFrame = (id, path = 'inline/menu.html') => el('iframe', { src: `chrome-extension://${id}/${path}` });
const loginForm = () => el('form', {}, [el('input', { type: 'email' }), el('button', {}, [])]);
const onePasswordMenu = (mode = 'closed') => el('com-1password-menu').attach(mode, [el('div', {}, [extensionFrame(ONEPASSWORD)])]);

function connectedForeignFrames(document) {
  const out = [];
  const visit = (tree) => {
    for (const element of tree.descendants()) {
      if (/^chrome-extension:\/\//.test(element.src || element.data || '') && !element.src.includes(OWN_ID)) {
        if (element.isConnected) out.push(element);
      }
      if (element.shadow) visit(element.shadow);
      if (element.contentDocument) visit(element.contentDocument);
    }
  };
  visit(document);
  return out;
}

// Each injection evaluates the serialized function in a fresh page context, as
// chrome.scripting does, so a dependency on the worker's scope fails here.
function runInjected(func, args, document, { closedRoots = true } = {}) {
  const page = vm.createContext({
    document,
    URL,
    chrome: closedRoots ? { dom: { openOrClosedShadowRoot: (element) => element.shadow } } : {},
  });
  return plain(vm.runInContext(`(${func.toString()})`, page)(...args));
}

// --- The worker side ---------------------------------------------------------

function worker({ url = 'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn', pendingUrl, document, attachImpl, executeImpl } = {}) {
  const calls = { attach: 0, execute: [], sleeps: [] };
  const tab = { id: 7, url, pendingUrl };
  const chrome = {
    runtime: { id: OWN_ID },
    debugger: {
      attach: async (target, version) => {
        assert.deepEqual(plain(target), { tabId: 7 });
        assert.equal(version, '1.3');
        calls.attach += 1;
        if (attachImpl) return attachImpl(calls.attach);
        if (connectedForeignFrames(document).length) throw new Error(BLOCKED);
        return undefined;
      },
    },
    tabs: { get: async (tabId) => { assert.equal(tabId, 7); return tab; } },
    scripting: {
      executeScript: async (injection) => {
        calls.execute.push(plain({ target: injection.target, world: injection.world, args: injection.args }));
        if (executeImpl) return executeImpl(injection, calls.execute.length);
        return [{ frameId: 0, result: runInjected(injection.func, injection.args, document) }];
      },
    },
  };
  const context = vm.createContext({
    chrome,
    CDP_VERSION: '1.3',
    URL,
    setTimeout: (callback, ms) => { calls.sleeps.push(ms); return setImmediate(callback); },
  });
  vm.runInContext(`${attachSource}\n${noteSource}`, context);
  return {
    calls,
    tab,
    attach: () => vm.runInContext('attach(7)', context),
    attached: () => vm.runInContext('attached.has(7)', context),
    note: () => vm.runInContext('takeForeignPanelNote(7)', context),
    run: (code) => vm.runInContext(code, context),
  };
}

// 1. A 1Password panel blocks the attach: the connector closes it, attaches,
//    and the next snapshot says so once. The page's own form stays.
{
  const form = loginForm();
  const menu = onePasswordMenu();
  const document = new FakeDocument([form, menu]);
  const w = worker({ document });
  await w.attach();
  assert.equal(w.attached(), true);
  assert.equal(w.calls.attach, 2);
  assert.deepEqual(w.calls.execute, [{
    target: { tabId: 7, allFrames: true }, world: 'ISOLATED', args: [OWN_ID, [ONEPASSWORD]],
  }]);
  assert.equal(menu.isConnected, false, "1Password's wrapper element is removed");
  assert.equal(form.isConnected, true, 'the page keeps its own form');
  assert.deepEqual(w.calls.sleeps, [150]);
  assert.equal(w.note(), "\nClosed 1Password's panel on this tab to restore page control; no settings changed.");
  assert.equal(w.note(), '', 'the note is reported once');
}

// 2. A required Google passkey or security-key prompt is never closed.
for (const page of [
  { url: 'https://accounts.google.com/v3/signin/challenge/pk?TL=abc&flowName=GlifWebSignIn' },
  { url: 'https://accounts.google.com/signin/v2/challenge/sk' },
  { url: 'about:blank', pendingUrl: 'https://accounts.google.com/v3/signin/challenge/pk/' },
]) {
  const menu = onePasswordMenu();
  const document = new FakeDocument([loginForm(), menu]);
  const w = worker({ ...page, document });
  await assert.rejects(w.attach(), (error) => {
    assert.match(error.message, /^Cannot access a chrome-extension:\/\/ URL of different extension: /);
    assert.match(error.message, /left open because this page is asking for a passkey/);
    assert.match(error.message, /This is not a connector failure/);
    assert.match(error.message, /Computer Use/);
    assert.match(error.message, /google-passkey-authentication\.md/);
    assert.match(error.message, /then call take_snapshot again/);
    return true;
  });
  assert.equal(w.calls.execute.length, 0, 'nothing is injected on a passkey prompt');
  assert.equal(menu.isConnected, true, 'the passkey prompt stays');
  assert.equal(w.attached(), false);
  assert.equal(w.note(), '');
}

// The passkey test is exact: other Google sign-in steps and look-alikes are not passkey prompts.
{
  const w = worker({ document: new FakeDocument() });
  const passkey = (url) => w.run(`isRequiredPasskeyPage(${JSON.stringify(url)})`);
  assert.equal(passkey('https://accounts.google.com/v3/signin/challenge/pk'), true);
  assert.equal(passkey('https://accounts.google.com/v3/signin/challenge/sk/'), true);
  for (const url of [
    'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn',
    'https://accounts.google.com/v3/signin/challenge/pwd',
    'https://accounts.google.com/v3/signin/challenge/pkx',
    'https://accounts.google.com/AddSession?continue=https://myaccount.google.com/',
    'http://accounts.google.com/v3/signin/challenge/pk',
    'https://accounts.google.com.example.test/v3/signin/challenge/pk',
    'https://example.test/accounts.google.com/v3/signin/challenge/pk',
    'not a url',
    '',
  ]) assert.equal(passkey(url), false, url);
}

// 3. A panel that keeps coming back ends in the typed error after three closes,
//    and no note is left behind for a later snapshot.
{
  const w = worker({
    document: new FakeDocument(),
    attachImpl: () => { throw new Error(BLOCKED); },
    executeImpl: () => [{ frameId: 0, result: { removed: 1, ids: [ONEPASSWORD], kept: [] } }],
  });
  await assert.rejects(w.attach(), /came back after 3 automatic attempts to close it\. This is not a connector failure/);
  assert.equal(w.calls.execute.length, 3);
  assert.equal(w.calls.attach, 4);
  assert.deepEqual(w.calls.sleeps, [150, 400, 900]);
  assert.equal(w.attached(), false);
  assert.equal(w.note(), '');
}

// 4. Another extension's frame is left alone and reported at once.
{
  const other = el('other-widget').attach('closed', [extensionFrame(OTHER, 'overlay.html')]);
  const document = new FakeDocument([loginForm(), other]);
  const w = worker({ document });
  await assert.rejects(w.attach(), /belongs to an extension the connector does not close by itself/);
  assert.equal(other.isConnected, true);
  assert.equal(w.calls.execute.length, 1);
  assert.equal(w.note(), '');
}

// 5. The connector's own frames are never removed; a block it cannot find ends
//    in the typed error after the retry budget.
{
  const own = el('iframe', { src: `chrome-extension://${OWN_ID}/options.html` });
  const document = new FakeDocument([own]);
  const w = worker({ document, attachImpl: () => { throw new Error(BLOCKED); } });
  await assert.rejects(w.attach(), /found no panel it may close/);
  assert.equal(own.isConnected, true);
  assert.equal(w.calls.execute.length, 3);
}

// 6. Other attach failures are unchanged: rethrown as they are, nothing injected.
{
  const w = worker({ document: new FakeDocument(), attachImpl: () => { throw new Error('Cannot access a chrome:// URL'); } });
  await assert.rejects(w.attach(), /^Error: Cannot access a chrome:\/\/ URL$/);
  assert.equal(w.calls.execute.length, 0);
}
{
  const w = worker({ document: new FakeDocument(), attachImpl: () => { throw new Error('Another debugger is already attached to the tab with id: 7.'); } });
  await w.attach();
  assert.equal(w.attached(), true);
  assert.equal(w.calls.execute.length, 0);
}

// 7. If injecting into every frame fails, the top frame alone is tried; if that
//    fails too, the agent gets the typed error instead of a script error.
{
  const menu = onePasswordMenu();
  const document = new FakeDocument([menu]);
  const w = worker({
    document,
    executeImpl: (injection, call) => {
      if (call === 1) throw new Error('Cannot access contents of the page');
      return [{ frameId: 0, result: runInjected(injection.func, injection.args, document) }];
    },
  });
  await w.attach();
  assert.deepEqual(w.calls.execute.map((call) => call.target), [{ tabId: 7, allFrames: true }, { tabId: 7, frameIds: [0] }]);
  assert.equal(menu.isConnected, false);
}
{
  const w = worker({
    document: new FakeDocument([onePasswordMenu()]),
    executeImpl: () => { throw new Error('Cannot access contents of the page'); },
  });
  await assert.rejects(w.attach(), /could not close it automatically\. This is not a connector failure/);
}

// --- The injected function on its own ---------------------------------------

const injected = vm.runInContext(`(${injectedSource})`, vm.createContext({}));
const close = (document, options) => runInjected(injected, [OWN_ID, [ONEPASSWORD]], document, options);

// A frame placed straight into the page: only the frame goes, never <body>.
{
  const frame = extensionFrame(ONEPASSWORD, 'notification.html');
  const document = new FakeDocument([loginForm(), frame]);
  assert.deepEqual(close(document), { removed: 1, ids: [ONEPASSWORD], kept: [] });
  assert.equal(frame.isConnected, false);
  assert.equal(document.body.isConnected, true);
}
// An open shadow root is found without chrome.dom; a closed one needs it.
{
  const menu = onePasswordMenu('open');
  assert.deepEqual(close(new FakeDocument([menu]), { closedRoots: false }), { removed: 1, ids: [ONEPASSWORD], kept: [] });
  assert.equal(menu.isConnected, false);
  const hidden = onePasswordMenu('closed');
  assert.deepEqual(close(new FakeDocument([hidden]), { closedRoots: false }), { removed: 0, ids: [], kept: [] });
  assert.equal(hidden.isConnected, true);
}
// A wrapper that also holds interactive content, or is not a custom element,
// keeps everything but the frame itself.
{
  const frame = extensionFrame(ONEPASSWORD);
  const widget = el('page-widget').attach('open', [el('button'), frame]);
  const plainHost = el('div').attach('open', [extensionFrame(ONEPASSWORD)]);
  const document = new FakeDocument([widget, plainHost]);
  assert.deepEqual(close(document), { removed: 2, ids: [ONEPASSWORD], kept: [] });
  assert.equal(frame.isConnected, false);
  assert.equal(widget.isConnected, true);
  assert.equal(plainHost.isConnected, true);
}
// Same-origin child documents, <embed> and <object> are covered; web pages,
// the connector's own frames and other extensions' frames stay.
{
  const inner = new FakeDocument([el('embed', { src: `chrome-extension://${ONEPASSWORD}/a.html` })], 'https://login.example.test/frame');
  const child = el('iframe', { src: 'https://login.example.test/frame' });
  child.contentDocument = inner;
  const object = el('object', { data: `chrome-extension://${ONEPASSWORD}/b.html` });
  const web = el('iframe', { src: 'https://ads.example.test/' });
  const own = el('iframe', { src: `chrome-extension://${OWN_ID}/popup.html` });
  const other = extensionFrame(OTHER);
  const relative = el('iframe', { src: '/help' });
  const document = new FakeDocument([child, object, web, own, other, relative]);
  assert.deepEqual(close(document), { removed: 2, ids: [ONEPASSWORD], kept: [OTHER] });
  assert.equal(inner.descendants().some((element) => element.localName === 'embed'), false);
  assert.equal(object.isConnected, false);
  for (const element of [child, web, own, other, relative]) assert.equal(element.isConnected, true);
}

// --- A failed page-state snapshot keeps the action's result --------------------

{
  const context = vm.createContext({
    toResult: (value) => (value && Array.isArray(value.content) ? value : { content: [{ type: 'text', text: String(value) }] }),
    pageStateTarget: async () => 7,
    takeSnapshotFor: async () => { throw new Error(`${BLOCKED}: another extension's panel is open in tab 7`); },
  });
  vm.runInContext(pageStateSource, context);
  const result = plain(await vm.runInContext(
    `appendRequestedPageState('navigate_page', { pageStateFormat: 'markdown' }, 'Navigated to https://accounts.google.com/')`,
    context,
  ));
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content, [
    { type: 'text', text: 'Navigated to https://accounts.google.com/' },
    { type: 'text', text: `Page state (markdown) for tab 7 is unavailable: ${BLOCKED}: another extension's panel is open in tab 7` },
  ]);
  context.takeSnapshotFor = async () => 'Tab ID: 7\nFormat: markdown';
  const ok = plain(await vm.runInContext(`appendRequestedPageState('click', { pageStateFormat: 'markdown' }, 'Clicked')`, context));
  assert.deepEqual(ok.content.map((block) => block.text), ['Clicked', 'Page state (markdown) for tab 7:\nTab ID: 7\nFormat: markdown']);
  assert.equal(await vm.runInContext(`appendRequestedPageState('click', {}, 'Clicked')`, context), 'Clicked', 'no format: result untouched');
  await assert.rejects(
    vm.runInContext(`appendRequestedPageState('click', { pageStateFormat: 'html' }, 'Clicked')`, context),
    /pageStateFormat must be/,
  );
}

console.log('extension-foreign-panels: ok');

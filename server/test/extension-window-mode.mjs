// Window mode in the extension: each new page gets its own unfocused window,
// switching never raises a window, nothing falls back to another job's active
// page, focus emulation is turned on once per attached page, and every
// existing parser of the page list and the new-page reply keeps working.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const plain = (value) => JSON.parse(JSON.stringify(value));

const source = await readFile(new URL('../../extension/background.js', import.meta.url), 'utf8');
const slice = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `background.js no longer contains ${from} … ${to}`);
  return source.slice(start, end);
};

const windowHelpers = slice('// Window mode: open a page in a window of its own', 'async function pageLines(');
const pageStateSource = slice('async function pageStateTarget', 'async function appendRequestedPageState');
const cdpSource = slice('async function cdp(', 'function describeException(');
const listPagesSource = slice('  async list_pages() {', '  async new_page(args) {');
const newPageSource = slice('  async new_page(args) {', '  async close_page(args) {');
const switchSource = slice('  async switch_to_page(args) {', '  async take_snapshot(args) {');

// Static wiring that the slices cannot show.
assert.match(source, /capabilities: \[WINDOW_ISOLATION_CAPABILITY\]/, 'the hello advertises window mode');
assert.match(source, /const WINDOW_ISOLATION_CAPABILITY = 'page-isolation-window';/);
assert.match(source, /pageIsolation = message\.options\?\.pageIsolation === 'window' \? 'window' : 'none';/,
  'each call sets the mode from its options, so a call without options is the default mode');
assert.ok(source.indexOf("pageIsolation = message.options") < source.indexOf('const executor = executors[name];'),
  'the mode is set before the executor runs');

function fakeChrome({ windows = [], created = { id: 77, tabs: [{ id: 501, windowId: 77 }] }, queryTabs = [] } = {}) {
  const log = [];
  const chrome = {
    windows: {
      async getAll(filter) { log.push(['windows.getAll', filter]); return structuredClone(windows); },
      async create(spec) { log.push(['windows.create', spec]); return structuredClone(created); },
      async update(id, spec) { log.push(['windows.update', id, spec]); return { id }; },
    },
    tabs: {
      async create(spec) { log.push(['tabs.create', spec]); return { id: 600, windowId: 1 }; },
      async get(id) { log.push(['tabs.get', id]); return { id, windowId: 3 }; },
      async update(id, spec) { log.push(['tabs.update', id, spec]); return { id, windowId: 3 }; },
      async query(filter) { log.push(['tabs.query', filter]); return structuredClone(queryTabs); },
    },
    debugger: {
      async sendCommand(target, method, params) { log.push(['debugger.sendCommand', target.tabId, method, params]); return {}; },
    },
  };
  return { chrome, log };
}

function load(mode, chromeOptions) {
  const { chrome, log } = fakeChrome(chromeOptions);
  const context = vm.createContext({
    chrome,
    pageIsolation: mode,
    WINDOW_CASCADE_PX: 32,
    WINDOW_CASCADE_STEPS: 8,
    attached: new Set(),
    focusEmulated: new Set(),
    attach: async (tabId) => { log.push(['attach', tabId]); context.attached.add(tabId); },
    sleep: async () => {},
    redactSensitiveUrl: (url) => url,
    allowedUrl: (url) => url,
    waitForReady: async () => '',
    pollVisibility: async () => true,
    requirePageId: (args) => args.pageId,
    activeTabId: async () => 99,
    pageLines: async (tabId) => `Tab ID: ${tabId}\nTitle: \nURL: https://example.com/`,
  });
  vm.runInContext(`${windowHelpers}\n${pageStateSource}\n${cdpSource}\n`
    + `var executors = {\n${listPagesSource}\n${newPageSource}\n${switchSource}\n};`, context);
  return { context, log, calls: (name) => log.filter((entry) => entry[0] === name) };
}

// --- openPageInOwnWindow: unfocused, normal, cascaded from the oldest window ---
{
  // Listed out of order and with a newer window focused: the oldest is the reference.
  const windows = [
    { id: 9, focused: true, state: 'normal', left: 700, top: 600, width: 900, height: 700 },
    { id: 2, focused: false, state: 'normal', left: 0, top: 39, width: 2056, height: 1231 },
    { id: 5, focused: false, state: 'normal', left: 32, top: 71, width: 2056, height: 1231 },
  ];
  const { context, calls } = load('window', { windows });
  const { tab, windowId } = await context.openPageInOwnWindow('https://example.com/a');
  assert.equal(tab.id, 501);
  assert.equal(windowId, 77);
  assert.deepEqual(plain(calls('windows.getAll')[0][1]), { windowTypes: ['normal'] });
  assert.deepEqual(plain(calls('windows.create')[0][1]), {
    url: 'https://example.com/a', focused: false, type: 'normal',
    left: 0 + 32 * 3, top: 39 + 32 * 3, width: 2056, height: 1231,
  });
}
{
  // The cascade never drifts: with only the startup window open the first job
  // window sits one step away, and it cycles back after eight steps.
  for (const [count, step] of [[1, 1], [8, 8], [9, 1], [10, 2]]) {
    const windows = Array.from({ length: count }, (_, i) => ({ id: 10 + i, focused: false, state: 'normal', left: 5 * i, top: 5 * i, width: 800, height: 600 }));
    const { context, calls } = load('window', { windows });
    await context.openPageInOwnWindow('https://example.com/c');
    const created = plain(calls('windows.create')[0][1]);
    assert.deepEqual([created.left, created.top], [32 * step, 32 * step], `${count} open windows`);
  }
}
{
  // A maximized or full-screen oldest window: let Chrome place the new one.
  const { context, calls } = load('window', { windows: [{ id: 2, focused: true, state: 'maximized', left: 0, top: 0, width: 1728, height: 1080 }] });
  await context.openPageInOwnWindow('https://example.com/b');
  assert.deepEqual(plain(calls('windows.create')[0][1]), { url: 'https://example.com/b', focused: false, type: 'normal' });
}
{
  // Chrome reports the window without its tabs: read them from the window.
  const { context, calls } = load('window', { created: { id: 80 }, queryTabs: [{ id: 702, windowId: 80 }] });
  const { tab } = await context.openPageInOwnWindow('about:blank');
  assert.equal(tab.id, 702);
  assert.deepEqual(plain(calls('tabs.query')[0][1]), { windowId: 80 });
}
{
  const { context } = load('window', { created: { id: 81 }, queryTabs: [] });
  await assert.rejects(context.openPageInOwnWindow('about:blank'), /did not report the page in the new window/);
}

// --- activateWithoutRaising never touches window focus -------------------------
{
  const { context, calls } = load('window');
  await context.activateWithoutRaising(501);
  assert.deepEqual(plain(calls('tabs.update')[0].slice(1)), [501, { active: true }]);
  assert.equal(calls('windows.update').length, 0);
}

// --- new_page ------------------------------------------------------------------
{
  const { context, calls } = load('window', { windows: [] });
  const text = await context.executors.new_page({ url: 'https://example.com/', focus: true });
  assert.match(text, /^Opened new page in its own window 77, not brought to the front\n/);
  assert.equal([...text.matchAll(/^Tab ID: ([1-9]\d*)\r?$/gm)].length, 1, 'exactly one Tab ID line for the workflow runtime');
  assert.match(text, /^Tab ID: 501$/m);
  assert.equal(calls('tabs.create').length, 0, 'window mode never opens a shared tab');
  assert.equal(calls('windows.create')[0][1].focused, false, 'focus: true is ignored');
  assert.equal(calls('windows.update').length, 0);
}
{
  const { context, calls } = load('none');
  const text = await context.executors.new_page({ url: 'https://example.com/' });
  assert.match(text, /^Opened new background page\n/);
  assert.deepEqual(plain(calls('tabs.create')[0][1]), { url: 'https://example.com/', active: false });
  assert.equal(calls('windows.create').length, 0, 'the default mode is unchanged');
}

// --- switch_to_page --------------------------------------------------------------
{
  const { context, calls } = load('window');
  const text = await context.executors.switch_to_page({ pageId: 501 });
  assert.equal(text.split('\n')[0], 'Switched to page 501', 'the workflow runtime receipt line is unchanged');
  assert.equal(calls('windows.update').length, 0, 'window mode never raises a window');
  assert.deepEqual(plain(calls('tabs.update')[0].slice(1)), [501, { active: true }]);
}
{
  const { context, calls } = load('none');
  const text = await context.executors.switch_to_page({ pageId: 501 });
  assert.equal(text.split('\n')[0], 'Switched to page 501');
  assert.equal(calls('windows.update').length, 2, 'the default mode still brings the page forward');
}

// --- list_pages: window ids without breaking existing parsers ------------------------
const runtimePattern = /Page (\d+)[^\n]* - ([^\n]+)/g; // fleet_workflow browser.page_ids
const qboPattern = /^Page ([1-9][0-9]*)(?: \[ACTIVE\])?: .* - (https:\/\/[^\r\n ]+)$/gm; // private-qbo-login
const pages = [
  { id: 12, active: true, windowId: 5, title: 'Ads - Overview', url: 'https://ads.google.com/aw/overview' },
  { id: 13, active: false, windowId: 6, title: '', url: 'https://example.com/b' },
];
{
  const { context } = load('window', { queryTabs: pages });
  const text = await context.executors.list_pages();
  assert.match(text, /^Page 12 \[ACTIVE\]: "Ads - Overview" \[window 5\] - https:\/\/ads\.google\.com\/aw\/overview$/m);
  assert.deepEqual([...text.matchAll(runtimePattern)].map((m) => [m[1], m[2]]),
    [['12', 'https://ads.google.com/aw/overview'], ['13', 'https://example.com/b']]);
  assert.deepEqual([...text.matchAll(qboPattern)].map((m) => [m[1], m[2]]),
    [['12', 'https://ads.google.com/aw/overview'], ['13', 'https://example.com/b']]);
}
{
  const { context } = load('none', { queryTabs: pages });
  const text = await context.executors.list_pages();
  assert.match(text, /^Page 12 \[ACTIVE\]: "Ads - Overview" - https:\/\/ads\.google\.com\/aw\/overview$/m);
  assert.doesNotMatch(text, /\[window /, 'the default page list is unchanged');
}

// --- page state never borrows another job's active page in window mode ---------------
{
  const { context } = load('window');
  await assert.rejects(context.pageStateTarget('close_page', { pageId: 12 }, 'Closed page 12'), /not reported after closing/);
  await assert.rejects(context.pageStateTarget('list_pages', {}, 'Found 0 page(s):'), /named no page/);
  assert.equal(await context.pageStateTarget('click', { tabId: 12 }, 'ok'), 12);
  assert.equal(await context.pageStateTarget('new_page', {}, 'Opened…\nTab ID: 501\n'), 501);
}
{
  const { context } = load('none');
  assert.equal(await context.pageStateTarget('close_page', { pageId: 12 }, 'Closed page 12'), 99);
  assert.equal(await context.pageStateTarget('list_pages', {}, ''), 99);
}

// --- focus emulation: once per attached page, window mode only -------------------------
{
  const { context, log } = load('window');
  await context.cdp(501, 'Runtime.evaluate', { expression: '1' });
  await context.cdp(501, 'Runtime.evaluate', { expression: '2' });
  const sent = log.filter((entry) => entry[0] === 'debugger.sendCommand').map((entry) => entry[2]);
  assert.deepEqual(sent, ['Emulation.setFocusEmulationEnabled', 'Runtime.evaluate', 'Runtime.evaluate']);
  assert.deepEqual(plain(log.find((entry) => entry[2] === 'Emulation.setFocusEmulationEnabled')[3]), { enabled: true });
}
{
  const { context, log } = load('none');
  await context.cdp(502, 'Runtime.evaluate', { expression: '1' });
  const sent = log.filter((entry) => entry[0] === 'debugger.sendCommand').map((entry) => entry[2]);
  assert.deepEqual(sent, ['Runtime.evaluate'], 'the default mode never emulates focus');
}

console.log('extension window mode ok: own unfocused windows, no raising, no active-page fallback, parsers intact');

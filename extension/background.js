/**
 * Local browser MCP extension service worker.
 *
 * Connects to the local MCP server's loopback WebSocket bridge, advertises the
 * reviewed tool contract (extension/tools.js), and executes tool calls with
 * chrome.tabs / chrome.windows / chrome.debugger (CDP 1.3).
 *
 * Connection endpoint and profile identity come from config.js. Fleet builds
 * are stamped with locked=true and cannot be retargeted through extension
 * storage or the options page. Development builds may opt into local overrides.
 * Handshake mismatches fail closed with 4400/4403/4426.
 */

import DEFAULT_CONFIG from './config.js';
import { PROTOCOL_VERSION, TOOLS } from './tools.js';

const HEARTBEAT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const PROGRESS_INTERVAL_MS = 15_000;
const DEFAULT_TOOL_TIMEOUT_MS = 90_000;
const MAX_WAIT_MS = 300_000;
const CDP_VERSION = '1.3';
const COMPLETED_CAP = 1000;
const MAX_SNAPSHOT_LINES = 800;
const FATAL_CLOSE_CODES = new Set([4400, 4403, 4426]);

const log = (...args) => console.log('[local-mcp]', ...args);

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

let socket = null;
let socketGeneration = 0;
let reconnectDelayMs = 1000;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastFrameAt = 0;
let handshakeState = 'idle'; // idle | hello_sent | established
let activeConfig = {
  port: DEFAULT_CONFIG.port,
  profile: DEFAULT_CONFIG.profile ?? null,
  locked: DEFAULT_CONFIG.locked === true,
};
let fatalMemory = null;

async function resolveConfig() {
  let port = DEFAULT_CONFIG.port;
  let profile = DEFAULT_CONFIG.profile ?? null;
  const locked = DEFAULT_CONFIG.locked === true;
  if (locked) return { port, profile, locked };
  try {
    const stored = await chrome.storage.local.get(['port', 'profile']);
    if (Number.isInteger(stored.port) && stored.port >= 1024 && stored.port <= 65535) port = stored.port;
    if (typeof stored.profile === 'string' && stored.profile.trim()) profile = stored.profile.trim();
  } catch {
    // storage unavailable; keep stamped defaults
  }
  return { port, profile, locked };
}

async function getFatal() {
  try {
    const { fatalHandshake } = await chrome.storage.session.get('fatalHandshake');
    return fatalHandshake || null;
  } catch {
    return fatalMemory;
  }
}

async function setFatal(info) {
  fatalMemory = info;
  try { await chrome.storage.session.set({ fatalHandshake: info }); } catch { /* memory only */ }
  log('handshake failed closed:', info.code, info.reason);
}

async function clearFatal() {
  fatalMemory = null;
  try { await chrome.storage.session.remove('fatalHandshake'); } catch { /* memory only */ }
}

async function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (await getFatal()) return;
  activeConfig = await resolveConfig();
  const generation = ++socketGeneration;
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${activeConfig.port}`);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;
  handshakeState = 'idle';
  ws.onopen = () => {
    if (generation !== socketGeneration) return;
    reconnectDelayMs = 1000;
    sendHello();
    handshakeState = 'hello_sent';
    startHeartbeat();
  };
  ws.onmessage = (event) => {
    if (generation !== socketGeneration) return;
    void onSocketMessage(event.data);
  };
  ws.onclose = (event) => {
    if (generation !== socketGeneration) return;
    stopHeartbeat();
    socket = null;
    handshakeState = 'idle';
    void onSocketClosed(event);
  };
  ws.onerror = () => { /* onclose follows */ };
}

async function onSocketClosed(event) {
  if (FATAL_CLOSE_CODES.has(event.code)) {
    await setFatal({ code: event.code, reason: event.reason || 'Rejected by the local MCP server', at: Date.now() });
    return;
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_BACKOFF_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function teardownSocket() {
  socketGeneration += 1;
  stopHeartbeat();
  if (socket) {
    try { socket.close(1000); } catch { /* already closing */ }
    socket = null;
  }
  handshakeState = 'idle';
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify(payload)); } catch { /* dropped; server replays on reconnect */ }
  }
}

function sendHello() {
  send({
    type: 'connected',
    profile: activeConfig.profile ?? null,
    protocolVersion: PROTOCOL_VERSION,
    extensionVersion: chrome.runtime.getManifest().version,
  });
}

function startHeartbeat() {
  stopHeartbeat();
  lastFrameAt = Date.now();
  heartbeatTimer = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastFrameAt > HEARTBEAT_MS * 2 + 5_000) {
      log('no frames from server; reconnecting');
      try { socket.close(); } catch { /* triggers onclose */ }
      return;
    }
    sendHello();
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

async function onSocketMessage(raw) {
  lastFrameAt = Date.now();
  let message;
  try { message = JSON.parse(String(raw)); } catch { return; }
  switch (message.type) {
    case 'pong': await handlePong(message); break;
    case 'list_tools': send({ type: 'tools_list', tools: TOOLS }); break;
    case 'call_tool': void handleCall(message); break;
    default: break;
  }
}

const formatProfile = (profile) => (profile === null || profile === undefined ? '(none)' : JSON.stringify(profile));

async function handlePong(message) {
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    await failFatal(4426, `Server protocol ${message.protocolVersion ?? '(none)'} does not match extension protocol ${PROTOCOL_VERSION}`);
    return;
  }
  const expected = message.expectedProfile === undefined ? null : message.expectedProfile;
  const ours = activeConfig.profile ?? null;
  if (expected !== ours) {
    await failFatal(4403, `Server expects profile ${formatProfile(expected)} but this extension is configured as ${formatProfile(ours)}`);
    return;
  }
  handshakeState = 'established';
}

async function failFatal(code, reason) {
  await setFatal({ code, reason, at: Date.now() });
  teardownSocket();
}

// ---------------------------------------------------------------------------
// Tool call handling (at-most-once with replay support)
// ---------------------------------------------------------------------------

const completed = new Map(); // requestId -> response frame
const inFlight = new Map(); // requestId -> Promise

function toolTimeoutMs(name, args) {
  if (name.startsWith('wait_for')) return waitBudget(args) + 15_000;
  if (name === 'new_page' || name === 'navigate_page' || name === 'switch_to_page') {
    const fallback = name === 'switch_to_page' ? 15_000 : 45_000;
    const budget = typeof args.timeoutMs === 'number' && args.timeoutMs >= 0 ? args.timeoutMs : fallback;
    return budget + 30_000;
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

function waitBudget(args) {
  const requested = typeof args?.timeout === 'number' && args.timeout > 0 ? args.timeout : 30_000;
  return Math.min(requested, MAX_WAIT_MS);
}

function boundedTimeout(args, fallback, maximum = MAX_WAIT_MS) {
  const requested = typeof args?.timeout === 'number' && Number.isFinite(args.timeout) ? args.timeout : fallback;
  return Math.max(1, Math.min(requested, maximum));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms in the extension`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function toResult(value) {
  if (value && typeof value === 'object' && Array.isArray(value.content)) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text: text ?? '' }] };
}

function remember(requestId, response) {
  completed.set(requestId, response);
  if (completed.size > COMPLETED_CAP) {
    const oldest = completed.keys().next().value;
    completed.delete(oldest);
  }
}

async function handleCall(message) {
  const { requestId, name } = message;
  if (typeof requestId !== 'string' || !requestId) return;
  if (completed.has(requestId)) { send(completed.get(requestId)); return; }
  if (inFlight.has(requestId)) return;
  const args = message.args && typeof message.args === 'object' ? message.args : {};
  const progressTimer = setInterval(() => {
    send({ type: 'tool_progress', requestId, message: `${name} still running` });
  }, PROGRESS_INTERVAL_MS);
  const work = (async () => {
    const executor = executors[name];
    if (!executor) throw new Error(`Unknown tool: ${name}`);
    return await withTimeout(executor(args), toolTimeoutMs(name, args), name);
  })();
  inFlight.set(requestId, work);
  let response;
  try {
    const value = await appendRequestedPageState(name, args, await work);
    response = { type: 'tool_result', requestId, result: toResult(value) };
  } catch (error) {
    response = {
      type: 'tool_result',
      requestId,
      result: { content: [{ type: 'text', text: `Error: ${String(error?.message || error)}` }], isError: true },
    };
  } finally {
    clearInterval(progressTimer);
    inFlight.delete(requestId);
  }
  remember(requestId, response);
  send(response);
}

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

const attached = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (error) {
    if (!/already attached/i.test(String(error?.message || error))) throw error;
  }
  attached.add(tabId);
}

async function cdp(tabId, method, params = {}) {
  if (!attached.has(tabId)) await attach(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (error) {
    if (/not attached|detached/i.test(String(error?.message || error))) {
      attached.delete(tabId);
      await sleep(75);
      await attach(tabId);
      return await chrome.debugger.sendCommand({ tabId }, method, params);
    }
    throw error;
  }
}

function describeException(exceptionDetails) {
  return exceptionDetails?.exception?.description
    || exceptionDetails?.exception?.value
    || exceptionDetails?.text
    || 'Script threw an exception';
}

async function callOnElement(tabId, backendNodeId, functionDeclaration, callArgs = []) {
  const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId });
  if (!object?.objectId) throw new Error('Could not resolve element to a page object');
  try {
    const result = await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration,
      arguments: callArgs.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(describeException(result.exceptionDetails));
    return result.result?.value;
  } finally {
    cdp(tabId, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => { /* released with target */ });
  }
}

async function evaluateInPage(tabId, expression, { awaitPromise = false } = {}) {
  const result = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (result.exceptionDetails) throw new Error(describeException(result.exceptionDetails));
  return result.result?.value;
}

// ---------------------------------------------------------------------------
// Tabs, URLs, readiness
// ---------------------------------------------------------------------------

function allowedUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('A URL is required');
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Invalid URL: ${text}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs are allowed, got ${url.protocol}`);
  }
  return url.toString();
}

async function activeTabId(args) {
  if (typeof args?.tabId === 'number') return args.tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) return tab.id;
  const [fallback] = await chrome.tabs.query({ active: true });
  if (fallback?.id !== undefined) return fallback.id;
  throw new Error('No active tab');
}

function requirePageId(args, toolName) {
  if (typeof args?.pageId !== 'number' || !Number.isFinite(args.pageId)) {
    throw new Error(`${toolName} requires pageId`);
  }
  return args.pageId;
}

function requireTabId(args, toolName) {
  if (typeof args?.tabId !== 'number' || !Number.isFinite(args.tabId)) {
    throw new Error(`${toolName} requires tabId`);
  }
  return args.tabId;
}

async function pageLines(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return `Tab ID: ${tab.id}\nTitle: ${tab.title || ''}\nURL: ${tab.url || tab.pendingUrl || ''}`;
  } catch {
    return `Tab ID: ${tabId}\nTitle: \nURL: `;
  }
}

/**
 * Bounded readiness: poll tab.status until 'complete'. A timeout degrades to
 * a warning, but a closed/replaced target fails instead of reporting success.
 */
async function waitForReady(tabId, timeoutMs = 15_000) {
  const budget = Math.max(0, typeof timeoutMs === 'number' ? timeoutMs : 15_000);
  const deadline = Date.now() + budget;
  await sleep(Math.min(150, budget));
  while (Date.now() < deadline) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); }
    catch { throw new Error(`Page ${tabId} closed while waiting for readiness`); }
    if (tab.status === 'complete') return '';
    await sleep(150);
  }
  const seconds = Math.round(budget / 1000);
  return ` (page did not reach readyState=complete within ${seconds}s; it may still be loading)`;
}

async function pollVisibility(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const visible = await evaluateInPage(tabId, "document.visibilityState === 'visible'");
      if (visible === true) return true;
    } catch {
      return true; // page not scriptable (chrome:// etc.); cannot verify, do not fail
    }
    await sleep(150);
  }
  return false;
}

async function pollUntil(probe, { timeoutMs, intervalMs = 250, describe }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const suffix = lastError ? ` (last error: ${String(lastError.message || lastError)})` : '';
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${describe}${suffix}`);
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Snapshots and uid resolution
// ---------------------------------------------------------------------------

const snapshots = new Map(); // tabId -> Map(uid -> { backendNodeId, role, name })
const snapshotHashes = new Map(); // `${tabId}:${format}` -> content hash

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
  'switch', 'slider', 'spinbutton', 'textfield', 'textfieldwithcombobox',
]);

const SKIPPED_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak']);

async function accessibilityNodes(tabId, { maxDepth, scopeSelector } = {}) {
  if (scopeSelector) {
    const { root } = await cdp(tabId, 'DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector: scopeSelector });
    if (!nodeId) throw new Error(`scopeSelector matched no element: ${scopeSelector}`);
    const { node } = await cdp(tabId, 'DOM.describeNode', { nodeId });
    return (await cdp(tabId, 'Accessibility.getPartialAXTree', {
      backendNodeId: node.backendNodeId,
      fetchRelatives: true,
    })).nodes || [];
  }
  const params = {};
  if (typeof maxDepth === 'number' && Number.isFinite(maxDepth) && maxDepth > 0) {
    params.depth = Math.floor(maxDepth);
  }
  return (await cdp(tabId, 'Accessibility.getFullAXTree', params)).nodes || [];
}

function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function takeSnapshotFor(tabId, options = {}) {
  const format = options.format || 'markdown';
  if (!['markdown', 'accessibility_tree', 'aria'].includes(format)) {
    throw new Error(`Unknown snapshot format: ${format}`);
  }
  const nodes = await accessibilityNodes(tabId, options);
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const depthFor = (node) => {
    let depth = 0;
    let cursor = node;
    const seen = new Set();
    while (cursor?.parentId && byId.has(cursor.parentId) && !seen.has(cursor.parentId)) {
      seen.add(cursor.parentId);
      cursor = byId.get(cursor.parentId);
      depth += 1;
    }
    return depth;
  };
  const refs = new Map();
  const lines = [];
  let counter = 0;
  let omitted = 0;
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value || '';
    const name = node.name?.value || '';
    if (!role || SKIPPED_ROLES.has(role)) continue;
    const interactive = INTERACTIVE_ROLES.has(role.toLowerCase());
    if (options.compact === true && !name && !interactive) continue;
    if (!name && !interactive && format === 'markdown') continue;
    if (typeof node.backendDOMNodeId !== 'number') continue;
    counter += 1;
    const uid = `@e${counter}`;
    refs.set(uid, { backendNodeId: node.backendDOMNodeId, role, name });
    if (lines.length < MAX_SNAPSHOT_LINES) {
      const depth = depthFor(node);
      if (format === 'markdown') lines.push(`${uid} [${role}] ${JSON.stringify(name)}`);
      else if (format === 'aria') lines.push(`${'  '.repeat(depth)}${role} ${JSON.stringify(name)} [uid=${uid}]`);
      else lines.push(`${'  '.repeat(depth)}${uid} role=${JSON.stringify(role)} name=${JSON.stringify(name)}`);
    } else {
      omitted += 1;
    }
  }
  snapshots.set(tabId, refs);
  if (omitted > 0) lines.push(`... (${omitted} more node(s) omitted; use compact/maxDepth/scopeSelector to narrow)`);
  const body = lines.join('\n');
  const hash = hashText(body);
  const hashKey = `${tabId}:${format}`;
  const previous = snapshotHashes.get(hashKey);
  snapshotHashes.set(hashKey, hash);
  const header = `${await pageLines(tabId)}\nFormat: ${format}\nPage changed: ${previous === undefined || previous !== hash}`;
  if (options.changedOnly === true && previous === hash) {
    return `${header}\nSnapshot unchanged (${hash})`;
  }
  return `${header}\n${body}`;
}

async function pageStateTarget(name, args, value) {
  if (name === 'close_page') return activeTabId({});
  if (typeof args.pageId === 'number') return args.pageId;
  if (typeof args.tabId === 'number') return args.tabId;
  if (name === 'new_page' && typeof value === 'string') {
    const match = value.match(/Tab ID: (\d+)/);
    if (match) return Number(match[1]);
  }
  return activeTabId({});
}

async function appendRequestedPageState(name, args, value) {
  const format = args?.pageStateFormat;
  if (format === undefined || format === null) return value;
  if (format !== 'markdown' && format !== 'accessibility_tree') {
    throw new Error('pageStateFormat must be "markdown" or "accessibility_tree"');
  }
  const tabId = await pageStateTarget(name, args, value);
  const state = await takeSnapshotFor(tabId, { format });
  const result = toResult(value);
  result.content.push({ type: 'text', text: `Page state (${format}) for tab ${tabId}:\n${state}` });
  return result;
}

function normalizeUid(raw) {
  const text = String(raw ?? '').trim();
  const stripped = text.startsWith('@') ? text.slice(1) : text;
  const normalized = /^\d+$/.test(stripped) ? `e${stripped}` : stripped;
  if (!/^e\d+$/.test(normalized)) throw new Error(`Invalid uid: ${text || '(empty)'}; expected an @eN uid or numeric index from take_snapshot`);
  return `@${normalized}`;
}

async function relocate(tabId, entry) {
  try {
    const { nodes } = await cdp(tabId, 'Accessibility.getFullAXTree', {});
    const matches = (nodes || []).filter((node) => !node.ignored
      && node.role?.value === entry.role
      && (node.name?.value || '') === entry.name
      && typeof node.backendDOMNodeId === 'number');
    if (matches.length === 1) return matches[0].backendDOMNodeId;
  } catch { /* fall through to stale */ }
  return null;
}

async function resolveUid(tabId, rawUid) {
  const uid = normalizeUid(rawUid);
  const refs = snapshots.get(tabId);
  if (!refs) throw new Error(`No snapshot for tab ${tabId}; call take_snapshot first`);
  const entry = refs.get(uid);
  if (!entry) throw new Error(`Unknown uid ${uid} for tab ${tabId}; call take_snapshot again`);
  try {
    await cdp(tabId, 'DOM.describeNode', { backendNodeId: entry.backendNodeId });
    return entry.backendNodeId;
  } catch {
    const relocated = await relocate(tabId, entry);
    if (relocated) {
      entry.backendNodeId = relocated;
      return relocated;
    }
    throw new Error(`Element ${uid} is stale; call take_snapshot again`);
  }
}

async function elementCenter(tabId, backendNodeId) {
  try { await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }); } catch { /* not scrollable */ }
  const { model } = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId });
  const quad = model.border;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

async function selectorBackendNodeId(tabId, selector) {
  const { root } = await cdp(tabId, 'DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`Selector matched no element: ${selector}`);
  const { node } = await cdp(tabId, 'DOM.describeNode', { nodeId });
  return node.backendNodeId;
}

async function pointForTarget(tabId, target, label) {
  if (target && typeof target === 'object') {
    const x = Number(target.x);
    const y = Number(target.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  if (typeof target === 'number' || /^(?:@?e)?\d+$/.test(String(target ?? '').trim())) {
    return elementCenter(tabId, await resolveUid(tabId, target));
  }
  if (typeof target === 'string' && target.trim()) {
    return elementCenter(tabId, await selectorBackendNodeId(tabId, target.trim()));
  }
  throw new Error(`${label} must be a selector, snapshot uid/index, or {x, y} coordinates`);
}

// ---------------------------------------------------------------------------
// Keyboard synthesis
// ---------------------------------------------------------------------------

const MODIFIER_BITS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

const NAMED_KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};
for (let f = 1; f <= 12; f += 1) NAMED_KEYS[`f${f}`] = { key: `F${f}`, code: `F${f}`, keyCode: 111 + f };

const PUNCT_KEYS = {
  ';': [186, 'Semicolon'], '=': [187, 'Equal'], ',': [188, 'Comma'], '-': [189, 'Minus'],
  '.': [190, 'Period'], '/': [191, 'Slash'], '`': [192, 'Backquote'], '[': [219, 'BracketLeft'],
  '\\': [220, 'Backslash'], ']': [221, 'BracketRight'], "'": [222, 'Quote'],
};

const SHIFTED_CHARS = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  ':': ';', '+': '=', '<': ',', '_': '-', '>': '.', '?': '/', '~': '`', '{': '[', '|': '\\', '}': ']', '"': "'",
};

function keyForChar(char) {
  if (/^[a-z]$/.test(char)) {
    return { key: char, code: `Key${char.toUpperCase()}`, keyCode: char.toUpperCase().charCodeAt(0), text: char, modifiers: 0 };
  }
  if (/^[A-Z]$/.test(char)) {
    return { key: char, code: `Key${char}`, keyCode: char.charCodeAt(0), text: char, modifiers: MODIFIER_BITS.shift };
  }
  if (/^[0-9]$/.test(char)) {
    return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: char, modifiers: 0 };
  }
  if (char === ' ') return { ...NAMED_KEYS.space, modifiers: 0 };
  const shiftBase = SHIFTED_CHARS[char];
  if (shiftBase !== undefined) {
    const [keyCode, code] = /^[0-9]$/.test(shiftBase)
      ? [shiftBase.charCodeAt(0), `Digit${shiftBase}`]
      : PUNCT_KEYS[shiftBase];
    return { key: char, code, keyCode, text: char, modifiers: MODIFIER_BITS.shift };
  }
  if (PUNCT_KEYS[char]) {
    const [keyCode, code] = PUNCT_KEYS[char];
    return { key: char, code, keyCode, text: char, modifiers: 0 };
  }
  // Anything else (unicode, emoji): deliver as text-only insertion.
  return { key: char, code: '', keyCode: 0, text: char, modifiers: 0 };
}

function lookupKey(token) {
  const named = NAMED_KEYS[token.toLowerCase()];
  if (named) return { ...named, modifiers: 0 };
  if (token.length === 1) return keyForChar(token);
  // Unknown named key: send by name so the page still sees a keydown.
  return { key: token, code: '', keyCode: 0, modifiers: 0 };
}

/**
 * A Shift modifier changes which character a printable key produces; CDP
 * inserts the literal `text` field, so Shift+h must carry 'H', not 'h'.
 */
function applyShift(def) {
  if (typeof def.key !== 'string' || def.key.length !== 1) return def;
  if (/^[a-z]$/.test(def.key)) {
    const upper = def.key.toUpperCase();
    return { ...def, key: upper, text: upper };
  }
  const shifted = Object.keys(SHIFTED_CHARS).find((char) => SHIFTED_CHARS[char] === def.key);
  if (shifted) return { ...def, key: shifted, text: shifted };
  return def;
}

async function dispatchKey(tabId, def, extraModifiers = 0) {
  const modifiers = (def.modifiers || 0) | extraModifiers;
  const suppressText = Boolean(modifiers & (MODIFIER_BITS.control | MODIFIER_BITS.meta));
  const text = suppressText ? undefined : def.text;
  const common = { key: def.key, modifiers };
  if (def.code) common.code = def.code;
  if (def.keyCode) {
    common.windowsVirtualKeyCode = def.keyCode;
    common.nativeVirtualKeyCode = def.keyCode;
  }
  const down = { ...common, type: text ? 'keyDown' : 'rawKeyDown' };
  if (text) {
    down.text = text;
    down.unmodifiedText = text;
  }
  await cdp(tabId, 'Input.dispatchKeyEvent', down);
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
}

async function dispatchChord(tabId, chord) {
  const parts = String(chord).split('+').map((part) => part.trim());
  let keyToken = parts.pop() ?? '';
  const modifierTokens = parts.filter((part) => part !== '');
  if (keyToken === '') keyToken = '+'; // a trailing '+' means the plus key itself
  let modifiers = 0;
  for (const token of modifierTokens) {
    const bit = MODIFIER_BITS[token.toLowerCase()];
    if (bit === undefined) throw new Error(`Unknown modifier: ${token}`);
    modifiers |= bit;
  }
  let def = lookupKey(keyToken);
  if (modifiers & MODIFIER_BITS.shift) def = applyShift(def);
  await dispatchKey(tabId, def, modifiers);
}

// ---------------------------------------------------------------------------
// Element value helpers
// ---------------------------------------------------------------------------

const SET_VALUE_FN = `function(value) {
  const tag = (this.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const proto = tag === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(this, value);
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (tag === 'select') {
    this.value = value;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (this.isContentEditable) {
    this.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, value);
  } else {
    throw new Error('Element is not an input, textarea, select, or editable element');
  }
}`;

async function setElementValue(tabId, backendNodeId, value) {
  await callOnElement(tabId, backendNodeId, SET_VALUE_FN, [value]);
}

async function dispatchClick(tabId, point, modifiers = 0) {
  const base = { x: point.x, y: point.y, button: 'left', pointerType: 'mouse', modifiers };
  await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', buttons: 0 });
  await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1, clickCount: 1 });
  await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0, clickCount: 1 });
}

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === 'number') attached.delete(source.tabId);
});

// ---------------------------------------------------------------------------
// Executors — the Vibe compatibility contract plus local extras
// ---------------------------------------------------------------------------

const CALLABLE_PATTERNS = [
  /^\s*(async\s*)?\([^)]*\)\s*=>/,
  /^\s*(async\s+)?[A-Za-z_$][\w$]*\s*=>/,
  /^\s*(async\s+)?function\b/,
];

const isCallable = (source) => CALLABLE_PATTERNS.some((pattern) => pattern.test(source));

const jsonText = (value) => (value === undefined ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value));

const executors = {
  async list_pages() {
    const tabs = await chrome.tabs.query({});
    tabs.sort((a, b) => (a.id || 0) - (b.id || 0));
    const lines = tabs.map((tab) => {
      const active = tab.active ? ' [ACTIVE]' : '';
      return `Page ${tab.id}${active}: "${tab.title || ''}" - ${tab.url || tab.pendingUrl || ''}`;
    });
    return [`Found ${tabs.length} page(s):`, ...lines].join('\n');
  },

  async new_page(args) {
    const url = args.url === undefined || args.url === null || args.url === '' ? 'about:blank' : allowedUrl(args.url);
    const focus = args.focus === true;
    const tab = await chrome.tabs.create({ url, active: focus });
    let warning = '';
    if (args.waitForReady !== false && url !== 'about:blank') warning = await waitForReady(tab.id, 45_000);
    return `Opened new ${focus ? 'foreground' : 'background'} page${warning}\n${await pageLines(tab.id)}`;
  },

  async close_page(args) {
    const pageId = requirePageId(args, 'close_page');
    await chrome.tabs.get(pageId);
    const tabs = await chrome.tabs.query({});
    if (tabs.length <= 1) throw new Error('Refusing to close the final remaining page');
    await chrome.tabs.remove(pageId);
    return `Closed page ${pageId}`;
  },

  async navigate_page(args) {
    const pageId = requirePageId(args, 'navigate_page');
    const type = args.type;
    if (type === 'url') await chrome.tabs.update(pageId, { url: allowedUrl(args.url) });
    else if (type === 'back') await chrome.tabs.goBack(pageId);
    else if (type === 'forward') await chrome.tabs.goForward(pageId);
    else if (type === 'reload') await chrome.tabs.reload(pageId);
    else throw new Error(`Unknown navigation type: ${type}`);
    const warning = await waitForReady(pageId, args.timeoutMs ?? 45_000);
    return `Navigated page ${pageId} (${type})${warning}\n${await pageLines(pageId)}`;
  },

  async switch_to_page(args) {
    const pageId = requirePageId(args, 'switch_to_page');
    const target = await chrome.tabs.get(pageId);
    try { await chrome.windows.update(target.windowId, { focused: true }); } catch { /* headless focus is unavailable */ }
    const tab = await chrome.tabs.update(pageId, { active: true });
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* headless or gone */ }
    let warning = '';
    if (args.waitForReady !== false) warning = await waitForReady(pageId, 15_000);
    if (args.waitForReady !== false && !warning) {
      const visible = await pollVisibility(pageId, 3_000);
      if (!visible) warning = ' (page did not report visibilityState=visible within 3s)';
    }
    return `Switched to page ${pageId}${warning}\n${await pageLines(pageId)}`;
  },

  async take_snapshot(args) {
    const tabId = typeof args.pageId === 'number' ? args.pageId : await activeTabId(args);
    return takeSnapshotFor(tabId, {
      format: args.format ?? 'markdown',
      compact: args.compact === true,
      maxDepth: args.maxDepth,
      scopeSelector: args.scopeSelector,
      changedOnly: args.changedOnly === true,
    });
  },

  async click(args) {
    const tabId = requireTabId(args, 'click');
    const target = await resolveUid(tabId, args.uid);
    if (args.openInNewTab === true) {
      const href = await callOnElement(tabId, target, 'function(){ const link = this.closest ? this.closest("a[href]") : null; return (link || this).href || null; }');
      if (typeof href === 'string' && href) {
        const opened = await chrome.tabs.create({ url: allowedUrl(href), active: false });
        return `Clicked ${normalizeUid(args.uid)} and opened tab ${opened.id}`;
      }
    }
    try {
      const point = await elementCenter(tabId, target);
      await dispatchClick(tabId, point, args.openInNewTab === true ? 4 : 0);
    } catch {
      // No box model (hidden/zero-size element): fall back to a DOM click.
      await callOnElement(tabId, target, 'function(){ this.click(); }');
    }
    return `Clicked ${normalizeUid(args.uid)}`;
  },

  async fill(args) {
    const tabId = requireTabId(args, 'fill');
    if (typeof args.value !== 'string') throw new Error('fill requires a string value');
    const target = await resolveUid(tabId, args.uid);
    await setElementValue(tabId, target, args.value);
    return `Filled ${normalizeUid(args.uid)}`;
  },

  async fill_form(args) {
    const tabId = requireTabId(args, 'fill_form');
    const elements = Array.isArray(args.elements) ? args.elements : [];
    if (!elements.length) throw new Error('fill_form requires a non-empty elements array');
    const done = [];
    for (const field of elements) {
      try {
        const target = await resolveUid(tabId, field?.uid);
        await setElementValue(tabId, target, String(field?.value ?? ''));
        done.push(normalizeUid(field.uid));
      } catch (error) {
        const progress = done.length ? done.join(', ') : 'none';
        throw new Error(`Filled ${done.length}/${elements.length} field(s) (${progress}); failed at ${field?.uid}: ${String(error?.message || error)}`);
      }
    }
    return `Filled ${done.length} field(s): ${done.join(', ')}`;
  },

  async type_text(args) {
    const tabId = requireTabId(args, 'type_text');
    if (typeof args.text !== 'string') throw new Error('type_text requires text');
    for (const char of args.text) await dispatchKey(tabId, keyForChar(char));
    if (args.submitKey) await dispatchChord(tabId, args.submitKey);
    return `Typed ${JSON.stringify(args.text)}${args.submitKey ? ` and pressed ${args.submitKey}` : ''}`;
  },

  async wait_for(args) {
    const tabId = requireTabId(args, 'wait_for');
    const texts = (Array.isArray(args.text) ? args.text : [])
      .map((entry) => String(entry ?? ''))
      .filter((entry) => entry.length > 0);
    if (!texts.length) throw new Error('wait_for requires a non-empty text array');
    const timeoutMs = boundedTimeout(args, 10_000, 60_000);
    const label = texts.map((entry) => JSON.stringify(entry)).join(', ');
    await pollUntil(async () => {
      const pageText = await evaluateInPage(tabId, 'document.body ? document.body.innerText : ""');
      return typeof pageText === 'string' && texts.some((entry) => pageText.includes(entry));
    }, { timeoutMs, describe: `any text in ${label}` });
    return `Found at least one of: ${label}`;
  },

  async wait_for_url(args) {
    const tabId = await activeTabId(args);
    const pattern = String(args.pattern ?? '');
    if (!pattern) throw new Error('wait_for_url requires pattern');
    const hasGlob = /[*?]/.test(pattern);
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = hasGlob ? new RegExp(`^${escaped}$`) : null;
    const timeoutMs = boundedTimeout(args, 15_000, 60_000);
    const finalUrl = await pollUntil(async () => {
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url || tab.pendingUrl || '';
      if (regex ? regex.test(url) : url.includes(pattern)) return url;
      return null;
    }, { timeoutMs, describe: `URL pattern ${JSON.stringify(pattern)}` });
    return `URL is now ${finalUrl}`;
  },

  async wait_for_network_idle(args) {
    const tabId = await activeTabId(args);
    const idleMs = typeof args.idleMs === 'number' && args.idleMs > 0 ? Math.min(args.idleMs, 30_000) : 800;
    const timeoutMs = boundedTimeout(args, 10_000, 30_000);
    const expression = `(() => {
      if (!window.__localMcpDomQuiet) {
        const state = { lastMutation: Date.now() };
        state.observer = new MutationObserver(() => { state.lastMutation = Date.now(); });
        state.observer.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
        window.__localMcpDomQuiet = state;
      }
      return document.readyState === 'complete' && Date.now() - window.__localMcpDomQuiet.lastMutation >= ${idleMs};
    })()`;
    await pollUntil(async () => evaluateInPage(tabId, expression), {
      timeoutMs,
      intervalMs: Math.min(250, Math.max(50, Math.floor(idleMs / 4))),
      describe: `${idleMs}ms of DOM quiet after document readiness`,
    });
    return `Document ready and DOM quiet for ${idleMs}ms`;
  },

  async wait_for_condition(args) {
    const tabId = await activeTabId(args);
    const expression = String(args.expression ?? '');
    if (!expression.trim()) throw new Error('wait_for_condition requires expression');
    const timeoutMs = boundedTimeout(args, 15_000, 60_000);
    const pollMs = typeof args.pollMs === 'number' && args.pollMs > 0 ? Math.min(args.pollMs, 10_000) : 250;
    await pollUntil(async () => {
      const value = await evaluateInPage(tabId, `!!(${expression})`);
      return value === true;
    }, { timeoutMs, intervalMs: pollMs, describe: `condition ${JSON.stringify(expression)}` });
    return `Condition is truthy: ${expression}`;
  },

  async scroll_page(args) {
    const tabId = requireTabId(args, 'scroll_page');
    const direction = args.direction;
    if (direction !== 'up' && direction !== 'down') throw new Error('scroll_page direction must be up or down');
    const numPages = Number(args.numPages);
    if (!Number.isFinite(numPages) || numPages <= 0) throw new Error('scroll_page requires a positive numPages');
    await evaluateInPage(tabId, `window.scrollBy({ top: window.innerHeight * ${direction === 'up' ? -numPages : numPages}, behavior: 'instant' })`);
    return `Scrolled ${direction} ${numPages} page(s)`;
  },

  async press_key(args) {
    const tabId = requireTabId(args, 'press_key');
    if (typeof args.keys !== 'string' || !args.keys.length) throw new Error('press_key requires keys');
    if (typeof args.index === 'number') {
      const target = await resolveUid(tabId, args.index);
      await callOnElement(tabId, target, 'function(){ this.focus(); }');
    }
    await dispatchChord(tabId, args.keys);
    return `Pressed ${args.keys}`;
  },

  async hover(args) {
    const tabId = requireTabId(args, 'hover');
    const target = await resolveUid(tabId, args.index);
    const point = await elementCenter(tabId, target);
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, pointerType: 'mouse' });
    const duration = typeof args.duration === 'number' ? Math.max(100, Math.min(args.duration, 5_000)) : 1_000;
    await sleep(duration);
    return `Hovered ${normalizeUid(args.index)} for ${duration}ms`;
  },

  async drag(args) {
    const tabId = requireTabId(args, 'drag');
    const from = await pointForTarget(tabId, args.source, 'source');
    const to = await pointForTarget(tabId, args.target, 'target');
    const duration = typeof args.duration === 'number' ? Math.max(50, Math.min(args.duration, 10_000)) : 500;
    const base = { button: 'left', pointerType: 'mouse' };
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0, pointerType: 'mouse' });
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', x: from.x, y: from.y, buttons: 1, clickCount: 1 });
    const steps = Math.max(4, Math.min(60, Math.ceil(duration / 40)));
    for (let step = 1; step <= steps; step += 1) {
      const x = from.x + ((to.x - from.x) * step) / steps;
      const y = from.y + ((to.y - from.y) * step) / steps;
      await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', x, y, buttons: 1 });
      await sleep(duration / steps);
    }
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', x: to.x, y: to.y, buttons: 0, clickCount: 1 });
    return `Dragged source to target over ${duration}ms`;
  },

  async take_screenshot(args) {
    const tabId = requireTabId(args, 'take_screenshot');
    const quality = typeof args.quality === 'number' ? Math.max(10, Math.min(90, Math.round(args.quality))) : 70;
    const maxWidth = typeof args.maxWidth === 'number' ? Math.max(64, Math.min(8_192, Math.round(args.maxWidth))) : 1_024;
    const detail = args.detail === 'high' ? 'high' : 'low';
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:/i.test(tab.url || '')) throw new Error(`Cannot capture restricted/system page: ${tab.url || '(no URL)'}`);
    const metrics = await cdp(tabId, 'Page.getLayoutMetrics', {});
    const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport || metrics.layoutViewport;
    const width = Math.max(1, Math.ceil(viewport.clientWidth || viewport.width));
    const height = Math.max(1, Math.ceil(viewport.clientHeight || viewport.height));
    const scale = detail === 'low'
      ? Math.min(1, 768 / Math.min(width, height))
      : Math.min(1, maxWidth / width);
    const format = quality >= 90 ? 'png' : 'jpeg';
    const params = {
      format,
      ...(format === 'jpeg' ? { quality } : {}),
      captureBeyondViewport: false,
      clip: {
        x: viewport.pageX || 0,
        y: viewport.pageY || 0,
        width,
        height,
        scale,
      },
    };
    const grayscale = args.grayscale === true;
    if (grayscale) {
      await evaluateInPage(tabId, `(() => { const old = document.getElementById('__local_mcp_grayscale'); if (old) old.remove(); const style = document.createElement('style'); style.id = '__local_mcp_grayscale'; style.textContent = 'html { filter: grayscale(1) !important; }'; (document.head || document.documentElement).appendChild(style); })()`);
      await sleep(50);
    }
    try {
      const { data } = await cdp(tabId, 'Page.captureScreenshot', params);
      return { content: [{ type: 'image', data, mimeType: `image/${format}` }] };
    } finally {
      if (grayscale) {
        await evaluateInPage(tabId, `document.getElementById('__local_mcp_grayscale')?.remove()`).catch(() => {});
      }
    }
  },

  async evaluate_script(args) {
    const tabId = await activeTabId(args);
    const source = String(args.function ?? '');
    if (!source.trim()) throw new Error('evaluate_script requires function');
    const callArgs = Array.isArray(args.args) ? args.args : [];
    let expression;
    if (isCallable(source)) {
      expression = `(${source})(${callArgs.map((value) => JSON.stringify(value) ?? 'undefined').join(', ')})`;
    } else {
      if (callArgs.length) throw new Error('evaluate_script args require function to be callable, e.g. (a, b) => a + b');
      expression = source;
    }
    const value = await evaluateInPage(tabId, expression, { awaitPromise: true });
    return jsonText(value);
  },

  async upload_file(args) {
    const tabId = requireTabId(args, 'upload_file');
    const target = await resolveUid(tabId, args.uid);
    if ('filePath' in args) throw new Error('upload_file does not accept host filesystem paths; provide inline base64 content');
    const nested = args.file && typeof args.file === 'object' ? args.file : {};
    const filename = nested.filename ?? args.filename;
    const mimeType = nested.mimeType ?? args.mimeType;
    const contentBase64 = nested.contentBase64 ?? nested.content ?? args.contentBase64 ?? args.content;
    if (typeof filename !== 'string' || !filename || typeof mimeType !== 'string' || !mimeType || typeof contentBase64 !== 'string' || !contentBase64) {
      throw new Error('upload_file requires filename, mimeType, and contentBase64/content at the top level or in file');
    }
    await callOnElement(tabId, target, `function(filename, mimeType, contentBase64) {
      const binary = atob(contentBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], filename, { type: mimeType });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      this.files = transfer.files;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }`, [filename, mimeType, contentBase64]);
    return `Set file input ${normalizeUid(args.uid)} to inline file ${filename}`;
  },

  async resize_page(args) {
    const tabId = requireTabId(args, 'resize_page');
    const width = Math.round(Number(args.width));
    const height = Math.round(Number(args.height));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('resize_page requires positive width and height');
    }
    const deviceScaleFactor = typeof args.deviceScaleFactor === 'number' && args.deviceScaleFactor > 0 ? args.deviceScaleFactor : 1;
    await cdp(tabId, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
    return `Resized viewport to ${width}x${height} at device scale ${deviceScaleFactor}`;
  },

  // Local extras beyond the Vibe compatibility contract.
  async get_text(args) {
    const tabId = await activeTabId(args);
    const value = await evaluateInPage(tabId, 'document.body ? document.body.innerText : ""');
    return typeof value === 'string' ? value : '';
  },

  async evaluate(args) {
    const tabId = await activeTabId(args);
    const expression = String(args.expression ?? '');
    if (!expression.trim()) throw new Error('evaluate requires expression');
    const value = await evaluateInPage(tabId, expression, { awaitPromise: true });
    return jsonText(value);
  },
};

// ---------------------------------------------------------------------------
// Browser event wiring
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    snapshots.delete(tabId);
    for (const key of snapshotHashes.keys()) if (key.startsWith(`${tabId}:`)) snapshotHashes.delete(key);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  snapshots.delete(tabId);
  for (const key of snapshotHashes.keys()) if (key.startsWith(`${tabId}:`)) snapshotHashes.delete(key);
  attached.delete(tabId);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (DEFAULT_CONFIG.locked === true) return;
  if ('port' in changes || 'profile' in changes) {
    void (async () => {
      await clearFatal();
      reconnectDelayMs = 1000;
      teardownSocket();
      await connect();
    })();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'local-mcp-status') {
    void (async () => {
      sendResponse({
        connected: Boolean(socket && socket.readyState === WebSocket.OPEN && handshakeState === 'established'),
        port: activeConfig.port,
        profile: activeConfig.profile ?? null,
        locked: activeConfig.locked === true,
        fatal: await getFatal(),
        version: chrome.runtime.getManifest().version,
      });
    })();
    return true;
  }
  if (message?.type === 'local-mcp-reconnect') {
    void (async () => {
      await clearFatal();
      reconnectDelayMs = 1000;
      teardownSocket();
      await connect();
      sendResponse({ ok: true });
    })();
    return true;
  }
  return false;
});

chrome.alarms.create('local-mcp-reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'local-mcp-reconnect') void connect();
});

chrome.runtime.onInstalled.addListener(() => { void connect(); });
chrome.runtime.onStartup.addListener(() => { void connect(); });
void connect();

/**
 * Local browser MCP extension service worker.
 *
 * Connects to the local MCP server's loopback WebSocket bridge, advertises the
 * reviewed tool contract (extension/tools.js), and executes tool calls with
 * chrome.tabs / chrome.windows / chrome.debugger (CDP 1.3).
 *
 * Connection endpoint and profile identity come from config.js (stamped per
 * fleet profile by the packager) overridden by chrome.storage.local (options
 * page). Handshake mismatches fail closed: the server rejects with close codes
 * 4400/4403/4426 and the worker stops reconnecting until reconfigured.
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
let activeConfig = { port: DEFAULT_CONFIG.port, profile: DEFAULT_CONFIG.profile };
let fatalMemory = null;

async function resolveConfig() {
  let port = DEFAULT_CONFIG.port;
  let profile = DEFAULT_CONFIG.profile ?? null;
  try {
    const stored = await chrome.storage.local.get(['port', 'profile']);
    if (Number.isInteger(stored.port) && stored.port >= 1024 && stored.port <= 65535) port = stored.port;
    if (typeof stored.profile === 'string' && stored.profile.trim()) profile = stored.profile.trim();
  } catch {
    // storage unavailable; keep stamped defaults
  }
  return { port, profile };
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
    const budget = typeof args.timeoutMs === 'number' && args.timeoutMs >= 0 ? args.timeoutMs : 15_000;
    return budget + 30_000;
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

function waitBudget(args) {
  const requested = typeof args?.timeout === 'number' && args.timeout > 0 ? args.timeout : 30_000;
  return Math.min(requested, MAX_WAIT_MS);
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
    const value = await work;
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
 * success with a warning suffix — never an error (established behavior).
 */
async function waitForReady(tabId, timeoutMs = 15_000) {
  const budget = Math.max(0, typeof timeoutMs === 'number' ? timeoutMs : 15_000);
  const deadline = Date.now() + budget;
  await sleep(Math.min(150, budget));
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return '';
    } catch {
      return ''; // tab closed or replaced; nothing left to wait for
    }
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

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
  'switch', 'slider', 'spinbutton', 'textfield', 'textfieldwithcombobox',
]);

const SKIPPED_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak']);

async function takeSnapshotFor(tabId, interactiveOnly) {
  const { nodes } = await cdp(tabId, 'Accessibility.getFullAXTree', {});
  const refs = new Map();
  const lines = [];
  let counter = 0;
  let omitted = 0;
  for (const node of nodes || []) {
    if (node.ignored) continue;
    const role = node.role?.value || '';
    const name = node.name?.value || '';
    if (!role || SKIPPED_ROLES.has(role)) continue;
    const interactive = INTERACTIVE_ROLES.has(role.toLowerCase());
    if (!name && !interactive) continue;
    if (interactiveOnly && !interactive) continue;
    if (typeof node.backendDOMNodeId !== 'number') continue;
    counter += 1;
    const uid = `@e${counter}`;
    refs.set(uid, { backendNodeId: node.backendDOMNodeId, role, name });
    if (lines.length < MAX_SNAPSHOT_LINES) {
      lines.push(`${uid} [${role}] ${JSON.stringify(name)}`);
    } else {
      omitted += 1;
    }
  }
  snapshots.set(tabId, refs);
  if (omitted > 0) lines.push(`... (${omitted} more node(s) omitted; use interactive: true to narrow)`);
  return `${await pageLines(tabId)}\n${lines.join('\n')}`;
}

function normalizeUid(raw) {
  const text = String(raw ?? '').trim();
  const stripped = text.startsWith('@') ? text.slice(1) : text;
  if (!/^e\d+$/.test(stripped)) throw new Error(`Invalid uid: ${text || '(empty)'}; expected an @eN uid from take_snapshot`);
  return `@${stripped}`;
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

async function dispatchClick(tabId, point, dblClick) {
  const base = { x: point.x, y: point.y, button: 'left', pointerType: 'mouse' };
  await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', buttons: 0 });
  const clicks = dblClick ? 2 : 1;
  for (let count = 1; count <= clicks; count += 1) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1, clickCount: count });
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0, clickCount: count });
  }
}

// ---------------------------------------------------------------------------
// Network idle tracking
// ---------------------------------------------------------------------------

const networkState = new Map(); // tabId -> { inflight: Set<requestId> }

function networkStateFor(tabId) {
  let state = networkState.get(tabId);
  if (!state) {
    state = { inflight: new Set() };
    networkState.set(tabId, state);
  }
  return state;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== 'number' || !params) return;
  const state = networkStateFor(source.tabId);
  if (method === 'Network.requestWillBeSent') {
    if (params.type === 'WebSocket' || params.type === 'EventSource') return;
    state.inflight.add(params.requestId);
  } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    state.inflight.delete(params.requestId);
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === 'number') attached.delete(source.tabId);
});

// ---------------------------------------------------------------------------
// Executors — the reviewed contract plus local extras
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
    let focused = null;
    try { focused = await chrome.windows.getLastFocused({}); } catch { /* no window focus info */ }
    tabs.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));
    const lines = tabs.map((tab) => {
      const active = tab.active && (!focused || tab.windowId === focused.id) ? ' [ACTIVE]' : '';
      return `Page ${tab.id}${active}: "${tab.title || ''}" - ${tab.url || tab.pendingUrl || ''}`;
    });
    return [`Found ${tabs.length} page(s):`, ...lines].join('\n');
  },

  async new_page(args) {
    const url = allowedUrl(args.url);
    const tab = await chrome.tabs.create({ url, active: true });
    let warning = '';
    if (args.waitForReady !== false) warning = await waitForReady(tab.id, args.timeoutMs ?? 15_000);
    return `Opened new page${warning}\n${await pageLines(tab.id)}`;
  },

  async close_page(args) {
    const tabId = await activeTabId(args);
    await chrome.tabs.remove(tabId);
    return `Closed tab ${tabId}`;
  },

  async navigate_page(args) {
    const tabId = await activeTabId(args);
    const type = args.type || 'url';
    if (type === 'url') await chrome.tabs.update(tabId, { url: allowedUrl(args.url) });
    else if (type === 'back') await chrome.tabs.goBack(tabId);
    else if (type === 'forward') await chrome.tabs.goForward(tabId);
    else if (type === 'reload') await chrome.tabs.reload(tabId);
    else throw new Error(`Unknown navigation type: ${type}`);
    const warning = await waitForReady(tabId, args.timeoutMs ?? 15_000);
    return `Navigated (${type})${warning}\n${await pageLines(tabId)}`;
  },

  async switch_to_page(args) {
    if (typeof args.tabId !== 'number') throw new Error('switch_to_page requires tabId');
    const tab = await chrome.tabs.update(args.tabId, { active: true });
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* headless or gone */ }
    let warning = await waitForReady(args.tabId, 15_000);
    if (!warning) {
      const visible = await pollVisibility(args.tabId, 3_000);
      if (!visible) warning = ' (page did not report visibilityState=visible within 3s)';
    }
    return `Switched to tab ${args.tabId}${warning}\n${await pageLines(args.tabId)}`;
  },

  async take_snapshot(args) {
    const tabId = await activeTabId(args);
    return takeSnapshotFor(tabId, args.interactive === true);
  },

  async click(args) {
    const tabId = await activeTabId(args);
    const target = await resolveUid(tabId, args.uid);
    try {
      const point = await elementCenter(tabId, target);
      await dispatchClick(tabId, point, args.dblClick === true);
    } catch {
      // No box model (hidden/zero-size element): fall back to a DOM click.
      await callOnElement(tabId, target, 'function(){ this.click(); }');
      if (args.dblClick === true) await callOnElement(tabId, target, 'function(){ this.click(); }');
    }
    return `Clicked ${normalizeUid(args.uid)}`;
  },

  async fill(args) {
    const tabId = await activeTabId(args);
    if (typeof args.value !== 'string') throw new Error('fill requires a string value');
    const target = await resolveUid(tabId, args.uid);
    await setElementValue(tabId, target, args.value);
    return `Filled ${normalizeUid(args.uid)}`;
  },

  async fill_form(args) {
    const tabId = await activeTabId(args);
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
    const tabId = await activeTabId(args);
    if (typeof args.text !== 'string') throw new Error('type_text requires text');
    if (args.uid) {
      const target = await resolveUid(tabId, args.uid);
      await callOnElement(tabId, target, `function() {
        this.focus();
        if (typeof this.setSelectionRange === 'function' && /^(text|search|tel|url|password)$/i.test(this.type || 'text')) {
          const end = this.value.length;
          try { this.setSelectionRange(end, end); } catch { /* unsupported input type */ }
        }
      }`);
    }
    for (const char of args.text) await dispatchKey(tabId, keyForChar(char));
    if (args.submitKey) await dispatchChord(tabId, args.submitKey);
    return `Typed ${JSON.stringify(args.text)}${args.submitKey ? ` and pressed ${args.submitKey}` : ''}`;
  },

  async wait_for(args) {
    const tabId = await activeTabId(args);
    const texts = (Array.isArray(args.text) ? args.text : [args.text])
      .map((entry) => String(entry ?? ''))
      .filter((entry) => entry.length > 0);
    if (!texts.length) throw new Error('wait_for requires text');
    const timeoutMs = waitBudget(args);
    const label = texts.map((entry) => JSON.stringify(entry)).join(', ');
    await pollUntil(async () => {
      const pageText = await evaluateInPage(tabId, 'document.body ? document.body.innerText : ""');
      return typeof pageText === 'string' && texts.every((entry) => pageText.includes(entry));
    }, { timeoutMs, describe: `text ${label}` });
    return `Found ${label}`;
  },

  async wait_for_url(args) {
    const tabId = await activeTabId(args);
    const pattern = String(args.url ?? '');
    if (!pattern) throw new Error('wait_for_url requires url');
    let regex = null;
    try { regex = new RegExp(pattern); } catch { regex = null; }
    const timeoutMs = waitBudget(args);
    const finalUrl = await pollUntil(async () => {
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url || tab.pendingUrl || '';
      if (url.includes(pattern)) return url;
      if (regex && regex.test(url)) return url;
      return null;
    }, { timeoutMs, describe: `URL matching ${JSON.stringify(pattern)}` });
    return `URL is now ${finalUrl}`;
  },

  async wait_for_network_idle(args) {
    const tabId = await activeTabId(args);
    const idleMs = typeof args.idleMs === 'number' && args.idleMs > 0 ? Math.min(args.idleMs, 60_000) : 500;
    const timeoutMs = waitBudget(args);
    await cdp(tabId, 'Network.enable', {});
    const state = networkStateFor(tabId);
    const deadline = Date.now() + timeoutMs;
    let idleStart = state.inflight.size === 0 ? Date.now() : null;
    for (;;) {
      if (state.inflight.size === 0) {
        if (idleStart === null) idleStart = Date.now();
        if (Date.now() - idleStart >= idleMs) return `Network idle for ${idleMs}ms`;
      } else {
        idleStart = null;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for network idle (${state.inflight.size} request(s) in flight)`);
      }
      await sleep(100);
    }
  },

  async wait_for_condition(args) {
    const tabId = await activeTabId(args);
    const condition = String(args.condition ?? '');
    if (!condition.trim()) throw new Error('wait_for_condition requires condition');
    const timeoutMs = waitBudget(args);
    await pollUntil(async () => {
      const value = await evaluateInPage(tabId, `!!(${condition})`);
      return value === true;
    }, { timeoutMs, describe: `condition ${JSON.stringify(condition)}` });
    return `Condition is truthy: ${condition}`;
  },

  async scroll_page(args) {
    const tabId = await activeTabId(args);
    const direction = args.direction || 'down';
    const amount = typeof args.amount === 'number' && Number.isFinite(args.amount) && args.amount > 0 ? args.amount : 500;
    const deltas = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] };
    const delta = deltas[direction];
    if (!delta) throw new Error(`Unknown scroll direction: ${direction}`);
    if (args.uid) {
      const target = await resolveUid(tabId, args.uid);
      await callOnElement(tabId, target, 'function(dx, dy){ this.scrollBy({ left: dx, top: dy, behavior: "instant" }); }', delta);
    } else {
      await evaluateInPage(tabId, `window.scrollBy({ left: ${delta[0]}, top: ${delta[1]}, behavior: 'instant' })`);
    }
    return `Scrolled ${direction} ${amount}px`;
  },

  async press_key(args) {
    const tabId = await activeTabId(args);
    if (typeof args.keys !== 'string' || !args.keys.length) throw new Error('press_key requires keys');
    await dispatchChord(tabId, args.keys);
    return `Pressed ${args.keys}`;
  },

  async hover(args) {
    const tabId = await activeTabId(args);
    const target = await resolveUid(tabId, args.uid);
    const point = await elementCenter(tabId, target);
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, pointerType: 'mouse' });
    return `Hovered ${normalizeUid(args.uid)}`;
  },

  async drag(args) {
    const tabId = await activeTabId(args);
    const sourceNode = await resolveUid(tabId, args.from_uid);
    const targetNode = await resolveUid(tabId, args.to_uid);
    const from = await elementCenter(tabId, sourceNode);
    const to = await elementCenter(tabId, targetNode);
    const base = { button: 'left', pointerType: 'mouse' };
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0, pointerType: 'mouse' });
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', x: from.x, y: from.y, buttons: 1, clickCount: 1 });
    const steps = 8;
    for (let step = 1; step <= steps; step += 1) {
      const x = from.x + ((to.x - from.x) * step) / steps;
      const y = from.y + ((to.y - from.y) * step) / steps;
      await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', x, y, buttons: 1 });
      await sleep(20);
    }
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', x: to.x, y: to.y, buttons: 0, clickCount: 1 });
    return `Dragged ${normalizeUid(args.from_uid)} to ${normalizeUid(args.to_uid)}`;
  },

  async take_screenshot(args) {
    const tabId = await activeTabId(args);
    const params = { format: 'png' };
    if (args.uid) {
      const target = await resolveUid(tabId, args.uid);
      const metrics = await cdp(tabId, 'Page.getLayoutMetrics', {});
      const viewport = metrics.cssLayoutViewport || metrics.layoutViewport || { pageX: 0, pageY: 0 };
      const { model } = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId: target });
      const xs = [model.border[0], model.border[2], model.border[4], model.border[6]];
      const ys = [model.border[1], model.border[3], model.border[5], model.border[7]];
      params.clip = {
        x: Math.min(...xs) + (viewport.pageX || 0),
        y: Math.min(...ys) + (viewport.pageY || 0),
        width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
        height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
        scale: 1,
      };
      params.captureBeyondViewport = true;
    } else if (args.fullPage === true) {
      const metrics = await cdp(tabId, 'Page.getLayoutMetrics', {});
      const size = metrics.cssContentSize || metrics.contentSize;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), 16_000), scale: 1 };
      params.captureBeyondViewport = true;
    }
    const { data } = await cdp(tabId, 'Page.captureScreenshot', params);
    return { content: [{ type: 'image', data, mimeType: 'image/png' }] };
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
    const tabId = await activeTabId(args);
    const target = await resolveUid(tabId, args.uid);
    const hasPath = typeof args.filePath === 'string' && args.filePath.length > 0;
    const hasInline = Boolean(args.file) && typeof args.file === 'object';
    if (hasPath === hasInline) throw new Error('upload_file requires exactly one of filePath or file');
    if (hasPath) {
      await cdp(tabId, 'DOM.setFileInputFiles', { files: [args.filePath], backendNodeId: target });
      return `Set file input ${normalizeUid(args.uid)} to ${args.filePath}`;
    }
    const { filename, mimeType, contentBase64 } = args.file;
    if (typeof filename !== 'string' || typeof mimeType !== 'string' || typeof contentBase64 !== 'string') {
      throw new Error('upload_file file requires filename, mimeType, and contentBase64');
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
    const tabId = await activeTabId(args);
    const width = Math.round(Number(args.width));
    const height = Math.round(Number(args.height));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('resize_page requires positive width and height');
    }
    await cdp(tabId, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false });
    return `Resized viewport to ${width}x${height}`;
  },

  // Local extras beyond the reviewed contract.
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
    const state = networkState.get(tabId);
    if (state) state.inflight.clear();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  snapshots.delete(tabId);
  networkState.delete(tabId);
  attached.delete(tabId);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
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

const BRIDGE_URL = 'ws://127.0.0.1:19889';
const HEARTBEAT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const TOOL_TIMEOUT_MS = 90_000;
const CDP = '1.3';

let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let heartbeatTimer = null;
let lastMessageAt = 0;
let socketGeneration = 0;
const completed = new Map();
const inFlight = new Map();
const attachedTabs = new Set();
const snapshots = new Map();

const object = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const string = (description) => ({ type: 'string', description });
const number = (description) => ({ type: 'number', description });

const tools = [
  ['list_tabs', 'List browser tabs.', object()],
  ['snapshot', 'Read the accessibility tree and assign stable @eN references for later actions.', object({ tabId: number('Chrome tab ID; active tab by default'), interactive: { type: 'boolean' } })],
  ['click', 'Click an element from the latest snapshot.', object({ ref: string('@eN reference'), tabId: number('Chrome tab ID') }, ['ref'])],
  ['fill', 'Replace the value of an input, textarea, select, or editable element.', object({ ref: string('@eN reference'), text: string('Replacement text'), tabId: number('Chrome tab ID') }, ['ref', 'text'])],
  ['type_text', 'Type text into an element without clearing it.', object({ ref: string('@eN reference'), text: string('Text to type'), tabId: number('Chrome tab ID') }, ['ref', 'text'])],
  ['hover', 'Move the pointer over an element.', object({ ref: string('@eN reference'), tabId: number('Chrome tab ID') }, ['ref'])],
  ['press_key', 'Press a key such as Enter, Tab, Escape, or Control+a.', object({ key: string('Key or modifier chord'), tabId: number('Chrome tab ID') }, ['key'])],
  ['scroll', 'Scroll the page.', object({ direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: number('Pixels; defaults to 500'), tabId: number('Chrome tab ID') })],
  ['navigate', 'Navigate a tab to an HTTP or HTTPS URL.', object({ url: string('Destination URL'), tabId: number('Chrome tab ID') }, ['url'])],
  ['new_tab', 'Open a new tab.', object({ url: string('Optional HTTP or HTTPS URL') })],
  ['select_tab', 'Activate a tab.', object({ tabId: number('Chrome tab ID') }, ['tabId'])],
  ['close_tab', 'Close a tab.', object({ tabId: number('Chrome tab ID; active tab by default') })],
  ['screenshot', 'Capture the visible viewport as PNG.', object({ tabId: number('Chrome tab ID') })],
  ['get_text', 'Read visible page text.', object({ tabId: number('Chrome tab ID') })],
  ['evaluate', 'Evaluate JavaScript in the page and return its value.', object({ expression: string('JavaScript expression'), tabId: number('Chrome tab ID') }, ['expression'])],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));

function connect() {
  clearTimeout(reconnectTimer);
  const generation = ++socketGeneration;
  const ws = new WebSocket(BRIDGE_URL);
  socket = ws;
  ws.onopen = () => {
    if (generation !== socketGeneration) return ws.close();
    reconnectAttempt = 0;
    lastMessageAt = Date.now();
    send({ type: 'connected' });
    send({ type: 'tools_list', data: tools });
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastMessageAt > HEARTBEAT_MS * 2) {
        ws.close(4000, 'Local bridge heartbeat timed out');
        return;
      }
      send({ type: 'connected' });
    }, HEARTBEAT_MS);
  };
  ws.onmessage = (event) => {
    if (generation !== socketGeneration) return;
    lastMessageAt = Date.now();
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'list_tools') send({ type: 'tools_list', requestId: message.requestId, data: tools });
    if (message.type === 'ping') send({ type: 'connected', requestId: message.requestId });
    if (message.type === 'call_tool') void handleCall(message);
  };
  ws.onclose = () => {
    if (generation !== socketGeneration) return;
    socket = null;
    clearInterval(heartbeatTimer);
    const delay = Math.min(1_000 * 2 ** reconnectAttempt++, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(connect, delay);
  };
  ws.onerror = () => ws.close();
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

async function handleCall(message) {
  const { requestId, data } = message;
  if (!requestId || !data?.name) return;
  if (completed.has(requestId)) return send(completed.get(requestId));
  if (inFlight.has(requestId)) return;
  const progress = setInterval(() => send({ type: 'tool_progress', requestId }), 15_000);
  const execution = execute(data.name, data.arguments || {});
  inFlight.set(requestId, execution);
  try {
    const value = await withTimeout(execution, TOOL_TIMEOUT_MS, data.name);
    const response = { type: 'tool_result', requestId, data: toResult(value) };
    remember(requestId, response);
    send(response);
  } catch (error) {
    const response = { type: 'error', requestId, error: error?.message || String(error) };
    remember(requestId, response);
    send(response);
  } finally {
    clearInterval(progress);
    inFlight.delete(requestId);
  }
}

function remember(id, response) {
  completed.set(id, response);
  if (completed.size > 1_000) completed.delete(completed.keys().next().value);
}

function withTimeout(promise, ms, name) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), ms); })])
    .finally(() => clearTimeout(timer));
}

function toResult(value) {
  if (value?.image) return { content: [{ type: 'image', data: value.image, mimeType: 'image/png' }] };
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

async function activeTabId(requested) {
  if (Number.isInteger(requested)) return requested;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active browser tab');
  return tab.id;
}

function allowedUrl(raw) {
  const value = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS navigation is allowed');
  return url.href;
}

async function cdp(tabId, method, params = {}, retry = true) {
  if (!attachedTabs.has(tabId)) {
    await chrome.debugger.attach({ tabId }, CDP);
    attachedTabs.add(tabId);
  }
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (error) {
    if (!retry) throw error;
    attachedTabs.delete(tabId);
    await new Promise((resolve) => setTimeout(resolve, 75));
    return cdp(tabId, method, params, false);
  }
}

chrome.debugger.onDetach.addListener(({ tabId }) => { if (tabId) attachedTabs.delete(tabId); });
chrome.tabs.onRemoved.addListener((tabId) => { attachedTabs.delete(tabId); snapshots.delete(tabId); });
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'local-mcp-status') respond({ connected: socket?.readyState === WebSocket.OPEN });
});

async function execute(name, args) {
  switch (name) {
    case 'list_tabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.filter((tab) => tab.id).map((tab) => ({ tabId: tab.id, active: tab.active, title: tab.title, url: tab.url }));
    }
    case 'snapshot': return snapshot(await activeTabId(args.tabId), args.interactive === true);
    case 'click': return interact(await activeTabId(args.tabId), args.ref, 'click');
    case 'fill': return interact(await activeTabId(args.tabId), args.ref, 'fill', String(args.text));
    case 'type_text': return interact(await activeTabId(args.tabId), args.ref, 'type', String(args.text));
    case 'hover': return interact(await activeTabId(args.tabId), args.ref, 'hover');
    case 'press_key': return pressKey(await activeTabId(args.tabId), String(args.key));
    case 'scroll': return scroll(await activeTabId(args.tabId), args.direction || 'down', Number(args.amount) || 500);
    case 'navigate': {
      const tabId = await activeTabId(args.tabId);
      await chrome.tabs.update(tabId, { url: allowedUrl(String(args.url)) });
      snapshots.delete(tabId);
      return { tabId, url: args.url };
    }
    case 'new_tab': {
      const tab = await chrome.tabs.create({ url: args.url ? allowedUrl(String(args.url)) : 'about:blank', active: true });
      return { tabId: tab.id, url: tab.url };
    }
    case 'select_tab': await chrome.tabs.update(Number(args.tabId), { active: true }); return { tabId: Number(args.tabId) };
    case 'close_tab': { const tabId = await activeTabId(args.tabId); await chrome.tabs.remove(tabId); return { closed: tabId }; }
    case 'screenshot': {
      const tabId = await activeTabId(args.tabId);
      const tab = await chrome.tabs.get(tabId);
      if (!tab.active) await chrome.tabs.update(tabId, { active: true });
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return { image: dataUrl.split(',')[1] };
    }
    case 'get_text': return evaluate(await activeTabId(args.tabId), 'document.body?.innerText || ""');
    case 'evaluate': return evaluate(await activeTabId(args.tabId), String(args.expression));
    default: throw new Error(`Unknown local tool: ${name}`);
  }
}

async function snapshot(tabId, interactiveOnly) {
  await cdp(tabId, 'Accessibility.enable');
  const { nodes = [] } = await cdp(tabId, 'Accessibility.getFullAXTree');
  const refs = new Map();
  const lines = [];
  const interactiveRoles = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'option', 'slider', 'tab', 'switch']);
  for (const node of nodes) {
    const role = node.role?.value || '';
    const name = node.name?.value || '';
    if (node.ignored || !node.backendDOMNodeId || (!name && !interactiveRoles.has(role))) continue;
    if (interactiveOnly && !interactiveRoles.has(role)) continue;
    const ref = `e${refs.size + 1}`;
    refs.set(ref, { backendDOMNodeId: node.backendDOMNodeId, role, name });
    lines.push(`@${ref} [${role || 'node'}] ${JSON.stringify(String(name).slice(0, 180))}`);
  }
  snapshots.set(tabId, refs);
  const tab = await chrome.tabs.get(tabId);
  return `Tab ${tabId}: ${tab.title || ''}\nURL: ${tab.url || ''}\n${lines.join('\n')}`;
}

async function resolveRef(tabId, rawRef) {
  const ref = String(rawRef).replace(/^@/, '');
  let entry = snapshots.get(tabId)?.get(ref);
  if (!entry) { await snapshot(tabId, false); entry = snapshots.get(tabId)?.get(ref); }
  if (!entry) throw new Error(`Unknown element reference @${ref}; take a new snapshot`);
  try {
    const resolved = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: entry.backendDOMNodeId });
    if (resolved?.object?.objectId) return { ...entry, objectId: resolved.object.objectId };
  } catch { /* refresh once below */ }
  await snapshot(tabId, false);
  const candidates = [...snapshots.get(tabId).values()].filter((node) => node.role === entry.role && node.name === entry.name);
  if (candidates.length !== 1) throw new Error(`Element @${ref} became stale; take a new snapshot`);
  const resolved = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: candidates[0].backendDOMNodeId });
  return { ...candidates[0], objectId: resolved.object.objectId };
}

async function interact(tabId, ref, action, text = '') {
  const node = await resolveRef(tabId, ref);
  await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendDOMNodeId }).catch(() => {});
  let fn;
  if (action === 'click') fn = 'function(){ this.click(); }';
  if (action === 'hover') {
    const { model } = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId });
    const x = (model.content[0] + model.content[2]) / 2, y = (model.content[1] + model.content[5]) / 2;
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    return `Hovered ${node.role} ${JSON.stringify(node.name)}`;
  }
  if (action === 'fill' || action === 'type') fn = `function(value,clear){ this.focus(); if(clear){ if(this.isContentEditable)this.textContent=''; else this.value=''; } document.execCommand('insertText',false,value); this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); }`;
  await cdp(tabId, 'Runtime.callFunctionOn', { objectId: node.objectId, functionDeclaration: fn, arguments: [{ value: text }, { value: action === 'fill' }], awaitPromise: true });
  await cdp(tabId, 'Runtime.releaseObject', { objectId: node.objectId }).catch(() => {});
  snapshots.delete(tabId);
  return `${action === 'click' ? 'Clicked' : action === 'fill' ? 'Filled' : 'Typed in'} ${node.role} ${JSON.stringify(node.name)}`;
}

async function evaluate(tabId, expression) {
  const result = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'JavaScript evaluation failed');
  return result.result?.value;
}

async function scroll(tabId, direction, amount) {
  const [x, y] = direction === 'up' ? [0, -amount] : direction === 'down' ? [0, amount] : direction === 'left' ? [-amount, 0] : [amount, 0];
  await evaluate(tabId, `window.scrollBy(${x},${y})`);
  snapshots.delete(tabId);
  return `Scrolled ${direction} ${amount}px`;
}

async function pressKey(tabId, chord) {
  const parts = chord.split('+');
  const key = parts.pop();
  const modifiers = (parts.includes('Alt') ? 1 : 0) | (parts.includes('Control') ? 2 : 0) | (parts.includes('Meta') ? 4 : 0) | (parts.includes('Shift') ? 8 : 0);
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers });
  snapshots.delete(tabId);
  return `Pressed ${chord}`;
}

connect();

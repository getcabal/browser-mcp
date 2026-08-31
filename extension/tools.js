/**
 * Tool definitions advertised by the extension — the reviewed public contract.
 *
 * Pure data, no chrome.* usage, importable by Node tests. Must stay in sync
 * with server/src/contract.ts (name/description/inputSchema byte-identical);
 * server/test/contract-sync.mjs enforces it, so edit both files together.
 */

export const PROTOCOL_VERSION = 2;

const object = (properties = {}, required = []) =>
  ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const string = (description) => ({ type: 'string', description });
const number = (description) => ({ type: 'number', description });
const boolean = (description) => ({ type: 'boolean', description });

const tabId = number('Chrome tab ID; the active tab by default');
const uid = string('Element uid from the latest take_snapshot, e.g. @e12');
const waitTimeout = number('Maximum wait in milliseconds; defaults to 30000');
const readyTimeout = number('Readiness budget in milliseconds; defaults to 15000');

const tool = (name, description, inputSchema) => ({ name, description, inputSchema });

/** The 22 reviewed contract tools, in the order they are advertised. */
export const CONTRACT_TOOLS = [
  tool('list_pages', 'List open browser pages (tabs) with their tab ID, title, and URL.',
    object()),
  tool('new_page', 'Open a new page (tab), optionally waiting for it to finish loading.',
    object({ url: string('HTTP or HTTPS URL to open'), waitForReady: boolean('Wait for the page to reach readyState=complete; defaults to true'), timeoutMs: readyTimeout }, ['url'])),
  tool('close_page', 'Close a page (tab).',
    object({ tabId })),
  tool('navigate_page', 'Navigate a page: open a URL, or go back, forward, or reload. Establishes bounded readiness.',
    object({ url: string('Destination HTTP or HTTPS URL (ignored for back, forward, and reload)'), tabId, type: { type: 'string', enum: ['url', 'back', 'forward', 'reload'], description: 'Navigation type; defaults to url' }, timeoutMs: readyTimeout }, ['url'])),
  tool('switch_to_page', 'Activate a page (tab), focus its Chrome window, and wait for it to become visible and ready.',
    object({ tabId: number('Chrome tab ID') }, ['tabId'])),
  tool('take_snapshot', 'Read the accessibility tree and assign stable @eN uids for later interactions.',
    object({ tabId, interactive: boolean('Interactive elements only') })),
  tool('click', 'Click an element from the latest snapshot.',
    object({ uid, tabId, dblClick: boolean('Double-click instead of single click') }, ['uid'])),
  tool('fill', 'Replace the value of an input, textarea, select, or editable element.',
    object({ uid, value: string('Replacement value'), tabId }, ['uid', 'value'])),
  tool('fill_form', 'Fill multiple form fields in one call.',
    object({ elements: { type: 'array', description: 'Fields to fill, in order', items: { type: 'object', properties: { uid: { type: 'string', description: 'Element uid from the latest take_snapshot, e.g. @e12' }, value: { type: 'string', description: 'Replacement value' } }, required: ['uid', 'value'] } }, tabId }, ['elements'])),
  tool('type_text', 'Type text with real key events, optionally into a specific element, optionally pressing a submit key afterwards.',
    object({ text: string('Text to type'), uid, submitKey: string('Key to press after typing, e.g. Enter'), tabId }, ['text'])),
  tool('wait_for', 'Wait until the given text (or all given texts) appears in the page.',
    object({ text: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Text or list of texts that must all appear' }, timeout: waitTimeout, tabId }, ['text'])),
  tool('wait_for_url', 'Wait until the page URL contains the given text or matches the given pattern.',
    object({ url: string('Substring or JavaScript regular expression the page URL must match'), timeout: waitTimeout, tabId }, ['url'])),
  tool('wait_for_network_idle', 'Wait until the page has had no in-flight network requests for a quiet period.',
    object({ idleMs: number('Continuous quiet period in milliseconds; defaults to 500'), timeout: waitTimeout, tabId })),
  tool('wait_for_condition', 'Wait until a JavaScript expression evaluates to a truthy value in the page.',
    object({ condition: string('JavaScript expression evaluated in the page until truthy'), timeout: waitTimeout, tabId }, ['condition'])),
  tool('scroll_page', 'Scroll the page, or a specific element, in a direction by a pixel amount.',
    object({ direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction; defaults to down' }, amount: number('Pixels; defaults to 500'), uid, tabId })),
  tool('press_key', 'Press a key or key chord such as Enter, Tab, Escape, or Control+a.',
    object({ keys: string('Key or modifier chord, e.g. Enter or Control+a'), tabId }, ['keys'])),
  tool('hover', 'Move the pointer over an element.',
    object({ uid, tabId }, ['uid'])),
  tool('drag', 'Drag an element onto another element with real pointer events.',
    object({ from_uid: string('Element uid to drag'), to_uid: string('Element uid to drop onto'), tabId }, ['from_uid', 'to_uid'])),
  tool('take_screenshot', 'Capture the page as a PNG image: viewport by default, full page, or a single element.',
    object({ tabId, fullPage: boolean('Capture the full scrollable page'), uid })),
  tool('evaluate_script', 'Evaluate a JavaScript function or expression in the page and return its JSON value.',
    object({ function: string('JavaScript function (called with args) or bare expression'), args: { type: 'array', description: 'JSON arguments passed when function is callable' }, tabId }, ['function'])),
  tool('upload_file', 'Set the file of a file input, from a local path or inline base64 content.',
    object({ uid, filePath: string('Absolute path to a local file'), file: { type: 'object', description: 'Inline file content', properties: { filename: { type: 'string' }, mimeType: { type: 'string' }, contentBase64: { type: 'string' } }, required: ['filename', 'mimeType', 'contentBase64'] }, tabId }, ['uid'])),
  tool('resize_page', 'Resize the page viewport to the given dimensions.',
    object({ width: number('Viewport width in CSS pixels'), height: number('Viewport height in CSS pixels'), tabId }, ['width', 'height'])),
];

/** Local-only conveniences kept beyond the reviewed contract. */
export const EXTRA_TOOLS = [
  tool('get_text', 'Read visible page text.',
    object({ tabId: number('Chrome tab ID') })),
  tool('evaluate', 'Evaluate JavaScript in the page and return its value.',
    object({ expression: string('JavaScript expression'), tabId: number('Chrome tab ID') }, ['expression'])),
];

export const TOOLS = [...CONTRACT_TOOLS, ...EXTRA_TOOLS];

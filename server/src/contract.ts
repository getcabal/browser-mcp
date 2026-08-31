/**
 * The reviewed public tool contract, as data.
 *
 * The 22 CONTRACT_TOOLS reproduce the established browser MCP surface exactly
 * (names, parameter spellings, semantics); EXTRA_TOOLS are two local-only
 * conveniences kept beyond that contract. extension/tools.js must stay
 * byte-identical for name/description/inputSchema — test/contract-sync.mjs
 * enforces the equality, so edit both files together.
 */

export const VERSION = '1.1.0';
export const PROTOCOL_VERSION = 2;

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ContractTool extends ToolDefinition {
  description: string;
  title: string;
  annotations: ToolAnnotations;
}

type Schema = Record<string, unknown>;

const object = (properties: Record<string, Schema> = {}, required: string[] = []): Schema =>
  ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const string = (description: string): Schema => ({ type: 'string', description });
const number = (description: string): Schema => ({ type: 'number', description });
const boolean = (description: string): Schema => ({ type: 'boolean', description });

const tabId = number('Chrome tab ID; the active tab by default');
const uid = string('Element uid from the latest take_snapshot, e.g. @e12');
const waitTimeout = number('Maximum wait in milliseconds; defaults to 30000');
const readyTimeout = number('Readiness budget in milliseconds; defaults to 15000');

const annotate = (
  title: string,
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean,
): ToolAnnotations => ({ title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint });

const tool = (
  name: string,
  description: string,
  inputSchema: Schema,
  annotations: ToolAnnotations,
): ContractTool => ({ name, description, inputSchema, title: annotations.title, annotations });

/** The 22 reviewed contract tools, in the order they are advertised. */
export const CONTRACT_TOOLS: ContractTool[] = [
  tool('list_pages', 'List open browser pages (tabs) with their tab ID, title, and URL.',
    object(),
    annotate('List Pages', true, false, true, false)),
  tool('new_page', 'Open a new page (tab), optionally waiting for it to finish loading.',
    object({ url: string('HTTP or HTTPS URL to open'), waitForReady: boolean('Wait for the page to reach readyState=complete; defaults to true'), timeoutMs: readyTimeout }, ['url']),
    annotate('Open New Page', false, false, false, true)),
  tool('close_page', 'Close a page (tab).',
    object({ tabId }),
    annotate('Close Page', false, true, true, false)),
  tool('navigate_page', 'Navigate a page: open a URL, or go back, forward, or reload. Establishes bounded readiness.',
    object({ url: string('Destination HTTP or HTTPS URL (ignored for back, forward, and reload)'), tabId, type: { type: 'string', enum: ['url', 'back', 'forward', 'reload'], description: 'Navigation type; defaults to url' }, timeoutMs: readyTimeout }, ['url']),
    annotate('Navigate Page', false, false, false, true)),
  tool('switch_to_page', 'Activate a page (tab), focus its Chrome window, and wait for it to become visible and ready.',
    object({ tabId: number('Chrome tab ID') }, ['tabId']),
    annotate('Switch Page', false, false, true, false)),
  tool('take_snapshot', 'Read the accessibility tree and assign stable @eN uids for later interactions.',
    object({ tabId, interactive: boolean('Interactive elements only') }),
    annotate('Take Page Snapshot', true, false, true, false)),
  tool('click', 'Click an element from the latest snapshot.',
    object({ uid, tabId, dblClick: boolean('Double-click instead of single click') }, ['uid']),
    annotate('Click Element', false, false, true, true)),
  tool('fill', 'Replace the value of an input, textarea, select, or editable element.',
    object({ uid, value: string('Replacement value'), tabId }, ['uid', 'value']),
    annotate('Fill Field', false, false, true, false)),
  tool('fill_form', 'Fill multiple form fields in one call.',
    object({ elements: { type: 'array', description: 'Fields to fill, in order', items: { type: 'object', properties: { uid: { type: 'string', description: 'Element uid from the latest take_snapshot, e.g. @e12' }, value: { type: 'string', description: 'Replacement value' } }, required: ['uid', 'value'] } }, tabId }, ['elements']),
    annotate('Fill Form', false, false, true, false)),
  tool('type_text', 'Type text with real key events, optionally into a specific element, optionally pressing a submit key afterwards.',
    object({ text: string('Text to type'), uid, submitKey: string('Key to press after typing, e.g. Enter'), tabId }, ['text']),
    annotate('Type Text', false, false, false, false)),
  tool('wait_for', 'Wait until the given text (or all given texts) appears in the page.',
    object({ text: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Text or list of texts that must all appear' }, timeout: waitTimeout, tabId }, ['text']),
    annotate('Wait For Element', true, false, true, false)),
  tool('wait_for_url', 'Wait until the page URL contains the given text or matches the given pattern.',
    object({ url: string('Substring or JavaScript regular expression the page URL must match'), timeout: waitTimeout, tabId }, ['url']),
    annotate('Wait For URL', true, false, true, false)),
  tool('wait_for_network_idle', 'Wait until the page has had no in-flight network requests for a quiet period.',
    object({ idleMs: number('Continuous quiet period in milliseconds; defaults to 500'), timeout: waitTimeout, tabId }),
    annotate('Wait For Network Idle', true, false, true, false)),
  tool('wait_for_condition', 'Wait until a JavaScript expression evaluates to a truthy value in the page.',
    object({ condition: string('JavaScript expression evaluated in the page until truthy'), timeout: waitTimeout, tabId }, ['condition']),
    annotate('Wait For Condition', false, true, false, true)),
  tool('scroll_page', 'Scroll the page, or a specific element, in a direction by a pixel amount.',
    object({ direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction; defaults to down' }, amount: number('Pixels; defaults to 500'), uid, tabId }),
    annotate('Scroll Page', false, false, false, false)),
  tool('press_key', 'Press a key or key chord such as Enter, Tab, Escape, or Control+a.',
    object({ keys: string('Key or modifier chord, e.g. Enter or Control+a'), tabId }, ['keys']),
    annotate('Press Key', false, true, false, true)),
  tool('hover', 'Move the pointer over an element.',
    object({ uid, tabId }, ['uid']),
    annotate('Hover Element', false, false, true, false)),
  tool('drag', 'Drag an element onto another element with real pointer events.',
    object({ from_uid: string('Element uid to drag'), to_uid: string('Element uid to drop onto'), tabId }, ['from_uid', 'to_uid']),
    annotate('Drag Element', false, true, false, false)),
  tool('take_screenshot', 'Capture the page as a PNG image: viewport by default, full page, or a single element.',
    object({ tabId, fullPage: boolean('Capture the full scrollable page'), uid }),
    annotate('Take Screenshot', true, false, true, false)),
  tool('evaluate_script', 'Evaluate a JavaScript function or expression in the page and return its JSON value.',
    object({ function: string('JavaScript function (called with args) or bare expression'), args: { type: 'array', description: 'JSON arguments passed when function is callable' }, tabId }, ['function']),
    annotate('Evaluate Script', false, true, false, true)),
  tool('upload_file', 'Set the file of a file input, from a local path or inline base64 content.',
    object({ uid, filePath: string('Absolute path to a local file'), file: { type: 'object', description: 'Inline file content', properties: { filename: { type: 'string' }, mimeType: { type: 'string' }, contentBase64: { type: 'string' } }, required: ['filename', 'mimeType', 'contentBase64'] }, tabId }, ['uid']),
    annotate('Upload File', false, false, true, true)),
  tool('resize_page', 'Resize the page viewport to the given dimensions.',
    object({ width: number('Viewport width in CSS pixels'), height: number('Viewport height in CSS pixels'), tabId }, ['width', 'height']),
    annotate('Resize Page', false, false, true, false)),
];

/** Local-only conveniences kept beyond the reviewed contract. */
export const EXTRA_TOOLS: ContractTool[] = [
  tool('get_text', 'Read visible page text.',
    object({ tabId: number('Chrome tab ID') }),
    annotate('Get Page Text', true, false, true, false)),
  tool('evaluate', 'Evaluate JavaScript in the page and return its value.',
    object({ expression: string('JavaScript expression'), tabId: number('Chrome tab ID') }, ['expression']),
    annotate('Evaluate JavaScript', false, true, false, true)),
];

export const ALL_TOOLS: ContractTool[] = [...CONTRACT_TOOLS, ...EXTRA_TOOLS];
export const CONTRACT_TOOL_NAMES: string[] = CONTRACT_TOOLS.map((t) => t.name);

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Compare what an extension advertises against the reviewed contract.
 * Returns human-readable problems; an empty array means the full contract
 * (and nothing unknown) is being served.
 */
export function validateExtensionTools(advertised: ToolDefinition[]): string[] {
  const problems: string[] = [];
  const byName = new Map(advertised.map((t) => [t.name, t]));
  for (const expected of CONTRACT_TOOLS) {
    const actual = byName.get(expected.name);
    if (!actual) {
      problems.push(`missing tool: ${expected.name}`);
      continue;
    }
    if (stableStringify(actual.inputSchema) !== stableStringify(expected.inputSchema)) {
      problems.push(`tool ${expected.name}: inputSchema differs from the reviewed contract`);
    }
  }
  for (const actual of advertised) {
    if (!BY_NAME.has(actual.name)) problems.push(`unexpected tool: ${actual.name}`);
  }
  return problems;
}

/** Merge title + annotations onto extension-provided definitions for tools/list. */
export function enrichTools(tools: ToolDefinition[]): Array<ToolDefinition & Partial<Pick<ContractTool, 'title' | 'annotations'>>> {
  return tools.map((toolDef) => {
    const known = BY_NAME.get(toolDef.name);
    if (!known) return toolDef;
    return { ...toolDef, title: known.title, annotations: known.annotations };
  });
}

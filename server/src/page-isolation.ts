/**
 * Page isolation for a browser that several jobs use at the same time.
 *
 * With BROWSER_MCP_PAGE_ISOLATION=window the connector gives every new page
 * its own Chrome window, never brings a window to the front, and refuses the
 * page tools that would otherwise fall back to "the active tab": in a shared
 * browser the active tab is usually another job's page. The Vibe 0.3.6 wire
 * contract is unchanged; only the public descriptions and the connector's
 * own checks differ.
 */
import type { ToolDefinition } from './contract.js';

export type PageIsolation = 'none' | 'window';

/** Capability an extension advertises in its hello once it can honour window mode. */
export const WINDOW_ISOLATION_CAPABILITY = 'page-isolation-window';

/** Tools whose page id is optional in the contract and default to the active tab. */
export const PAGE_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  'take_snapshot',
  'evaluate_script',
  'wait_for_url',
  'wait_for_network_idle',
  'wait_for_condition',
  'get_text',
  'evaluate',
]);

/** Tools whose window-mode behaviour needs an extension that advertises the capability. */
export const WINDOW_MODE_TOOLS: ReadonlySet<string> = new Set(['new_page', 'switch_to_page']);

export const MISSING_PAGE_MESSAGE =
  'This browser is shared by several jobs at once: pass the page ID of your own page '
  + '(pageId or tabId, the Tab ID that new_page returned). The call was not run.';

export const OLD_EXTENSION_MESSAGE =
  'The Browser MCP extension in this browser is older than its connector and cannot open '
  + 'a window per job. Reload the Local Browser MCP extension in chrome://extensions, then retry. '
  + 'The call was not run.';

export function parsePageIsolation(raw: string | undefined): PageIsolation {
  const value = (raw ?? '').trim();
  if (value === '' || value === 'none') return 'none';
  if (value === 'window') return 'window';
  throw new Error(`BROWSER_MCP_PAGE_ISOLATION must be "window" or empty, got ${JSON.stringify(value)}`);
}

const isPageId = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/** Throw before forwarding when a window-mode call names no page. */
export function requireOwnPage(mode: PageIsolation, name: string, args: Record<string, unknown>): void {
  if (mode !== 'window' || !PAGE_REQUIRED_TOOLS.has(name)) return;
  if (isPageId(args.pageId) || isPageId(args.tabId)) return;
  throw new Error(MISSING_PAGE_MESSAGE);
}

const NEW_PAGE_DESCRIPTION =
  'Open a new page and optionally navigate to a URL. In this browser every new page opens in '
  + 'its own window, and the window is never brought to the front, so several jobs can work at '
  + 'once. Pass the returned Tab ID as pageId/tabId on every later call, and close the page when '
  + 'you are done.';

const SWITCH_DESCRIPTION =
  'Make a page the active page of its own window, without bringing the window to the front. '
  + 'Pages that have their own window stay live, so this is rarely needed.';

const OWN_PAGE_ID = 'Required in this shared browser: the Tab ID of your own page.';

function withPropertyDescription(
  schema: Record<string, unknown>,
  updates: Record<string, string>,
): Record<string, unknown> {
  const properties = { ...((schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {}) };
  for (const [key, description] of Object.entries(updates)) {
    if (properties[key]) properties[key] = { ...properties[key], description };
  }
  return { ...schema, properties };
}

/** Public descriptions that tell agents how window mode behaves. */
export function describeWindowMode<T extends ToolDefinition>(tool: T): T {
  if (tool.name === 'new_page') {
    return {
      ...tool,
      description: NEW_PAGE_DESCRIPTION,
      inputSchema: withPropertyDescription(tool.inputSchema, {
        focus: 'Ignored in this browser: a new page\'s window is never brought to the front.',
      }),
    };
  }
  if (tool.name === 'switch_to_page') return { ...tool, description: SWITCH_DESCRIPTION };
  if (PAGE_REQUIRED_TOOLS.has(tool.name)) {
    return {
      ...tool,
      inputSchema: withPropertyDescription(tool.inputSchema, { pageId: OWN_PAGE_ID, tabId: OWN_PAGE_ID }),
    };
  }
  return tool;
}

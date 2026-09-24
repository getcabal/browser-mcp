import { ALL_TOOLS } from './contract.js';

const tools = new Set(ALL_TOOLS.map(tool => tool.name));
const profiles = new Set(['default', 'agent-ops', 'brain', 'chief-of-staff', 'feedback',
  'finance', 'hr', 'm-and-a', 'marketing', 'ops', 'pocket-tech', 'reports', 'security']);

/** Only fixed categories leave this function; never persist browser error text. */
export function errorCategory(value: unknown): string {
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  const categories: Array<[RegExp, string]> = [
    [/cannot access a chrome-extension:|different extension/i, 'cross_extension_page'],
    [/another debugger|already attached/i, 'debugger_conflict'],
    [/not attached|detached|target closed|session closed/i, 'debugger_detached'],
    [/cannot find context|execution context.*destroyed|inspected target navigated/i, 'execution_context_lost'],
    [/could not find node|no node with given|could not find object|could not resolve element/i, 'dom_target_missing'],
    [/element.*stale|unknown uid|no snapshot for tab/i, 'stale_element'],
    [/no active tab|no tab with id|page.*closed/i, 'page_missing'],
    [/cannot access contents|restricted\/system page|cannot attach to this target/i, 'restricted_page'],
    [/timed out|timeout/i, 'browser_timeout'],
    [/protected.*refused|protected.*unavailable|protected.*not|paste.*refused/i, 'protected_entry_refused'],
    [/extension.*disconnect|extension.*not connected/i, 'extension_disconnected'],
    [/malformed.*result/i, 'malformed_response'],
    [/typeerror|referenceerror|syntaxerror|script threw|uncaught/i, 'javascript_exception'],
  ];
  return categories.find(([pattern]) => pattern.test(message))?.[1] ?? 'other';
}

export function recordToolFailure(profile: unknown, name: unknown, error: unknown,
  write: (line: string) => void = console.error): void {
  write(JSON.stringify({ event: 'browser_tool_failure', at: new Date().toISOString(),
    profile: typeof profile === 'string' && profiles.has(profile) ? profile : 'other',
    tool: typeof name === 'string' && tools.has(name) ? name : 'other',
    category: errorCategory(error) }));
}

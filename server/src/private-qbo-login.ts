import type { ProtectedPasteBridge, ProtectedPasteState } from './protected-paste.js';

export async function privateQboPages(bridge: ProtectedPasteBridge, profile: string | null): Promise<string> {
  if (profile !== 'finance') return 'ERROR\n';
  let result;
  try {
    result = await bridge.callTool('list_pages', {}, 10_000);
    if (result.isError) return 'ERROR\n';
    const ids: number[] = [];
    for (const block of result.content) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      for (const match of block.text.matchAll(/^Page ([1-9][0-9]*)(?: \[ACTIVE\])?: .* - (https:\/\/[^\r\n ]+)$/gm)) {
        const url = new URL(match[2]);
        const id = Number(match[1]);
        if (Number.isSafeInteger(id) && ['accounts.intuit.com', 'appcenter.intuit.com', 'qbo.intuit.com'].includes(url.hostname)) ids.push(id);
      }
    }
    return JSON.stringify({ pages: [...new Set(ids)] }) + '\n';
  } catch { return 'ERROR\n'; }
  finally { if (result) for (const block of result.content) if (block.type === 'text') block.text = ''; }
}

/** Exact Intuit recipient, current empty field, one-use profile-local value.
 * No username, password, OAuth URL, browser result or exception is returned.
 */
export function privateQboPasteExpression(fieldKind: 'username' | 'password', value: string): string {
  return `(() => {
    if (location.protocol !== 'https:' || location.hostname !== 'accounts.intuit.com' || !/^\\/app\\/sign-in(?:\\/|$)/.test(location.pathname)) return {pasted:false,reason:"recipient"};
    const field = document.activeElement;
    if (!(field instanceof HTMLInputElement) || field.disabled || field.readOnly || field.value !== '' || field.getClientRects().length === 0) return {pasted:false,reason:"field"};
    const labelled = (field.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' ');
    const label = [...(field.labels || [])].map(el => el.textContent || '').join(' ') + ' ' + (field.getAttribute('aria-label') || '') + ' ' + labelled;
    const kind = ${JSON.stringify(fieldKind)};
    if (kind === 'username' && (!['text','email'].includes(field.type) || !/email|user\\s*id/i.test(label))) return {pasted:false,reason:"label"};
    if (kind === 'password' && (field.type !== 'password' || !/password/i.test(label) || field.autocomplete === 'new-password')) return {pasted:false,reason:"label"};
    const value = ${JSON.stringify(value)};
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return {pasted:false,reason:"setter"};
    setter.call(field, value);
    field.dispatchEvent(new Event('input', {bubbles:true}));
    field.dispatchEvent(new Event('change', {bubbles:true}));
    return {pasted:field.value === value};
  })()`;
}

export async function privateQboPaste(
  bridge: ProtectedPasteBridge, profile: string | null, state: ProtectedPasteState,
  pageId: number, fieldKind: 'username' | 'password',
): Promise<string> {
  let bytes: Buffer | null = null;
  let result;
  try {
    if (profile !== 'finance' || !Number.isSafeInteger(pageId) || pageId <= 0 || !['username', 'password'].includes(fieldKind)) return 'ERROR\n';
    bytes = state.takeCredential();
    if (!bytes?.length) return 'ERROR staged\n';
    const value = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    result = await bridge.callTool('evaluate', {
      tabId: pageId, expression: privateQboPasteExpression(fieldKind, value),
    }, 15_000);
    if (result.isError) return 'ERROR bridge\n';
    if (result.content.length !== 1 || result.content[0].type !== 'text') return 'ERROR\n';
    const receipt = JSON.parse(result.content[0].text as string);
    if (receipt && Object.keys(receipt).length === 1 && receipt.pasted === true) return 'PASTED\n';
    return receipt?.pasted === false && ['recipient', 'field', 'label', 'setter'].includes(receipt.reason) ? `ERROR ${receipt.reason}\n` : 'ERROR\n';
  } catch { return 'ERROR\n'; }
  finally {
    bytes?.fill(0);
    state.clearCredential();
    if (result) for (const block of result.content) if (block.type === 'text') block.text = '';
  }
}

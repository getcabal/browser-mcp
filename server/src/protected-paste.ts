import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { ToolResult } from './bridge.js';

const CLIPBOARD_MAX_BYTES = 65_536;
const CLIPBOARD_TIMEOUT_MS = 5_000;
const PROTECTED_PASTE_TIMEOUT_MS = 15_000;
const PROTECTED_SMS_TTL_MS = 180_000;
const CREDENTIAL_PROTOCOL = Buffer.from('HERMES-CREDENTIAL/1', 'ascii');

export type ProtectedSmsProvider = 'servicetitan' | 'paylocity' | 'chase';

export type ClipboardReader = () => Promise<Buffer>;
export type ClipboardClearer = () => Promise<void>;

export interface ProtectedPasteBridge {
  callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ToolResult>;
}

export class ProtectedPasteState {
  private credential: Buffer | null = null;
  private smsCode: Buffer | null = null;
  private smsProvider: ProtectedSmsProvider | null = null;
  private smsTimer: NodeJS.Timeout | null = null;
  private smsBaseline: { tabId: number; provider: ProtectedSmsProvider; at: number; hashes: Set<string> } | null = null;

  armServiceTitanSms(tabId: number, codes: string[], provider: ProtectedSmsProvider = 'servicetitan'): void {
    this.clear();
    this.smsBaseline = { tabId, provider, at: Date.now(), hashes: new Set(codes.map(code => createHash('sha256').update(code).digest('hex'))) };
  }

  selectFreshServiceTitanSms(tabId: number, codes: string[], provider: ProtectedSmsProvider = 'servicetitan'): string | null {
    const baseline = this.smsBaseline;
    if (!baseline || baseline.tabId !== tabId || baseline.provider !== provider || Date.now() - baseline.at > 120_000) {
      this.clear();
      throw new Error('Protected SMS capture requires a current matching request baseline');
    }
    const fresh = [...new Set(codes)].filter(code => !baseline.hashes.has(createHash('sha256').update(code).digest('hex')));
    if (fresh.length > 1) throw new Error('Protected SMS capture found ambiguous new provider codes');
    return fresh[0] ?? null;
  }

  storeSmsCode(value: Buffer, provider: ProtectedSmsProvider = 'servicetitan'): void {
    this.clear();
    this.smsCode = Buffer.from(value);
    this.smsProvider = provider;
    this.smsTimer = setTimeout(() => this.clear(), PROTECTED_SMS_TTL_MS);
    this.smsTimer.unref();
  }

  storeCredential(value: Buffer): void {
    this.clearCredential();
    this.credential = Buffer.from(value);
  }

  takeCredential(): Buffer | null {
    if (!this.credential) return null;
    const value = this.credential;
    this.credential = null;
    return value;
  }

  clearCredential(): void {
    if (this.credential) this.credential.fill(0);
    this.credential = null;
  }

  takeSmsCode(): { value: Buffer; provider: ProtectedSmsProvider } | null {
    if (!this.smsCode || !this.smsProvider) return null;
    const value = { value: this.smsCode, provider: this.smsProvider };
    this.smsCode = null;
    this.smsProvider = null;
    if (this.smsTimer) clearTimeout(this.smsTimer);
    this.smsTimer = null;
    return value;
  }

  clear(preserveBaseline = false): void {
    if (!preserveBaseline) this.smsBaseline = null;
    this.clearCredential();
    if (this.smsTimer) clearTimeout(this.smsTimer);
    this.smsTimer = null;
    if (this.smsCode) this.smsCode.fill(0);
    this.smsCode = null;
    this.smsProvider = null;
  }
}

export class ProfileCredentialBroker {
  private server: NetServer | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly state: ProtectedPasteState,
    private readonly privateNavigate?: (pageId: number) => Promise<string>,
    private readonly privateQboPages?: () => Promise<string>,
    private readonly privateQboPaste?: (pageId: number, field: 'username' | 'password') => Promise<string>,
  ) {}

  private handleConnection(client: Socket): void {
    const chunks: Buffer[] = [];
    let total = 0;
    let finished = false;
    const clearChunks = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const finish = (response: Buffer): void => {
      if (finished) return;
      finished = true;
      clearChunks();
      client.end(response);
    };
    client.setTimeout(CLIPBOARD_TIMEOUT_MS, () => finish(Buffer.from('ERROR\n')));
    client.on('error', () => {
      finished = true;
      clearChunks();
      client.destroy();
    });
    client.on('data', (chunk: Buffer) => {
      if (finished) {
        chunk.fill(0);
        return;
      }
      total += chunk.length;
      if (total > CLIPBOARD_MAX_BYTES + 64) {
        chunk.fill(0);
        finish(Buffer.from('ERROR\n'));
        return;
      }
      chunks.push(chunk);
    });
    client.on('end', async () => {
      if (finished) return;
      const request = Buffer.concat(chunks, total);
      clearChunks();
      try {
        if (request.equals(Buffer.from('QBO-PAGES/1\n')) && this.privateQboPages) {
          client.setTimeout(15_000);
          let receipt = 'ERROR\n';
          try { receipt = await this.privateQboPages(); } catch { /* private result never escapes */ }
          finish(Buffer.from(receipt, 'utf8'));
          return;
        }
        const qboPaste = request.subarray(0, 12).equals(Buffer.from('QBO-PASTE/1 '))
          ? /^QBO-PASTE\/1 ([1-9][0-9]{0,15}) (username|password)\n$/.exec(request.toString('ascii')) : null;
        if (qboPaste && this.privateQboPaste) {
          client.setTimeout(20_000);
          let receipt = 'ERROR\n';
          try { receipt = await this.privateQboPaste(Number(qboPaste[1]), qboPaste[2] as 'username' | 'password'); } catch { /* no credential errors */ }
          finish(Buffer.from(/^(?:PASTED|ERROR (?:staged|bridge|recipient|field|type|label|setter))\n$/.test(receipt) ? receipt : 'ERROR\n', 'ascii'));
          return;
        }
        const navigation = request.subarray(0, 15).equals(Buffer.from('QBO-NAVIGATE/1 '))
          ? /^QBO-NAVIGATE\/1 ([1-9][0-9]{0,15})\n$/.exec(request.toString('ascii')) : null;
        if (navigation && this.privateNavigate) {
          client.setTimeout(35_000);
          let receipt = 'ERROR\n';
          try { receipt = await this.privateNavigate(Number(navigation[1])); } catch { /* never expose URL errors */ }
          finish(Buffer.from(receipt === 'NAVIGATED\n' ? receipt : 'ERROR\n', 'ascii'));
          return;
        }
        if (request.equals(Buffer.from('CLEAR\n', 'ascii'))) {
          this.state.clearCredential();
          finish(Buffer.from('CLEARED\n', 'ascii'));
          return;
        }
        const separator = request.indexOf(0x0a);
        if (separator <= 0) {
          finish(Buffer.from('ERROR\n', 'ascii'));
          return;
        }
        const header = request.subarray(0, separator);
        const space = header.lastIndexOf(0x20);
        if (space <= 0 || !header.subarray(0, space).equals(CREDENTIAL_PROTOCOL)) {
          finish(Buffer.from('ERROR\n', 'ascii'));
          return;
        }
        const lengthText = header.subarray(space + 1).toString('ascii');
        if (!/^[1-9][0-9]{0,4}$/.test(lengthText)) {
          finish(Buffer.from('ERROR\n', 'ascii'));
          return;
        }
        const declaredLength = Number(lengthText);
        const value = request.subarray(separator + 1);
        if (declaredLength !== value.length || declaredLength > CLIPBOARD_MAX_BYTES) {
          finish(Buffer.from('ERROR\n', 'ascii'));
          return;
        }
        this.state.storeCredential(value);
        finish(Buffer.from('STAGED\n', 'ascii'));
      } finally {
        request.fill(0);
      }
    });
  }

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.socketPath), 0o700);
    try {
      await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const server = createServer({ allowHalfOpen: true }, (client) => this.handleConnection(client));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.socketPath);
    });
    await chmod(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function normalizedChord(args: Record<string, unknown>): string {
  return typeof args.keys === 'string'
    ? args.keys.replace(/\s+/g, '').toLowerCase()
    : '';
}

export function isProtectedPasteCall(
  name: string,
  args: Record<string, unknown>,
): boolean {
  if (name !== 'press_key') return false;
  const chord = normalizedChord(args);
  return chord === 'meta+v' || chord === 'cmd+v' || chord === 'command+v';
}

export function isProtectedSmsCaptureCall(
  name: string,
  args: Record<string, unknown>,
): boolean {
  if (name !== 'press_key' || args.index !== undefined) return false;
  return protectedSmsProvider(args) !== null;
}

export function protectedSmsProvider(
  args: Record<string, unknown>,
): ProtectedSmsProvider | null {
  const chord = normalizedChord(args);
  if (['meta', 'cmd', 'command'].some(key => ['c', 'b', 's'].some(letter => chord === `${key}+shift+${letter}`))) {
    return 'servicetitan';
  }
  if (['meta', 'cmd', 'command'].some(key => ['shift+p', 'alt+p', 'shift+alt+p'].some(tail => chord === `${key}+${tail}`))) {
    return 'paylocity';
  }
  if (['meta', 'cmd', 'command'].some(key => ['shift+h', 'alt+h', 'shift+alt+h'].some(tail => chord === `${key}+${tail}`))) {
    return 'chase';
  }
  return null;
}

export function readSystemClipboard(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/pbpaste', [], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        HOME: process.env.HOME ?? '',
        LOGNAME: process.env.LOGNAME ?? '',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        USER: process.env.USER ?? '',
      },
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    const clearChunks = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const fail = () => {
      if (rejected) return;
      rejected = true;
      clearChunks();
      reject(new Error('Protected clipboard paste is unavailable'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail();
    }, CLIPBOARD_TIMEOUT_MS);

    child.on('error', () => {
      clearTimeout(timer);
      fail();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (rejected) {
        chunk.fill(0);
        return;
      }
      total += chunk.length;
      if (total > CLIPBOARD_MAX_BYTES) {
        chunk.fill(0);
        child.kill('SIGKILL');
        fail();
        return;
      }
      chunks.push(chunk);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (rejected) return;
      if (code !== 0 || total === 0) {
        fail();
        return;
      }
      const value = Buffer.concat(chunks, total);
      clearChunks();
      resolve(value);
    });
  });
}

export function clearSystemClipboard(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/pbcopy', [], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        HOME: process.env.HOME ?? '',
        LOGNAME: process.env.LOGNAME ?? '',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        USER: process.env.USER ?? '',
      },
    });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) resolve();
      else reject(new Error('Protected clipboard paste could not clear the system clipboard'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, CLIPBOARD_TIMEOUT_MS);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
    child.stdin.end();
  });
}

function protectedSmsCaptureExpression(provider: ProtectedSmsProvider, baseline = false): string {
  const providerLiteral = JSON.stringify(provider);
  return `(() => {
    if (location.protocol !== 'https:' || location.hostname !== 'voice.google.com' || !/^\\/u\\/[0-9]+\\/messages\\/?$/.test(location.pathname)) {
      throw new Error('Protected SMS capture requires the verified Google Voice messages page');
    }
    // The MCP new-page primitive intentionally opens temporary pages in the
    // background. Exact tab binding plus host, path, and identity validation
    // are the security boundary; requiring foreground visibility makes the
    // normal protected-transfer workflow fail while the screen is locked.
    const approvedIdentity = 'ocuser@example.com';
    const labels = Array.from(document.querySelectorAll('a[role=button][aria-label]'))
      .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
      .map(element => (element.getAttribute('aria-label') || '').trim())
      .filter(label => /^Google Account\\s*:/i.test(label));
    const identities = new Set(labels.flatMap(label => label.match(/[A-Z0-9.!#$%&'*+/=?^_\`{|}~-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi) || []).map(value => value.toLowerCase()));
    const identityPresent = identities.size === 1 && identities.has(approvedIdentity);
    if (!identityPresent) throw new Error('Protected SMS capture found the wrong Google Voice identity');
    const elements = Array.from(document.querySelectorAll('body *'));
    if (elements.length === 0 || elements.length > 20000) {
      throw new Error('Protected SMS capture could not inspect the bounded page');
    }
    const provider = ${providerLiteral};
    const pattern = provider === 'servicetitan'
      ? /(?:service[\\s_-]*titan).{0,240}?\\b([0-9]{6})\\b|\\b([0-9]{6})\\b.{0,240}?(?:service[\\s_-]*titan)/is
      : provider === 'paylocity'
        ? /(?:paylocity).{0,240}?\\b([0-9]{5})\\b|\\b([0-9]{5})\\b.{0,240}?(?:paylocity)/is
        : /(?:chase).{0,240}?\\b([0-9]{8})\\b|\\b([0-9]{8})\\b.{0,240}?(?:chase)/is;
    const candidates = [];
    for (const element of elements) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) continue;
      const texts = element.children.length === 0
        ? [element.textContent || '', element.getAttribute('aria-label') || '']
        : [element.getAttribute('aria-label') || ''];
      for (const text of new Set(texts)) {
        if (!text || text.length > 1024) continue;
        const match = text.match(pattern);
        if (match) candidates.push({ code: match[1] || match[2], x: rect.left, y: rect.top });
      }
    }
    if (${baseline}) return { codes: [...new Set(candidates.map(candidate => candidate.code))] };
    if (candidates.length === 0) throw new Error('No correlated provider SMS code was visible');
    candidates.sort((a, b) => b.x - a.x || b.y - a.y);
    const best = candidates[0];
    if (candidates.some((candidate) => candidate.x === best.x && candidate.y === best.y && candidate.code !== best.code)) {
      throw new Error('The newest visible provider SMS code was ambiguous');
    }
    return { code: best.code };
  })()`;
}

function textResult(result: ToolResult): string {
  const blocks = result.content.filter(
    (block) => block.type === 'text' && typeof block.text === 'string',
  );
  if (blocks.length !== 1) throw new Error('Protected SMS capture returned an invalid result');
  return String(blocks[0].text);
}

function scrubTextResult(result: ToolResult): void {
  for (const block of result.content) {
    if (block.type === 'text' && typeof block.text === 'string') block.text = '';
  }
}

export async function captureProtectedServiceTitanSms(
  bridge: ProtectedPasteBridge,
  args: Record<string, unknown>,
  state: ProtectedPasteState,
): Promise<ToolResult> {
  const tabId = args.tabId;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId <= 0) {
    throw new Error('Protected SMS capture requires an exact tab ID');
  }
  const provider = protectedSmsProvider(args);
  if (!provider) throw new Error('Protected SMS capture requires an approved provider chord');
  const chord = normalizedChord(args);
  const baseline = chord.endsWith('+shift+b') || /^(meta|cmd|command)\+alt\+[ph]$/.test(chord);
  const fresh = chord.endsWith('+shift+s') || /\+shift\+alt\+[ph]$/.test(chord);
  const providerName = provider === 'servicetitan' ? 'ServiceTitan' : provider === 'paylocity' ? 'Paylocity' : 'Chase';
  const expectedLength = provider === 'servicetitan' ? 6 : provider === 'paylocity' ? 5 : 8;
  state.clear(fresh);
  const result = await bridge.callTool(
    'evaluate',
    { tabId, expression: protectedSmsCaptureExpression(provider, baseline || fresh) },
    PROTECTED_PASTE_TIMEOUT_MS,
  );
  try {
    if (result.isError) {
      if (fresh && textResult(result).includes('No correlated provider SMS code was visible')) {
        return { content: [{ type: 'text', text: 'Waiting for a new provider SMS code' }] };
      }
      throw new Error('Protected SMS capture was refused');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(textResult(result));
    } catch {
      throw new Error('Protected SMS capture returned an invalid result');
    }
    const record = typeof parsed === 'object' && parsed !== null
      ? parsed as Record<string, unknown>
      : null;
    if (baseline) {
      const codes = record && Object.keys(record).length === 1 ? record.codes : null;
      if (!Array.isArray(codes) || codes.length > 2000 || !codes.every(code => typeof code === 'string' && new RegExp(`^[0-9]{${expectedLength}}$`).test(code))) {
        throw new Error('Protected SMS baseline returned an invalid result');
      }
      state.armServiceTitanSms(tabId, codes, provider);
      return { content: [{ type: 'text', text: `${providerName} SMS baseline armed` }] };
    }
    let code = record && Object.keys(record).length === 1 ? record.code : null;
    if (fresh) {
      const codes = record && Object.keys(record).length === 1 ? record.codes : null;
      if (!Array.isArray(codes) || codes.length > 2000 || !codes.every(value => typeof value === 'string' && new RegExp(`^[0-9]{${expectedLength}}$`).test(value))) {
        throw new Error('Protected SMS capture returned an invalid result');
      }
      code = state.selectFreshServiceTitanSms(tabId, codes, provider);
      if (code === null) return { content: [{ type: 'text', text: 'Waiting for a new provider SMS code' }] };
    }
    if (typeof code !== 'string' || !new RegExp(`^[0-9]{${expectedLength}}$`).test(code)) {
      throw new Error('Protected SMS capture returned an invalid result');
    }
    const bytes = Buffer.from(code, 'ascii');
    try {
      state.storeSmsCode(bytes, provider);
    } finally {
      bytes.fill(0);
    }
    return {
      content: [{ type: 'text', text: fresh ? `${providerName} fresh SMS captured` : `Pressed ${String(args.keys)}` }],
    };
  } finally {
    scrubTextResult(result);
  }
}

function protectedSmsTargetExpression(
  provider: ProtectedSmsProvider,
  populated: boolean,
): string {
  const providerLiteral = JSON.stringify(provider);
  return `(() => {
    let field = document.activeElement;
    while (field) {
      const next = field.shadowRoot?.activeElement
        || (field.tagName === 'IFRAME' && field.contentDocument?.activeElement);
      if (!next) break;
      field = next;
    }
    const view = field?.ownerDocument.defaultView;
    if (!view || view.location.origin !== location.origin) throw new Error('Protected SMS target origin was refused');
    const provider = ${providerLiteral};
    const hostname = location.hostname.toLowerCase();
    const label = field instanceof view.HTMLInputElement
      ? [field.getAttribute('aria-label'), field.name, field.id, field.placeholder].filter(Boolean).join(' ')
      : '';
    const exactTarget = provider === 'servicetitan'
      ? hostname === 'login.servicetitan.com' && location.pathname.startsWith('/mfa') && field instanceof view.HTMLInputElement && field.name === 'sms-code'
      : provider === 'paylocity'
        ? (hostname === 'paylocity.com' || hostname.endsWith('.paylocity.com')) && field instanceof view.HTMLInputElement && /(?:one[- ]?time.*passcode|passcode|verification.*code)/i.test(label)
        : (hostname === 'chase.com' || hostname.endsWith('.chase.com')) && field instanceof view.HTMLInputElement && /(?:identification.*code|verification.*code|one[- ]?time.*code|code)/i.test(label);
    if (!exactTarget) {
      throw new Error('Protected SMS target is not the exact provider MFA field');
    }
    if (field.disabled || field.readOnly) {
      throw new Error('Protected SMS target is not editable');
    }
    const allowed = new Set(['text', 'tel', 'number']);
    if (!allowed.has(String(field.type || 'text').toLowerCase())) {
      throw new Error('Protected SMS target input type is unsupported');
    }
    for (let element = field; element; element = element.ownerDocument.defaultView.frameElement) {
      const elementView = element.ownerDocument.defaultView;
      if (elementView.location.origin !== location.origin) throw new Error('Protected SMS target origin was refused');
      const style = elementView.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
        throw new Error('Protected SMS target is not visible');
      }
    }
    const expected = provider === 'servicetitan' ? /^\\d{6}$/ : provider === 'paylocity' ? /^\\d{5}$/ : /^\\d{8}$/;
    if (${populated ? "!expected.test(field.value)" : "field.value !== ''"}) {
      throw new Error('Protected SMS target has the wrong value state');
    }
    return { ${populated ? 'pasted' : 'ready'}: true };
  })()`;
}

function requirePrivateFlag(
  result: ToolResult,
  key: 'ready' | 'pasted',
  errorMessage: string,
): void {
  if (result.isError) throw new Error(errorMessage);
  let parsed: unknown;
  try {
    parsed = JSON.parse(textResult(result));
  } catch {
    throw new Error(errorMessage);
  }
  const record = typeof parsed === 'object' && parsed !== null
    ? parsed as Record<string, unknown>
    : null;
  if (!record || Object.keys(record).length !== 1 || record[key] !== true) {
    throw new Error(errorMessage);
  }
}

// Only fixed, broker-authored failures may leave the private SMS checks.
// A click can finish before the provider's focus/render handlers settle.
function smsTargetFailure(result: ToolResult): string {
  if (!result.isError || result.content.length !== 1 || result.content[0].type !== 'text'
    || typeof result.content[0].text !== 'string') {
    return 'unconfirmed_target';
  }
  const line = result.content[0].text.split('\n', 1)[0].replace(/^(?:Error: ){1,2}/, '');
  const known: Record<string, string> = {
    'Protected SMS target origin was refused': 'target_origin',
    'Protected SMS target is not the exact provider MFA field': 'target_not_focused',
    'Protected SMS target is not editable': 'target_not_editable',
    'Protected SMS target input type is unsupported': 'target_type',
    'Protected SMS target is not visible': 'target_not_visible',
    'Protected SMS target has the wrong value state': 'target_not_empty',
  };
  return known[line] ?? 'unconfirmed_target';
}

// Report only fixed categories, never renderer errors, field contents or IDs.
// These failures happen before assignment; the caller can repair the page and
// acquire a fresh snapshot instead of treating a stale target as bad credentials.
function indexedPasteFailure(result: ToolResult | undefined): string {
  if (!result?.isError || result.content.length !== 1 || result.content[0].type !== 'text'
    || typeof result.content[0].text !== 'string') {
    return 'unconfirmed_delivery';
  }
  const firstLine = result.content[0].text.split('\n', 1)[0];
  if (/^Error: Element @e[1-9]\d* is stale; call take_snapshot again$/.test(firstLine)) return 'stale_target';
  if (/^Error: (?:No snapshot for tab [1-9]\d*; call take_snapshot first|Unknown uid @e[1-9]\d* for tab [1-9]\d*; call take_snapshot again)$/.test(firstLine)) return 'snapshot_required';
  const fixed: Record<string, string> = {
    'Error: Error: Protected paste target is not editable': 'target_not_editable',
    'Error: Error: Protected paste target is not visible': 'target_not_visible',
    'Error: Error: Protected paste target could not be focused': 'target_not_focused',
    'Error: Protected paste target is not editable': 'target_not_editable',
    'Error: Protected paste target is not visible': 'target_not_visible',
    'Error: Protected paste target could not be focused': 'target_not_focused',
  };
  return fixed[firstLine] ?? 'unconfirmed_delivery';
}

function protectedPasteExpression(value: string, requireEmpty = true): string {
  const literal = JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `(() => {
    const field = document.activeElement;
    const supported = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement;
    if (!supported || field.disabled || field.readOnly${requireEmpty ? " || field.value !== ''" : ''}) {
      throw new Error('Protected paste target is not one focused editable field with the required value state');
    }
    if (field instanceof HTMLInputElement) {
      const allowed = new Set(['text', 'email', 'password', 'search', 'tel', 'url']);
      if (!allowed.has(String(field.type || 'text').toLowerCase())) {
        throw new Error('Protected paste target input type is unsupported');
      }
    }
    const style = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
      throw new Error('Protected paste target is not visible');
    }
    const prototype = field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (typeof setter !== 'function') throw new Error('Protected paste setter is unavailable');
    setter.call(field, ${literal});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    if (field.value.length === 0) throw new Error('Protected paste did not populate the target');
    return { pasted: true };
  })()`;
}

function protectedPastePoint(
  args: Record<string, unknown>,
  indexedTarget: unknown,
): { xRatio: number; yRatio: number } | null {
  const hasX = args.xRatio !== undefined;
  const hasY = args.yRatio !== undefined;
  if (!hasX && !hasY) return null;
  if (!hasX || !hasY) {
    throw new Error('Protected clipboard coordinate paste requires both xRatio and yRatio');
  }
  if (indexedTarget !== undefined) {
    throw new Error('Protected clipboard paste accepts an index or coordinate ratios, not both');
  }
  const xRatio = args.xRatio;
  const yRatio = args.yRatio;
  if (
    typeof xRatio !== 'number'
    || typeof yRatio !== 'number'
    || !Number.isFinite(xRatio)
    || !Number.isFinite(yRatio)
    || xRatio <= 0
    || xRatio >= 1
    || yRatio <= 0
    || yRatio >= 1
  ) {
    throw new Error('Protected clipboard coordinate ratios must be finite numbers strictly between 0 and 1');
  }
  return { xRatio, yRatio };
}

export async function deliverProtectedClipboardPaste(
  bridge: ProtectedPasteBridge,
  args: Record<string, unknown>,
  clipboardReader: ClipboardReader | null = readSystemClipboard,
  state?: ProtectedPasteState,
  clipboardClearer: ClipboardClearer | null = clipboardReader === readSystemClipboard
    ? clearSystemClipboard
    : null,
): Promise<ToolResult> {
  const tabId = args.tabId;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId <= 0) {
    throw new Error('Protected clipboard paste requires an exact tab ID');
  }
  const indexedTarget = args.index;
  if (
    indexedTarget !== undefined
    && (
      typeof indexedTarget !== 'number'
      || !Number.isInteger(indexedTarget)
      || indexedTarget <= 0
    )
  ) {
    throw new Error('Protected clipboard paste requires a positive snapshot index');
  }
  const coordinateTarget = protectedPastePoint(args, indexedTarget);
  const sms = state?.takeSmsCode() ?? null;
  const stagedCredential = sms === null ? state?.takeCredential() ?? null : null;
  // Coordinates are an explicit fallback for renderer-opaque credential
  // fields. Require the profile-local, one-use credential broker for this
  // path; never source a coordinate-directed secret from ambient clipboard.
  const bytes = sms?.value
    ?? stagedCredential
    ?? (coordinateTarget === null && clipboardReader ? await clipboardReader() : null);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > CLIPBOARD_MAX_BYTES) {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
    throw new Error('Protected clipboard paste is unavailable');
  }
  try {
    // Clear before field assignment so clipboard lifetime does not depend on a
    // later model turn. The explicit helper clear remains safe and idempotent.
    if (sms === null && stagedCredential === null && clipboardClearer) {
      await clipboardClearer();
    }
    let value: string;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Protected clipboard value is not valid UTF-8');
    }
    if (sms !== null) {
      if (coordinateTarget !== null) {
        throw new Error('Protected SMS paste requires an exact indexed or focused provider field');
      }
      const privateResults: ToolResult[] = [];
      try {
        if (indexedTarget !== undefined) {
          // Focus the exact snapshot node directly. A coordinate click can hit
          // an overlay or a moving form while still returning a click receipt.
          // Home changes only caret position; the empty-value guard below is
          // retained and no character, code or submission is sent here.
          const focused = await bridge.callTool(
            'press_key',
            { tabId, keys: 'Home', index: indexedTarget },
            PROTECTED_PASTE_TIMEOUT_MS,
          );
          privateResults.push(focused);
          if (focused.isError) throw new Error('Protected SMS target could not be focused');
        }
        for (let observation = 0; ; observation += 1) {
          const before = await bridge.callTool(
            'evaluate',
            { tabId, expression: protectedSmsTargetExpression(sms.provider, false) },
            PROTECTED_PASTE_TIMEOUT_MS,
          );
          privateResults.push(before);
          try {
            requirePrivateFlag(before, 'ready', 'Protected SMS target was refused');
            break;
          } catch {
            const reason = smsTargetFailure(before);
            if (observation >= 2 || !['target_not_focused', 'target_not_visible', 'target_not_editable'].includes(reason)) {
              throw new Error(`Protected SMS target was refused (${reason})`);
            }
            // Read-only settling within this one-use delivery, never another
            // click, capture, SMS request, typing attempt or verification submit.
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        const typed = await bridge.callTool(
          'type_text',
          { tabId, text: value },
          PROTECTED_PASTE_TIMEOUT_MS,
        );
        privateResults.push(typed);
        if (typed.isError) throw new Error('Protected SMS typing was refused');

        const after = await bridge.callTool(
          'evaluate',
          { tabId, expression: protectedSmsTargetExpression(sms.provider, true) },
          PROTECTED_PASTE_TIMEOUT_MS,
        );
        privateResults.push(after);
        requirePrivateFlag(after, 'pasted', 'Protected SMS typing did not populate the exact field');
      } finally {
        for (const result of privateResults) scrubTextResult(result);
      }
    } else if (coordinateTarget !== null) {
      // Some bank sign-in renderers expose no DOM or accessibility nodes even
      // though their fields are present in a fresh page screenshot. Keep the
      // focus click and one-use secret typing inside this broker call so the
      // value never crosses the MCP response boundary and the path remains
      // usable in a locked background session.
      const privateResults: ToolResult[] = [];
      try {
        const focused = await bridge.callTool(
          'click_at_ratio',
          { tabId, ...coordinateTarget },
          PROTECTED_PASTE_TIMEOUT_MS,
        ).catch(() => {
          throw new Error('Protected clipboard coordinate target could not be focused (bridge_error)');
        });
        privateResults.push(focused);
        if (focused.isError) {
          // Only fixed categories cross the boundary; classify before finally scrubs.
          const text = focused.content.length === 1 && focused.content[0].type === 'text'
            ? focused.content[0].text : undefined;
          const category = text === 'Error: Unknown tool: click_at_ratio'
            ? 'primitive_unavailable'
            : text === 'Error: click_at_ratio could not resolve the current viewport'
              ? 'viewport_unavailable' : 'extension_error';
          throw new Error(`Protected clipboard coordinate target could not be focused (${category})`);
        }

        const typed = await bridge.callTool(
          'type_text',
          { tabId, text: value },
          PROTECTED_PASTE_TIMEOUT_MS,
        );
        privateResults.push(typed);
        if (typed.isError) throw new Error('Protected clipboard coordinate paste was refused');
      } finally {
        for (const result of privateResults) scrubTextResult(result);
      }
    } else if (indexedTarget !== undefined) {
      // Resolve and focus/replace the exact node in one element-bound call.
      // The private fill result and secret never cross the MCP response boundary.
      let result: ToolResult | undefined;
      let category = 'bridge_error';
      try {
        result = await bridge.callTool(
          'fill',
          { tabId, uid: indexedTarget, value, protectedEntry: true },
          PROTECTED_PASTE_TIMEOUT_MS,
        );
        category = indexedPasteFailure(result);
        requirePrivateFlag(result, 'pasted', 'Protected clipboard paste was refused');
      } catch {
        throw new Error(`Protected clipboard indexed paste was refused (${category})`);
      } finally {
        if (result) scrubTextResult(result);
      }
    } else {
      const result = await bridge.callTool(
        'evaluate',
        { tabId, expression: protectedPasteExpression(value) },
        PROTECTED_PASTE_TIMEOUT_MS,
      );
      if (result.isError) throw new Error('Protected clipboard paste was refused');
    }
    return {
      content: [{ type: 'text', text: `Pressed ${String(args.keys)}` }],
    };
  } finally {
    bytes.fill(0);
  }
}

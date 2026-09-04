import { spawn } from 'node:child_process';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { ToolResult } from './bridge.js';

const CLIPBOARD_MAX_BYTES = 65_536;
const CLIPBOARD_TIMEOUT_MS = 5_000;
const PROTECTED_PASTE_TIMEOUT_MS = 15_000;
const PROTECTED_SMS_TTL_MS = 180_000;
const CREDENTIAL_PROTOCOL = Buffer.from('HERMES-CREDENTIAL/1', 'ascii');

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
  private smsTimer: NodeJS.Timeout | null = null;

  storeSmsCode(value: Buffer): void {
    this.clear();
    this.smsCode = Buffer.from(value);
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

  takeSmsCode(): Buffer | null {
    if (!this.smsCode) return null;
    const value = this.smsCode;
    this.smsCode = null;
    if (this.smsTimer) clearTimeout(this.smsTimer);
    this.smsTimer = null;
    return value;
  }

  clear(): void {
    this.clearCredential();
    if (this.smsTimer) clearTimeout(this.smsTimer);
    this.smsTimer = null;
    if (this.smsCode) this.smsCode.fill(0);
    this.smsCode = null;
  }
}

export class ProfileCredentialBroker {
  private server: NetServer | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly state: ProtectedPasteState,
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
    client.on('end', () => {
      if (finished) return;
      const request = Buffer.concat(chunks, total);
      clearChunks();
      try {
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
    const server = createServer((client) => this.handleConnection(client));
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
  const chord = normalizedChord(args);
  return chord === 'meta+shift+c'
    || chord === 'cmd+shift+c'
    || chord === 'command+shift+c';
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

function protectedSmsCaptureExpression(): string {
  return `(() => {
    if (location.hostname !== 'voice.google.com' || !location.pathname.startsWith('/u/0/messages')) {
      throw new Error('Protected SMS capture requires the verified Google Voice messages page');
    }
    if (document.visibilityState !== 'visible') {
      throw new Error('Protected SMS capture requires the active Google Voice tab');
    }
    const approvedIdentity = 'ocuser@qualitechmgmt.com';
    const identityPresent = Array.from(document.querySelectorAll('[aria-label],[data-tooltip]')).some((element) => {
      const text = (element.getAttribute('aria-label') || '') + ' ' + (element.getAttribute('data-tooltip') || '');
      return text.includes(approvedIdentity);
    }) || (document.body ? document.body.innerText.includes(approvedIdentity) : false);
    if (!identityPresent) throw new Error('Protected SMS capture found the wrong Google Voice identity');
    const elements = Array.from(document.querySelectorAll('body *'));
    if (elements.length === 0 || elements.length > 20000) {
      throw new Error('Protected SMS capture could not inspect the bounded page');
    }
    const pattern = /(?:service[\\s_-]*titan).{0,240}?\\b([0-9]{6})\\b|\\b([0-9]{6})\\b.{0,240}?(?:service[\\s_-]*titan)/is;
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
    if (candidates.length === 0) throw new Error('No correlated ServiceTitan SMS code was visible');
    candidates.sort((a, b) => b.x - a.x || b.y - a.y);
    const best = candidates[0];
    if (candidates.some((candidate) => candidate.x === best.x && candidate.y === best.y && candidate.code !== best.code)) {
      throw new Error('The newest visible ServiceTitan SMS code was ambiguous');
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
  state.clear();
  const result = await bridge.callTool(
    'evaluate',
    { tabId, expression: protectedSmsCaptureExpression() },
    PROTECTED_PASTE_TIMEOUT_MS,
  );
  try {
    if (result.isError) throw new Error('Protected SMS capture was refused');
    let parsed: unknown;
    try {
      parsed = JSON.parse(textResult(result));
    } catch {
      throw new Error('Protected SMS capture returned an invalid result');
    }
    const record = typeof parsed === 'object' && parsed !== null
      ? parsed as Record<string, unknown>
      : null;
    const code = record && Object.keys(record).length === 1 ? record.code : null;
    if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) {
      throw new Error('Protected SMS capture returned an invalid result');
    }
    const bytes = Buffer.from(code, 'ascii');
    try {
      state.storeSmsCode(bytes);
    } finally {
      bytes.fill(0);
    }
    return {
      content: [{ type: 'text', text: `Pressed ${String(args.keys)}` }],
    };
  } finally {
    scrubTextResult(result);
  }
}

function protectedSmsTargetExpression(populated: boolean): string {
  return `(() => {
    const field = document.activeElement;
    if (location.hostname !== 'login.servicetitan.com' || !location.pathname.startsWith('/mfa') || !(field instanceof HTMLInputElement) || field.name !== 'sms-code') {
      throw new Error('Protected SMS target is not the exact ServiceTitan MFA field');
    }
    if (field.disabled || field.readOnly) {
      throw new Error('Protected SMS target is not editable');
    }
    const allowed = new Set(['text', 'tel', 'number']);
    if (!allowed.has(String(field.type || 'text').toLowerCase())) {
      throw new Error('Protected SMS target input type is unsupported');
    }
    const style = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
      throw new Error('Protected SMS target is not visible');
    }
    if (${populated ? "!/^\\d{6}$/.test(field.value)" : "field.value !== ''"}) {
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
  const smsCode = state?.takeSmsCode() ?? null;
  const stagedCredential = smsCode === null ? state?.takeCredential() ?? null : null;
  const bytes = smsCode ?? stagedCredential ?? (clipboardReader ? await clipboardReader() : null);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > CLIPBOARD_MAX_BYTES) {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
    throw new Error('Protected clipboard paste is unavailable');
  }
  try {
    // Clear before field assignment so clipboard lifetime does not depend on a
    // later model turn. The explicit helper clear remains safe and idempotent.
    if (smsCode === null && stagedCredential === null && clipboardClearer) {
      await clipboardClearer();
    }
    let value: string;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Protected clipboard value is not valid UTF-8');
    }
    if (smsCode !== null) {
      const privateResults: ToolResult[] = [];
      try {
        const before = await bridge.callTool(
          'evaluate',
          { tabId, expression: protectedSmsTargetExpression(false) },
          PROTECTED_PASTE_TIMEOUT_MS,
        );
        privateResults.push(before);
        requirePrivateFlag(before, 'ready', 'Protected SMS target was refused');

        const typed = await bridge.callTool(
          'type_text',
          { tabId, text: value },
          PROTECTED_PASTE_TIMEOUT_MS,
        );
        privateResults.push(typed);
        if (typed.isError) throw new Error('Protected SMS typing was refused');

        const after = await bridge.callTool(
          'evaluate',
          { tabId, expression: protectedSmsTargetExpression(true) },
          PROTECTED_PASTE_TIMEOUT_MS,
        );
        privateResults.push(after);
        requirePrivateFlag(after, 'pasted', 'Protected SMS typing did not populate the exact field');
      } finally {
        for (const result of privateResults) scrubTextResult(result);
      }
    } else if (indexedTarget !== undefined) {
      // Snapshot UIDs resolve through CDP's backend-node mapping, so this
      // reaches exact fields inside iframes and shadow roots without ever
      // exposing the protected value to the MCP client. Focus the exact node
      // and immediately apply the native value setter plus input/change events
      // in the same broker call. Keeping those operations adjacent avoids the
      // focus race that occurs when credential staging is a separate process.
      // The caller must pass an exact positive index from fresh page state.
      const privateResults: ToolResult[] = [];
      try {
        const focused = await bridge.callTool(
          'click',
          { tabId, uid: indexedTarget },
          PROTECTED_PASTE_TIMEOUT_MS,
        );
        privateResults.push(focused);
        if (focused.isError) throw new Error('Protected clipboard target could not be focused');

        const typed = await bridge.callTool(
          'evaluate',
          { tabId, expression: protectedPasteExpression(value, false) },
          PROTECTED_PASTE_TIMEOUT_MS,
        );
        privateResults.push(typed);
        requirePrivateFlag(typed, 'pasted', 'Protected clipboard paste was refused');
      } finally {
        for (const result of privateResults) scrubTextResult(result);
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

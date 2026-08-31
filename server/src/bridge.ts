import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, VERSION, validateExtensionTools } from './contract.js';
import type { ToolDefinition } from './contract.js';

export type { ToolDefinition } from './contract.js';

export interface ToolResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
}

interface PendingCall {
  requestId: string;
  name: string;
  message: string;
  timeoutMs: number;
  timer: NodeJS.Timeout;
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
}

export interface BridgeOptions {
  port?: number;
  debug?: boolean;
  profile?: string | null;
  handshakeTimeoutMs?: number;
}

export interface ContractStatus {
  ok: boolean;
  problems: string[];
}

const DEFAULT_PORT = 19889;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

// Handshake rejections fail closed with dedicated close codes the extension
// recognizes as fatal (it stops reconnecting until reconfigured).
export const CLOSE_MALFORMED_HELLO = 4400;
export const CLOSE_PROFILE_MISMATCH = 4403;
export const CLOSE_PROTOCOL_MISMATCH = 4426;

const formatProfile = (profile: string | null) => (profile === null ? '(none)' : JSON.stringify(profile));

/**
 * Loopback-only WebSocket bridge between the MCP server and the extension.
 *
 * New sockets are held in a pending set until they present a valid hello
 * ({type:'connected', profile, protocolVersion, ...}). Mismatches are rejected
 * with 4400/4403/4426 and never displace an already-promoted extension. A
 * valid hello promotes the socket (latest valid connection wins), replays any
 * in-flight call messages, and requests the tool list.
 */
export class LocalExtensionBridge extends EventEmitter {
  readonly port: number;
  readonly profile: string | null;
  private readonly debug: boolean;
  private readonly handshakeTimeoutMs: number;
  private server: WebSocketServer | null = null;
  private extension: WebSocket | null = null;
  private readonly pendingSockets = new Set<WebSocket>();
  private tools: ToolDefinition[] = [];
  private requestSequence = 0;
  private readonly pending = new Map<string, PendingCall>();
  private stopped = false;

  constructor(options: BridgeOptions = {}) {
    super();
    this.port = options.port ?? DEFAULT_PORT;
    this.debug = options.debug ?? false;
    this.profile = options.profile ?? null;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (this.server) return;
    await new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({ host: '127.0.0.1', port: this.port });
      server.once('listening', () => {
        this.server = server;
        resolve();
      });
      server.once('error', (error) => reject(error));
      server.on('connection', (socket, request) => {
        const remote = request.socket.remoteAddress;
        if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1' && remote !== '::1') {
          socket.close(1008, 'Loopback connections only');
          return;
        }
        this.beginHandshake(socket);
      });
    });
    this.log(`bridge listening on ws://127.0.0.1:${this.port} (profile ${formatProfile(this.profile)})`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const socket of this.pendingSockets) {
      try { socket.close(1001, 'Bridge shutting down'); } catch { /* closing */ }
    }
    this.pendingSockets.clear();
    if (this.extension) {
      try { this.extension.close(1001, 'Bridge shutting down'); } catch { /* closing */ }
      this.extension = null;
    }
    this.failPending(new Error('Bridge stopped'));
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  private beginHandshake(socket: WebSocket): void {
    this.pendingSockets.add(socket);
    const timer = setTimeout(() => {
      this.rejectSocket(socket, CLOSE_MALFORMED_HELLO, 'Handshake required: send {type:"connected", profile, protocolVersion} first');
    }, this.handshakeTimeoutMs);
    socket.once('message', (raw) => {
      clearTimeout(timer);
      if (!this.pendingSockets.has(socket)) return;
      let hello: Record<string, unknown>;
      try {
        hello = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        this.rejectSocket(socket, CLOSE_MALFORMED_HELLO, 'Handshake required: first frame was not JSON');
        return;
      }
      if (!hello || hello.type !== 'connected') {
        this.rejectSocket(socket, CLOSE_MALFORMED_HELLO, 'Handshake required: first frame must be {type:"connected", ...}');
        return;
      }
      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        this.rejectSocket(socket, CLOSE_PROTOCOL_MISMATCH,
          `Protocol version ${PROTOCOL_VERSION} required; extension sent ${String(hello.protocolVersion ?? '(none)')}`);
        return;
      }
      const theirProfile = typeof hello.profile === 'string' && hello.profile.length ? hello.profile : null;
      if (theirProfile !== this.profile) {
        this.rejectSocket(socket, CLOSE_PROFILE_MISMATCH,
          `Expected profile ${formatProfile(this.profile)}, got ${formatProfile(theirProfile)}`);
        return;
      }
      this.pendingSockets.delete(socket);
      this.promote(socket, hello);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      this.pendingSockets.delete(socket);
    });
    socket.on('error', () => { /* close follows */ });
  }

  private rejectSocket(socket: WebSocket, code: number, reason: string): void {
    if (!this.pendingSockets.has(socket)) return;
    this.pendingSockets.delete(socket);
    this.log(`rejected connection (${code}): ${reason}`);
    try { socket.close(code, reason); } catch { /* closing */ }
  }

  private promote(socket: WebSocket, hello: Record<string, unknown>): void {
    const previous = this.extension;
    this.extension = socket;
    this.log(`extension connected (profile ${formatProfile(this.profile)}, extension version ${String(hello.extensionVersion ?? 'unknown')})`);

    socket.on('message', (raw) => {
      if (this.extension !== socket) return;
      this.handleMessage(String(raw));
    });
    socket.on('close', () => {
      if (this.extension !== socket) return;
      this.extension = null;
      this.tools = [];
      this.log('extension disconnected');
      this.emit('toolsChanged');
    });
    socket.on('error', () => { /* close follows */ });

    this.sendPong(socket);
    this.sendTo(socket, { type: 'list_tools' });
    // Replay in-flight calls so the fresh socket can answer them (the
    // extension deduplicates by requestId — at-most-once execution).
    for (const call of this.pending.values()) {
      try { socket.send(call.message); } catch { /* socket died; timeout covers it */ }
    }
    if (previous && previous !== socket) {
      try { previous.close(1000, 'Replaced by a newer local connection'); } catch { /* closing */ }
    }
  }

  private sendTo(socket: WebSocket, payload: Record<string, unknown>): void {
    try { socket.send(JSON.stringify(payload)); } catch { /* socket died; close handler cleans up */ }
  }

  private sendPong(socket: WebSocket): void {
    this.sendTo(socket, {
      type: 'pong',
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      expectedProfile: this.profile,
    });
  }

  // -------------------------------------------------------------------------
  // Promoted-socket messages
  // -------------------------------------------------------------------------

  private handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.type) {
      case 'connected': {
        // Heartbeat hello from the promoted extension; answer to keep it alive.
        if (this.extension) this.sendPong(this.extension);
        return;
      }
      case 'tools_list': {
        this.tools = Array.isArray(message.tools) ? (message.tools as ToolDefinition[]) : [];
        this.log(`extension advertises ${this.tools.length} tool(s)`);
        this.emit('toolsChanged');
        this.emit('tools', this.tools);
        return;
      }
      case 'tool_progress': {
        const requestId = String(message.requestId ?? '');
        const call = this.pending.get(requestId);
        if (call) {
          // Progress extends the deadline: long-running tools stay alive as
          // long as the extension keeps reporting.
          clearTimeout(call.timer);
          call.timer = setTimeout(() => {
            this.pending.delete(requestId);
            call.reject(new Error(`Tool ${call.name} timed out after ${call.timeoutMs}ms`));
          }, call.timeoutMs);
        }
        return;
      }
      case 'tool_result': {
        const requestId = String(message.requestId ?? '');
        const call = this.pending.get(requestId);
        if (!call) return;
        this.pending.delete(requestId);
        clearTimeout(call.timer);
        const result = message.result as ToolResult | undefined;
        if (result && Array.isArray(result.content)) call.resolve(result);
        else call.reject(new Error('Extension returned a malformed tool result'));
        return;
      }
      case 'error': {
        const requestId = String(message.requestId ?? '');
        const call = this.pending.get(requestId);
        if (!call) return;
        this.pending.delete(requestId);
        clearTimeout(call.timer);
        call.reject(new Error(String(message.error ?? 'Extension reported an error')));
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  isConnected(): boolean {
    return this.extension !== null && this.extension.readyState === WebSocket.OPEN;
  }

  getTools(): ToolDefinition[] {
    return this.tools;
  }

  /** Synchronous contract check of the currently advertised tools. */
  contractStatus(): ContractStatus {
    if (!this.isConnected()) return { ok: false, problems: ['no extension connected'] };
    if (!this.tools.length) return { ok: false, problems: ['extension has not advertised any tools yet'] };
    const problems = validateExtensionTools(this.tools);
    return { ok: problems.length === 0, problems };
  }

  /** Resolve once tools are available or the timeout passes (never rejects). */
  waitForTools(timeoutMs: number): Promise<void> {
    if (this.tools.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off('tools', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.once('tools', done);
    });
  }

  /**
   * Wait until a connected extension advertises the full reviewed contract,
   * or the timeout passes. Resolves with the latest validation problems on
   * failure (never rejects).
   */
  waitForContract(timeoutMs: number): Promise<ContractStatus> {
    const now = this.contractStatus();
    if (now.ok) return Promise.resolve(now);
    return new Promise((resolve) => {
      const finish = (status: ContractStatus) => {
        clearTimeout(timer);
        this.off('tools', onTools);
        resolve(status);
      };
      const onTools = () => {
        const status = this.contractStatus();
        if (status.ok) finish(status);
      };
      const timer = setTimeout(() => finish(this.contractStatus()), timeoutMs);
      this.on('tools', onTools);
    });
  }

  callTool(name: string, args: Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<ToolResult> {
    const requestId = `local_${Date.now()}_${++this.requestSequence}`;
    const message = JSON.stringify({ type: 'call_tool', requestId, name, args });
    return new Promise<ToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Tool ${name} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { requestId, name, message, timeoutMs, timer, resolve, reject });
      if (this.extension && this.extension.readyState === WebSocket.OPEN) {
        try {
          this.extension.send(message);
        } catch {
          // Socket died mid-send; the message replays when a socket promotes.
        }
      }
      // With no extension connected the call waits; a promoting socket replays it.
    });
  }

  private failPending(error: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  private log(...parts: unknown[]): void {
    if (this.debug) console.error('[local-bridge]', ...parts);
  }
}

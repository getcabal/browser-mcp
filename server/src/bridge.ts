import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<Record<string, unknown>>;
  isError?: boolean;
}

interface PendingCall {
  requestId: string;
  message: string;
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The entire local control plane. It binds only to the IPv4 loopback address;
 * neither the extension nor this process accepts a remote URL.
 */
export class LocalExtensionBridge extends EventEmitter {
  private server: WebSocketServer | null = null;
  private extension: WebSocket | null = null;
  private tools: ToolDefinition[] = [];
  private requestSequence = 0;
  private pending = new Map<string, PendingCall>();

  constructor(private readonly port = 19889, private readonly debug = false) {
    super();
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = new WebSocketServer({ host: '127.0.0.1', port: this.port });
    this.server.on('connection', (socket, request) => {
      if (request.socket.remoteAddress !== '127.0.0.1') {
        socket.close(1008, 'Loopback clients only');
        return;
      }
      this.acceptExtension(socket);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('listening', resolve);
      this.server!.once('error', reject);
    });
    this.log(`extension endpoint ws://127.0.0.1:${this.port}`);
  }

  async stop(): Promise<void> {
    this.failPending('Local bridge stopped');
    this.extension?.close(1001, 'Bridge stopped');
    this.extension = null;
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  getTools(): ToolDefinition[] { return [...this.tools]; }

  waitForTools(timeoutMs: number): Promise<void> {
    if (this.tools.length) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      const self = this;
      function done() { clearTimeout(timer); self.off('tools', done); resolve(); }
      this.once('tools', done);
    });
  }

  callTool(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<ToolResult> {
    if (!this.extension || this.extension.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Local browser extension is not connected'));
    }
    const requestId = `local_${Date.now()}_${++this.requestSequence}`;
    const message = JSON.stringify({ type: 'call_tool', requestId, data: { name, arguments: args } });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Tool ${name} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { requestId, message, resolve, reject, timer });
      this.extension!.send(message);
    });
  }

  private acceptExtension(socket: WebSocket): void {
    const previous = this.extension;
    this.extension = socket;
    this.log('extension connected');
    socket.on('message', (raw) => this.handleMessage(socket, raw.toString()));
    socket.on('close', () => {
      // A delayed close from a replaced socket must not invalidate its successor.
      if (this.extension !== socket) return;
      this.extension = null;
      this.tools = [];
      this.emit('tools');
      this.emit('toolsChanged');
      this.log('extension disconnected');
    });
    socket.on('error', (error) => this.log(`socket error: ${error.message}`));
    socket.send(JSON.stringify({ type: 'list_tools', requestId: `tools_${Date.now()}` }));
    for (const pending of this.pending.values()) socket.send(pending.message);
    if (previous && previous !== socket) previous.close(1000, 'Replaced by a newer local connection');
  }

  private handleMessage(source: WebSocket, raw: string): void {
    if (source !== this.extension) return;
    let message: any;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.type === 'connected') {
      source.send(JSON.stringify({ type: 'pong', version: 'local-only-1' }));
      return;
    }
    if (message.type === 'tools_list' && Array.isArray(message.data)) {
      this.tools = message.data;
      this.emit('tools');
      this.emit('toolsChanged');
      return;
    }
    if (!message.requestId) return;
    const pending = this.pending.get(message.requestId);
    if (!pending || message.type === 'tool_progress') return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.type === 'tool_result') pending.resolve(message.data as ToolResult);
    else pending.reject(new Error(message.error || 'Extension tool failed'));
  }

  private failPending(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private log(message: string): void {
    if (this.debug) console.error(`[local-browser] ${message}`);
  }
}

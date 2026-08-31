/** Shared test double: a WebSocket client that behaves like the extension. */
import { createServer } from 'node:net';
import WebSocket from 'ws';

export const TEST_PROTOCOL_VERSION = 2;

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class FakeExtension {
  constructor({ port, profile = null, protocolVersion = TEST_PROTOCOL_VERSION, tools = [], handlers = {}, autoHello = true, autoRespond = true }) {
    this.port = port;
    this.profile = profile;
    this.protocolVersion = protocolVersion;
    this.tools = tools;
    this.handlers = handlers;
    this.autoHello = autoHello;
    this.autoRespond = autoRespond;
    this.messages = [];
    this.closed = null;
    this.socket = null;
    this.waiters = [];
    this.closeWaiters = [];
    this.seenRequests = new Set(); // at-most-once execution across replays
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
      this.socket = socket;
      socket.on('open', () => {
        if (this.autoHello) this.sendHello();
        resolve(this);
      });
      socket.on('error', () => { /* close carries the outcome */ });
      socket.on('message', (raw) => {
        let message;
        try { message = JSON.parse(String(raw)); } catch { return; }
        this.messages.push(message);
        this.waiters = this.waiters.filter((waiter) => {
          if (!waiter.predicate(message)) return true;
          waiter.resolve(message);
          return false;
        });
        if (this.autoRespond) void this.respond(message);
      });
      socket.on('close', (code, reason) => {
        this.closed = { code, reason: String(reason) };
        for (const notify of this.closeWaiters) notify(this.closed);
        this.closeWaiters = [];
        reject(new Error(`closed before open (${code})`));
      });
    });
  }

  sendHello() {
    this.send({
      type: 'connected',
      profile: this.profile,
      protocolVersion: this.protocolVersion,
      extensionVersion: '1.1.0-test',
    });
  }

  async respond(message) {
    if (message.type === 'list_tools') {
      this.send({ type: 'tools_list', tools: this.tools });
      return;
    }
    if (message.type === 'call_tool') {
      if (this.seenRequests.has(message.requestId)) return;
      this.seenRequests.add(message.requestId);
      const handler = this.handlers[message.name];
      if (!handler) {
        this.send({
          type: 'tool_result',
          requestId: message.requestId,
          result: { content: [{ type: 'text', text: `Error: unknown tool ${message.name}` }], isError: true },
        });
        return;
      }
      const value = await handler(message.args ?? {}, this, message);
      if (value === undefined) return; // handler chose not to answer (tests replay)
      this.send({
        type: 'tool_result',
        requestId: message.requestId,
        result: { content: [{ type: 'text', text: String(value) }] },
      });
    }
  }

  send(payload) {
    this.socket.send(JSON.stringify(payload));
  }

  waitForMessage(predicate, timeoutMs = 3000, label = 'message') {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      this.waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
  }

  waitForClose(timeoutMs = 3000) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeoutMs);
      this.closeWaiters.push((info) => { clearTimeout(timer); resolve(info); });
    });
  }

  close() {
    try { this.socket?.close(1000); } catch { /* already closed */ }
  }
}

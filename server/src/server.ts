import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { LocalExtensionBridge } from './bridge.js';
import { VERSION, enrichTools } from './contract.js';
import {
  captureProtectedServiceTitanSms,
  deliverProtectedClipboardPaste,
  isProtectedPasteCall,
  isProtectedSmsCaptureCall,
  ProfileCredentialBroker,
  ProtectedPasteState,
  readSystemClipboard,
} from './protected-paste.js';
import type { ClipboardReader } from './protected-paste.js';

export interface ServerOptions {
  port?: number;
  debug?: boolean;
  profile?: string | null;
  requireExtension?: boolean;
  extensionConnectTimeoutMs?: number;
  clipboardReader?: ClipboardReader;
  credentialSocket?: string | null;
}

export class LocalMcpServer {
  readonly bridge: LocalExtensionBridge;
  private readonly mcp: Server;
  private readonly requireExtension: boolean;
  private readonly extensionConnectTimeoutMs: number;
  private readonly clipboardReader: ClipboardReader | null;
  private readonly protectedPasteState = new ProtectedPasteState();
  private readonly credentialBroker: ProfileCredentialBroker | null;
  private connected = false;
  private graceTimer: NodeJS.Timeout | null = null;

  constructor(options: ServerOptions = {}) {
    this.requireExtension = options.requireExtension ?? false;
    this.extensionConnectTimeoutMs = options.extensionConnectTimeoutMs ?? 90_000;
    this.clipboardReader = options.clipboardReader
      ?? (options.credentialSocket ? null : readSystemClipboard);
    this.credentialBroker = options.credentialSocket
      ? new ProfileCredentialBroker(options.credentialSocket, this.protectedPasteState)
      : null;
    this.bridge = new LocalExtensionBridge({
      port: options.port,
      debug: options.debug,
      profile: options.profile ?? null,
    });
    this.mcp = new Server(
      { name: 'local-browser', version: VERSION },
      { capabilities: { tools: { listChanged: true } } },
    );

    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      await this.bridge.waitForTools(3_000);
      return { tools: enrichTools(this.bridge.getTools()) as unknown as Tool[] };
    });

    this.mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const args =
          (request.params.arguments as Record<string, unknown> | undefined) ?? {};
        const result = isProtectedSmsCaptureCall(request.params.name, args)
          ? await captureProtectedServiceTitanSms(
            this.bridge,
            args,
            this.protectedPasteState,
          )
          : isProtectedPasteCall(request.params.name, args)
            ? await deliverProtectedClipboardPaste(
              this.bridge,
              args,
              this.clipboardReader,
              this.protectedPasteState,
            )
            : await this.bridge.callTool(request.params.name, args);
        return result as unknown as CallToolResult;
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        } satisfies CallToolResult;
      }
    });

    this.bridge.on('toolsChanged', () => {
      if (!this.connected) return;
      void this.mcp.sendToolListChanged();
      if (this.requireExtension) this.watchContract();
    });
  }

  /**
   * In require mode a lost or non-conforming contract gets one reconnect
   * grace period; if it is not restored, the process exits so the host sees
   * a dead server instead of a healthy-looking empty one.
   */
  private watchContract(): void {
    const status = this.bridge.contractStatus();
    if (status.ok) {
      if (this.graceTimer) {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }
      return;
    }
    if (this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      const finalStatus = this.bridge.contractStatus();
      if (finalStatus.ok) return;
      console.error(`local-browser: extension contract lost and not restored within ${this.extensionConnectTimeoutMs}ms:`);
      for (const problem of finalStatus.problems) console.error(`  - ${problem}`);
      process.exit(1);
    }, this.extensionConnectTimeoutMs);
  }

  async start(): Promise<void> {
    await this.bridge.start();
    if (this.requireExtension) {
      const status = await this.bridge.waitForContract(this.extensionConnectTimeoutMs);
      if (!status.ok) {
        const profileNote = this.bridge.profile !== null ? ` for profile ${JSON.stringify(this.bridge.profile)}` : '';
        console.error(`local-browser: --require-extension failed after ${this.extensionConnectTimeoutMs}ms.`);
        console.error(`  Expected the full reviewed tool contract on ws://127.0.0.1:${this.bridge.port}${profileNote}.`);
        for (const problem of status.problems) console.error(`  - ${problem}`);
        console.error('  Check that Chrome is running with the Local Browser MCP extension loaded and configured for this port/profile.');
        await this.bridge.stop();
        process.exit(1);
      }
    }
    try {
      await this.credentialBroker?.start();
      const transport = new StdioServerTransport();
      await this.mcp.connect(transport);
      this.connected = true;
    } catch (error) {
      await this.credentialBroker?.stop();
      await this.bridge.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.connected = false;
    this.protectedPasteState.clear();
    await this.credentialBroker?.stop();
    try { await this.mcp.close(); } catch { /* transport already gone */ }
    await this.bridge.stop();
  }
}

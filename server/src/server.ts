import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { LocalExtensionBridge } from './bridge.js';

export class LocalMcpServer {
  private readonly bridge: LocalExtensionBridge;
  private readonly mcp: Server;

  constructor(port = 19889, debug = false) {
    this.bridge = new LocalExtensionBridge(port, debug);
    this.mcp = new Server(
      { name: 'local-browser', version: '1.0.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      await this.bridge.waitForTools(3_000);
      return { tools: this.bridge.getTools() };
    });
    this.mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return await this.bridge.callTool(
          request.params.name,
          (request.params.arguments || {}) as Record<string, unknown>,
        );
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        };
      }
    });
    this.bridge.on('toolsChanged', () => {
      if ((this.mcp as { transport?: unknown }).transport) void this.mcp.sendToolListChanged();
    });
  }

  async start(): Promise<void> {
    await this.bridge.start();
    await this.mcp.connect(new StdioServerTransport());
  }

  async stop(): Promise<void> {
    await this.bridge.stop();
    await this.mcp.close();
  }
}

#!/usr/bin/env node
import { LocalMcpServer } from './server.js';
import { VERSION } from './contract.js';
import { resolve } from 'node:path';

const USAGE = `local-browser-mcp ${VERSION} — local-only browser MCP server (stdio)

Usage: local-browser-mcp [start] [options]

Options:
  --extension-port <port>           Loopback WebSocket port for the extension bridge (default 19889)
  --port <port>                     Compatibility alias for --extension-port
  --profile <name>                  Expected extension profile; mismatched extensions are rejected
  --require-extension               Fail startup unless the extension connects and serves the full
                                    reviewed tool contract within the connect timeout
  --extension-connect-timeout <ms>  Budget for --require-extension startup and reconnect grace
                                    (default 90000)
  --debug                           Verbose bridge logging on stderr
  --help                            Show this help
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv[0] === 'start') argv.shift();

const envPortText = process.env.BROWSER_MCP_EXTENSION_PORT
  ?? process.env.HERMES_VIBE_EXTENSION_PORT
  ?? process.env.VIBE_MCP_EXTENSION_PORT;
const envPort = envPortText === undefined ? 19889 : Number(envPortText);
if (!Number.isInteger(envPort) || envPort < 1024 || envPort > 65535) {
  fail('BROWSER_MCP_EXTENSION_PORT/HERMES_VIBE_EXTENSION_PORT/VIBE_MCP_EXTENSION_PORT must be an integer between 1024 and 65535');
}

let port = envPort;
let debug = false;
let profile: string | null = (process.env.BROWSER_MCP_PROFILE ?? '').trim() || null;
let requireExtension = false;
let extensionConnectTimeoutMs = 90_000;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  switch (arg) {
    case '--debug':
      debug = true;
      break;
    case '--require-extension':
      requireExtension = true;
      break;
    case '--help':
    case '-h':
      console.log(USAGE);
      process.exit(0);
      break;
    case '--extension-port':
    case '--port': {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1024 || value > 65535) {
        fail(`${arg} must be an integer between 1024 and 65535`);
      }
      port = value;
      break;
    }
    case '--extension-connect-timeout': {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) {
        fail('--extension-connect-timeout must be a positive integer (milliseconds)');
      }
      extensionConnectTimeoutMs = value;
      break;
    }
    case '--profile': {
      const value = argv[++i];
      if (typeof value !== 'string' || !value.trim()) fail('--profile requires a non-empty name');
      profile = value.trim();
      break;
    }
    default:
      fail(`Unknown option: ${arg}\n\n${USAGE}`);
  }
}

const stateDir = (process.env.BROWSER_MCP_STATE_DIR ?? '').trim();
const credentialSocket = profile && stateDir
  ? resolve(stateDir, 'credential.sock')
  : null;
const server = new LocalMcpServer({
  port,
  debug,
  profile,
  requireExtension,
  extensionConnectTimeoutMs,
  credentialSocket,
});
let shuttingDown = false;
const shutdown = (exitCode: number): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  void server.stop().finally(() => process.exit(exitCode));
};

server.start().catch((error) => {
  console.error('local-browser: failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});

// The upstream StdioServerTransport does not subscribe to stdin end/close.
// Without these handlers, a disconnected MCP host can leave the WebSocket
// bridge alive indefinitely, retaining the profile's fixed extension port and
// making every reconnect fail closed as "port already occupied".
process.stdin.once('end', () => shutdown(0));
process.stdin.once('close', () => shutdown(0));
process.stdout.once('error', (error: NodeJS.ErrnoException) => {
  shutdown(error.code === 'EPIPE' ? 0 : 1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    shutdown(0);
  });
}

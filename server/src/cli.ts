#!/usr/bin/env node
import { LocalMcpServer } from './server.js';

const args = process.argv.slice(2);
const debug = args.includes('--debug');
const portFlag = args.indexOf('--extension-port');
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 19889;
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('--extension-port must be between 1024 and 65535');
  process.exit(1);
}

const server = new LocalMcpServer(port, debug);
await server.start();
const shutdown = async () => { await server.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

# Local Browser MCP

An independent, local-only MCP server and Chrome extension for controlling your
existing browser tabs. The control plane stays on the same computer and requires
no account, hosted service, routing identifier, access token, or remote relay.

This directory is the complete project. Copy it anywhere; it does not import,
link to, or execute files from its parent repository.

## How it works

```text
MCP client ── stdio ──> Node.js server ── ws://127.0.0.1:19889 ──> Chrome extension
```

- MCP is exposed only through the child process's standard input/output.
- The extension bridge binds explicitly to IPv4 loopback.
- The extension has one fixed control address: `ws://127.0.0.1:19889`.
- There is no remotely reachable server mode.

“Local-only” describes the control plane. Chrome can still visit websites at
your request, so ordinary page navigation can naturally use the internet. The
project itself makes no relay, account, analytics, update, or telemetry request.

## Requirements

- Node.js 18 or newer
- npm
- Chrome, Chromium, Brave, or another Chromium browser supporting `chrome.debugger`
- An MCP client that can launch a stdio server

## Install

From this directory:

```bash
npm install
npm run build
npm test
npm run doctor
```

The first installation downloads normal npm build/runtime dependencies. Runtime
browser control remains local after installation.

### Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this project's `extension` directory.

Chrome displays a debugger-control banner while the extension is attached to a
tab. This is expected because browser actions use Chrome's supported debugger
API.

### Configure your MCP client

Replace `/path/to/local-browser-mcp` with the absolute path to this directory:

```json
{
  "mcpServers": {
    "local-browser": {
      "command": "node",
      "args": ["/path/to/local-browser-mcp/server/dist/cli.js"]
    }
  }
}
```

For Codex CLI:

```bash
codex mcp add local-browser -- node /path/to/local-browser-mcp/server/dist/cli.js
```

Startup order does not matter. The extension retries its loopback connection
with bounded exponential backoff.

## Browser tools

- Tabs: `list_tabs`, `new_tab`, `select_tab`, `close_tab`
- Navigation and reading: `navigate`, `snapshot`, `get_text`, `screenshot`
- Interaction: `click`, `fill`, `type_text`, `hover`, `press_key`, `scroll`
- Advanced: `evaluate`

Call `snapshot` before interacting with elements. It returns compact references
such as `@e12`; pass those references to `click`, `fill`, or `hover`.

## Reliability

- Each tool call has an end-to-end request ID and bounded timeout.
- Pending calls are replayed if the extension replaces its socket.
- The extension caches completed responses and deduplicates replayed calls.
- Stale socket-close events cannot invalidate a newer connection.
- Heartbeats detect half-open connections.
- Tool discovery tolerates either side starting first.
- CDP sessions are reused and reacquired after transport failure.
- Stale accessibility references are relocated once by role and accessible name.
- Reconnection backs off from one to thirty seconds.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full call lifecycle.

## Security model

- The control socket accepts loopback connections only. Other processes running
  as the same local user could still attempt to connect; local-only does not mean
  mutually authenticated.
- The extension requires powerful `debugger`, `tabs`, and `<all_urls>` access to
  control arbitrary tabs. Review the small, unbundled `extension/background.js`
  before installing it.
- `evaluate` runs JavaScript in the selected page. Remove its tool definition and
  switch case if your threat model does not permit arbitrary page expressions.
- One server process owns port `19889`. Configure one MCP host process at a time.

## Project layout

```text
extension/              Unbundled Manifest V3 Chrome extension
server/src/             TypeScript MCP server and loopback bridge
server/test/            End-to-end and isolation audits
scripts/doctor.mjs      Installation checks
scripts/clean.mjs       Removes generated server output
```

## Commands

```bash
npm run build     # Compile the server
npm test          # Build, run the tool round trip, and audit isolation
npm run doctor    # Check Node, extension files, and compiled server
npm run clean     # Remove generated server/dist
```

The end-to-end test launches the real loopback bridge on an ephemeral port,
connects a fake extension, discovers tools, executes a complete tool call, and
verifies the returned payload.

## License

Apache-2.0. See [LICENSE](LICENSE). Legal attribution in the license is retained
for provenance; it is not part of the product name or user-facing identity.

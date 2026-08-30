# Local Browser MCP Architecture

## Components

`server/src/server.ts` is the MCP boundary. It deliberately exposes only stdio,
which cannot be reached over the network. `server/src/bridge.ts` owns the sole
network listener and binds it to `127.0.0.1` for the extension.

`extension/background.js` is dependency-free browser code. Keeping the extension
entry point unbundled makes the complete executable control path inspectable in
one file and prevents a build step from silently retaining hosted-relay code.

## Call lifecycle

1. The MCP client sends `tools/call` over stdio.
2. The server assigns a unique local request ID and stores the pending promise.
3. The extension dispatches the named tool through an explicit switch.
4. Chrome performs the operation through `chrome.tabs` or `chrome.debugger`.
5. The extension stores the completed response before sending it.
6. The server correlates the response and resolves the original MCP request.

If a replacement extension socket arrives between steps 2 and 5, the server
replays the same ID. A running duplicate is ignored; a completed duplicate gets
the cached response. This provides at-most-once browser execution for retained
request IDs while allowing response recovery.

## Element references

`snapshot` reads Chrome's accessibility tree and maps compact `@eN` identifiers
to backend DOM node IDs. Interaction resolves the backend node directly. If the
page replaced it, the extension refreshes the accessibility tree and relocates a
unique element with the same role and accessible name. Ambiguous matches fail
closed and ask the caller to take another snapshot.

## Intentionally omitted

- Hosted relay and remote WebSocket client
- HTTP/SSE MCP exposure
- UUID identity and extension registration secrets
- OAuth and user accounts
- Analytics and crash reporting
- Cloud-agent setup helpers
- Automatic downloads or updates

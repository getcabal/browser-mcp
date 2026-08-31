# Local Browser MCP Architecture

## Components

`server/src/server.ts` is the MCP boundary. It deliberately exposes only stdio,
which cannot be reached over the network. `server/src/bridge.ts` owns the sole
network listener and binds it to `127.0.0.1` for the extension.

`extension/background.js` is dependency-free browser code. Keeping the extension
entry point unbundled makes the complete executable control path inspectable in
one file and prevents a build step from silently retaining hosted-relay code.

## The contract as data

The reviewed 24-tool contract (22 established tools + 2 local extras) exists in
two deliberately duplicated places:

- `server/src/contract.ts` — the canonical TypeScript source. Provides
  `validateExtensionTools()` (exact-match validation of what the extension
  advertises) and `enrichTools()` (adds titles and MCP annotations to
  tools/list).
- `extension/tools.js` — a pure-data ES module with no `chrome.*` references,
  importable both by the service worker and by Node test code.

They must stay byte-identical in names, descriptions, and inputSchemas. The
duplication is intentional: the extension must not depend on server build
output, and the server must not parse extension source. The
`server/test/contract-sync.mjs` suite deep-compares the two (plus a hard-coded
expected-name table derived from the reviewed contract), so any drift — a
renamed tool, a changed parameter, a version bump missed in one place — fails
the build rather than silently changing the MCP surface. The same mechanism is
what lets the server *reject* an extension advertising a drifted contract at
runtime.

## Connection handshake

New extension sockets are **pending**, not trusted. The bridge state machine:

```text
socket opens ──> pending (5s timer)
  first frame not a valid hello ──> close 4400 "Handshake required"
  hello.profile ≠ expected      ──> close 4403 "Expected profile …, got …"
  hello.protocolVersion ≠ ours  ──> close 4426 "Protocol version mismatch"
  timer fires before hello      ──> close 4400
  valid hello ──> promote: pong {version, protocolVersion, expectedProfile},
                  send list_tools, replay pending calls,
                  close the previously promoted socket (1000)
```

Two properties matter:

- **Rejection never displaces a promoted socket.** A misconfigured or malicious
  local process probing the port cannot knock out the working extension or
  clear the advertised tools.
- **Fail closed, stay closed.** On receiving a 4400/4403/4426 close (or a pong
  whose profile/protocol contradicts its own config), the extension records a
  FATAL state in `chrome.storage.session` and stops reconnecting — a stamped
  `fleet-1` extension will not retry its way into controlling the `fleet-0`
  server. Changing the port/profile in the options page (or the popup's
  Reconnect button) clears FATAL. Profile comparison is strict equality
  including the unset case: `null === null` passes, everything else fails.

The extension re-sends its hello every 15 seconds as a heartbeat; the server
treats a hello from the promoted socket as keepalive and replies with a fresh
pong. Two silent intervals force a reconnect.

## Startup gating

Without `--require-extension`, tools/list waits briefly for the extension and
tolerates absence (late tools arrive via `notifications/tools/list_changed`).

With `--require-extension`, `start()` calls `waitForContract(timeout)` **before
connecting stdio**: the bridge must hold a promoted socket whose advertised
tools pass `validateExtensionTools()` exactly. Failure prints a multi-line
stderr diagnosis (no extension connected / missing tool X / tool Y schema
drift / unexpected tool Z, plus the expected port and profile) and exits 1 —
there is no "successful" empty-tool-list mode. While serving, losing the
contract arms a grace timer of the same length; if the contract is not restored
the process exits 1 rather than degrade silently.

## Call lifecycle

1. The MCP client sends `tools/call` over stdio.
2. The server assigns a unique local request ID and stores the pending promise
   with a per-tool timeout (wait tools: their requested timeout plus margin;
   navigation tools: their readiness budget plus margin; default 90s).
3. The extension dispatches the named tool through an explicit switch.
4. Chrome performs the operation through `chrome.tabs` or `chrome.debugger`.
5. Long-running tools emit `tool_progress` every 15 seconds; each frame
   **resets** the server-side pending timer, so a 5-minute `wait_for` survives
   the server's default timeout without weakening it for stuck calls.
6. The extension stores the completed response before sending it.
7. The server correlates the response and resolves the original MCP request.

If a replacement extension socket arrives between steps 2 and 6, the server
replays the same ID after promoting the new socket. A running duplicate is
ignored; a completed duplicate gets the cached response. This provides
at-most-once browser execution for retained request IDs while allowing response
recovery. Calls issued while no extension is promoted queue and replay on
promotion.

## Element references

`take_snapshot` reads Chrome's accessibility tree and maps compact `@eN`
identifiers to backend DOM node IDs, kept per tab. Uids are valid only for the
latest snapshot: a new snapshot rebuilds and renumbers the map, and a page
navigation (`tabs.onUpdated` → `loading`) clears it. Interaction resolves the
backend node directly; if the page replaced it, the extension refreshes the
accessibility tree and relocates a unique element with the same role and
accessible name. Ambiguous or failed matches fail closed with
`Element @eN is stale; call take_snapshot again`.

## Readiness vs. waiting

Two distinct semantics, matching the reference implementation:

- **Readiness** (`new_page`, `navigate_page`, `switch_to_page`): after
  initiating, wait 150ms, then poll tab load status every 150ms up to the
  budget (default 15s). Timeout **degrades to success** with the warning suffix
  `(page did not reach readyState=complete within Ns; it may still be loading)`
  — navigation started, the page is real, and erroring would only make agents
  retry a navigation that already happened.
- **Waits** (`wait_for`, `wait_for_url`, `wait_for_network_idle`,
  `wait_for_condition`): poll every ~250ms up to `timeout` (default 30s, cap
  300s) and **hard-error** on expiry with `Timed out after Nms waiting for …`
  (including the last evaluation error for `wait_for_condition`) — here the
  caller asked a yes/no question about the page and deserves a truthful no.

`wait_for_network_idle` counts in-flight requests via CDP Network events,
excluding WebSocket/EventSource (which legitimately stay open); idle means zero
in-flight continuously for `idleMs`.

## Keyboard synthesis

`press_key` and `type_text` dispatch real CDP key events. Printable keys carry
`text`/`unmodifiedText` on keyDown — that is what actually inserts characters —
except under Control/Meta, where text is suppressed (shortcut semantics).
Chords parse as `Modifier+…+Key` with the bitmask Alt=1, Control=2, Meta=4,
Shift=8; `Shift` also transforms the inserted text (`Shift+h` inserts `H`),
because CDP inserts the literal text field rather than applying modifiers
itself. macOS chords are literal: `Control+a` is not `Meta+a`.

## Profile isolation model

One fleet instance = one Chrome profile + one stamped extension copy (unique
port + profile name) + one server process (`--extension-port` + `--profile`).
Isolation is enforced at three layers: distinct loopback ports (no shared
socket), the fail-closed profile handshake (a cross-wired extension is rejected
with 4403 and stops retrying), and per-process bridge state (request IDs,
pending queues, and caches are never shared). `server/test/profile-isolation.mjs`
proves 12 concurrent instances with interleaved calls stay independent and that
killing one instance does not disturb the others.

Deployment verification closes the loop: `scripts/package-extension.mjs`
produces deterministic artifacts (store-method zips, fixed 1980 timestamps,
sorted entries) plus `artifacts.json` content hashes, and
`scripts/doctor.mjs --extension-dir` recomputes an installed copy's hash to
prove exactly which version/profile/port is deployed.

## Intentionally omitted

- Hosted relay and remote WebSocket client
- HTTP/SSE MCP exposure
- UUID identity and extension registration secrets
- OAuth and user accounts
- Analytics and crash reporting
- Cloud-agent setup helpers
- Automatic downloads or updates

`server/test/local-only-audit.mjs` enforces this list mechanically: every
shipped source file is scanned for relay hostnames, fetch/XHR/beacon calls, and
non-loopback WebSocket URLs, and the bridge/extension must build their
addresses only from the loopback literal.

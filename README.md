# Local Browser MCP

An independent, local-only MCP server and Chrome extension for controlling your
existing browser tabs. The control plane stays on the same computer and requires
no account, hosted service, routing identifier, access token, or remote relay.

This directory is the complete project. Copy it anywhere; it does not import,
link to, or execute files from its parent repository.

It preserves the established 22-tool browser MCP contract exactly — tool names,
parameter names, and response formats — so agents, prompts, and skills written
against that contract work unchanged. Two extra prototype tools are kept and
clearly marked as local extras.

## How it works

```text
MCP client ── stdio ──> Node.js server ── ws://127.0.0.1:<port> ──> Chrome extension
```

- MCP is exposed only through the child process's standard input/output.
- The extension bridge binds explicitly to IPv4 loopback.
- The extension connects only to `ws://127.0.0.1:<port>` — the port comes from
  its stamped `config.js` or the options page, never from a remote address.
- Server and extension complete a fail-closed handshake (profile name and
  protocol version) before any tool traffic flows.
- There is no remotely reachable server mode.

"Local-only" describes the control plane. Chrome can still visit websites at
your request, so ordinary page navigation can naturally use the internet. The
project itself makes no relay, account, analytics, update, or telemetry request.

## Requirements

- Node.js 18 or newer
- npm
- Chrome, Chromium, Brave, or another Chromium browser supporting `chrome.debugger`
- An MCP client that can launch a stdio server
- For `npm test` only: a Chromium binary that honors `--load-extension`
  (see [Testing](#testing))

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
4. Choose this project's `extension` directory (or a stamped profile directory
   from `dist/profiles/<name>/` — see [Fleet deployment](#fleet-deployment)).

Chrome displays a debugger-control banner while the extension is attached to a
tab. This is expected because browser actions use Chrome's supported debugger
API.

The extension's **options page** (right-click the toolbar icon → Options, or
`chrome://extensions` → Details → Extension options) sets the port and profile
at runtime; values stored there override the stamped `config.js` defaults.
The toolbar popup shows the effective port, profile, connection state, and any
handshake rejection, with a Reconnect button.

### Configure your MCP client

Replace `/path/to/local-browser-mcp` with the absolute path to this directory:

```json
{
  "mcpServers": {
    "local-browser": {
      "command": "node",
      "args": [
        "/path/to/local-browser-mcp/server/dist/cli.js",
        "--require-extension",
        "--extension-connect-timeout", "15000"
      ]
    }
  }
}
```

For Codex CLI:

```bash
codex mcp add local-browser -- node /path/to/local-browser-mcp/server/dist/cli.js --require-extension
```

CLI flags:

| Flag | Default | Meaning |
|---|---|---|
| `--extension-port <port>` | `19889` | Loopback port the bridge listens on |
| `--profile <name>` | none | Expected extension profile; mismatches are rejected (close 4403) |
| `--require-extension` | off | Fail startup unless the full tool contract is published |
| `--extension-connect-timeout <ms>` | `10000` | How long `--require-extension` waits |
| `--debug` | off | Verbose stderr logging |

With `--require-extension`, the server refuses to enter the "success with zero
tools" state: it waits up to the connect timeout for the extension to connect
and advertise the exact reviewed contract, then either serves MCP or exits 1
with a clear stderr diagnosis (no extension, wrong profile, or tool drift). If
the extension later disconnects, an equal-length grace timer runs before the
server exits rather than serving an empty tool list. Without the flag, startup
is tolerant: tools/list waits briefly and late tools are announced via
`notifications/tools/list_changed`.

Startup order does not matter. The extension retries its loopback connection
with bounded exponential backoff; handshake rejections (wrong profile or
protocol) are fatal and stop reconnection until reconfigured.

## Browser tools

The 22 contract tools, in the advertised order:

| Tool | Required params | Optional params | Notes |
|---|---|---|---|
| `list_pages` | — | — | `Found N page(s):` + `Page <id> [ACTIVE]: "title" - url` |
| `new_page` | `url` | `waitForReady`, `timeoutMs` | Waits for readiness by default |
| `close_page` | — | `tabId` | Active tab by default |
| `navigate_page` | `url` | `tabId`, `type`, `timeoutMs` | `type`: `url` \| `back` \| `forward` \| `reload` |
| `switch_to_page` | `tabId` | — | Activates tab, focuses its window, waits for visibility/readiness |
| `take_snapshot` | — | `tabId`, `interactive` | Returns `Tab ID:`/`Title:`/`URL:` header + uid tree |
| `click` | `uid` | `tabId`, `dblClick` | Real CDP mouse events at element center |
| `fill` | `uid`, `value` | `tabId` | Native value setter + input/change events |
| `fill_form` | `elements` | `tabId` | `elements`: array of `{uid, value}` |
| `type_text` | `text` | `uid`, `submitKey`, `tabId` | Per-character key events; optional submit key |
| `wait_for` | `text` | `timeout`, `tabId` | String or array; all must appear in page text |
| `wait_for_url` | `url` | `timeout`, `tabId` | Substring match, regex fallback |
| `wait_for_network_idle` | — | `idleMs`, `timeout`, `tabId` | Idle = zero in-flight requests for `idleMs` (default 500) |
| `wait_for_condition` | `condition` | `timeout`, `tabId` | Polls a JS expression until truthy |
| `scroll_page` | — | `direction`, `amount`, `uid`, `tabId` | Page or element scrolling |
| `press_key` | `keys` | `tabId` | Chords like `Enter`, `Control+a`, `Shift+Tab` |
| `hover` | `uid` | `tabId` | CDP mouse move to element center |
| `drag` | `from_uid`, `to_uid` | `tabId` | Pointer drag (press → interpolated moves → release) |
| `take_screenshot` | — | `tabId`, `fullPage`, `uid` | PNG image block; element or full-page clip |
| `evaluate_script` | `function` | `args`, `tabId` | Function or expression; promises awaited |
| `upload_file` | `uid` | `filePath`, `file`, `tabId` | `file`: `{filename, mimeType, contentBase64}` |
| `resize_page` | `width`, `height` | `tabId` | Viewport emulation |

Local extras beyond the established contract (kept from the prototype, clearly
annotated in tools/list):

| Tool | Required params | Optional params | Notes |
|---|---|---|---|
| `get_text` | — | `tabId` | Visible `innerText` of the page |
| `evaluate` | `expression` | `tabId` | Evaluates a bare JS expression |

### The uid workflow

Call `take_snapshot` before interacting with elements. It returns compact
references such as `@e12`; pass those as `uid` to `click`, `fill`, `hover`,
`drag`, and the rest. Uids are valid only for the **latest** snapshot of that
tab — taking a new snapshot renumbers them, and a page navigation invalidates
them. If a uid goes stale the tool fails closed with
`Element @eN is stale; call take_snapshot again` (after attempting exactly one
relocation by role and accessible name).

### Readiness vs. waiting

Navigation-flavored tools (`new_page`, `navigate_page`, `switch_to_page`)
establish bounded readiness: the extension polls tab status until the page
completes loading, up to `timeoutMs` (default 15000). On timeout they still
**succeed**, appending the warning suffix
`(page did not reach readyState=complete within Ns; it may still be loading)`.

The `wait_for*` tools are the opposite: they **hard-error** on timeout with
`Timed out after Nms waiting for …`. Their `timeout` is in milliseconds,
default 30000, capped at 300000. Long waits are kept alive end-to-end by
progress frames that extend the server-side call timer.

## Reliability

- Each tool call has an end-to-end request ID and a per-tool bounded timeout
  (wait tools get their requested timeout plus margin).
- Pending calls are replayed if the extension replaces its socket.
- The extension caches completed responses and deduplicates replayed calls
  (at-most-once execution).
- Stale socket-close events cannot invalidate a newer connection, and a
  rejected handshake never displaces an established one.
- Heartbeats detect half-open connections.
- CDP sessions are reused and reacquired after transport failure.
- Stale accessibility references are relocated once by role and accessible name.
- Reconnection backs off from one to thirty seconds; a `chrome.alarms` kicker
  survives service-worker suspension.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full call lifecycle and
handshake state machine.

## Fleet deployment

Run many isolated browser instances on one machine by giving each Chrome
profile its own extension copy (unique port + profile name) and each MCP server
the matching flags.

### Package stamped extensions

```bash
npm run package -- --profile alpha:19901 --profile beta:19902
# or from a JSON manifest: npm run package -- --profiles fleet.json
```

This produces, deterministically (byte-identical zips for identical sources —
store method, fixed 1980 timestamps, sorted entries):

```text
dist/local-browser-extension-<version>.zip(+.sha256)          unstamped base
dist/profiles/<name>/                                          stamped unpacked dir
dist/local-browser-extension-<version>-<name>.zip(+.sha256)    stamped zip
dist/artifacts.json                                            versions, ports, content hashes
```

A 12-instance fleet is one port per profile, e.g.:

| Profile | Port | Profile | Port |
|---|---|---|---|
| fleet-0 | 19900 | fleet-6 | 19906 |
| fleet-1 | 19901 | fleet-7 | 19907 |
| fleet-2 | 19902 | fleet-8 | 19908 |
| fleet-3 | 19903 | fleet-9 | 19909 |
| fleet-4 | 19904 | fleet-10 | 19910 |
| fleet-5 | 19905 | fleet-11 | 19911 |

For each instance: load `dist/profiles/<name>/` unpacked into that Chrome
profile, and launch the server with
`--extension-port <port> --profile <name> --require-extension`. The handshake
rejects cross-wired connections (an extension stamped `fleet-1` connecting to
the `fleet-0` server is closed with code 4403 and stops retrying), so a
misconfigured instance fails loudly instead of controlling the wrong browser.
The profile-isolation test in `server/test/` proves 12 concurrent instances
stay independent.

### Verify an installed copy

```bash
npm run doctor -- --extension-dir dist/profiles/alpha
# or any deployed copy of a stamped directory
```

Doctor reports the installed version, port, and profile, and recomputes the
directory content hash against `dist/artifacts.json` — a modified or stale
install fails the check and names the mismatch.

### Upgrade and rollback

1. Bump the version in all four places (root `package.json`,
   `server/package.json`, `extension/manifest.json`,
   `server/src/contract.ts`) — the packager, doctor, and tests all refuse to
   run with mismatched versions.
2. `npm test && npm run package -- --profiles fleet.json`.
3. Replace each deployed directory with the new `dist/profiles/<name>/`, then
   reload the extension in `chrome://extensions` (or restart Chrome).
4. Verify each with `npm run doctor -- --extension-dir <deployed path>`.
5. Rollback is the same procedure with the previous version's artifacts; zips
   are deterministic, so the `.sha256` sidecars identify exactly what is
   deployed anywhere.

## Security model

- The control socket accepts loopback connections only. Other processes running
  as the same local user could still attempt to connect; local-only does not
  mean mutually authenticated. The profile handshake is a deployment-correctness
  check, not an authentication boundary.
- Profile matching is strict equality, including the unset case: a server with
  no `--profile` accepts only extensions with no stamped profile (`null === null`),
  and any mismatch fails closed.
- The extension requires powerful `debugger`, `tabs`, and `<all_urls>` access to
  control arbitrary tabs. Review the small, unbundled `extension/background.js`
  before installing it.
- `evaluate_script`, `wait_for_condition`, and `evaluate` run caller-supplied
  JavaScript in the selected page. Remove their entries from
  `extension/tools.js` + `server/src/contract.ts` and their switch cases if your
  threat model does not permit arbitrary page code.
- One server process owns each port. Configure one MCP host process per
  port/profile pair.

## Testing

```bash
npm test          # build + all five suites (below)
npm run test:browser  # just the real-browser suite
```

The suite, in order:

1. **contract-sync** — the extension's `tools.js` and the server's
   `contract.ts` advertise byte-identical schemas for all 24 tools, exact
   contract names, annotations, and synchronized versions.
2. **e2e** — the real bridge against a scripted fake extension: handshake
   happy path, close codes 4400/4403/4426, progress-extends-timeout, replay
   across reconnects, `waitForContract`.
3. **profile-isolation** — 12 concurrent bridge+extension pairs stay fully
   isolated; a cross-wired profile is rejected without disturbing the others;
   12 parallel calls route correctly.
4. **local-only-audit** — source-level regex audit that no relay, fetch,
   XHR, beacon, or non-loopback WebSocket code exists in any shipped file.
5. **browser-e2e** — loads a stamped extension into a real headless Chromium
   and exercises the full 24-tool surface against local test pages, including
   readiness, uids, key chords, uploads, waits, and screenshots.

The browser suite is **hard-required**: `npm test` fails with a clear error if
no suitable Chrome binary is found. Note that branded Google Chrome 137+
ignores `--load-extension`, so the test prefers Chrome for Testing / Chromium
builds (Puppeteer and Playwright caches are auto-detected). Point `CHROME_BIN`
at a binary to override:

```bash
CHROME_BIN="$HOME/.cache/puppeteer/chrome/<ver>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" npm test
```

### Manual smoke test

1. Load a stamped dir (e.g. `dist/profiles/alpha`) in Chrome.
2. `node server/dist/cli.js --require-extension --profile alpha --extension-port 19901`
   under your MCP client: tools/list shows 24 tools.
3. Quit Chrome and start the server again: it exits 1 with a clear
   `--require-extension failed` error instead of serving zero tools.

## Project layout

```text
extension/                    Unbundled Manifest V3 Chrome extension
extension/tools.js            The 24 tool definitions (pure data, Node-importable)
extension/config.js           Stamped per-profile port/profile defaults
server/src/contract.ts        Canonical reviewed contract + validation
server/src/                   TypeScript MCP server and loopback bridge
server/test/                  Five test suites (see Testing)
scripts/package-extension.mjs Deterministic zip packager + profile stamping
scripts/doctor.mjs            Installation and deployment verification
scripts/clean.mjs             Removes generated output
```

## Commands

```bash
npm run build     # Compile the server
npm test          # Build + all five test suites (requires a Chromium binary)
npm run doctor    # Check environment, versions, contract; --extension-dir verifies a deploy
npm run package   # Deterministic extension zips; --profile name:port stamps copies
npm run clean     # Remove server/dist and dist
```

## License

Apache-2.0. See [LICENSE](LICENSE). Legal attribution in the license is retained
for provenance; it is not part of the product name or user-facing identity.

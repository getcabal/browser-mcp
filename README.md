# Local Browser MCP

An independent, local-only MCP server and Chrome extension for controlling your
existing browser tabs. The control plane stays on the same computer and requires
no account, hosted service, routing identifier, access token, or remote relay.

This directory is the complete project. Copy it anywhere; it does not import,
link to, or execute files from its parent repository.

It preserves the live `@vibebrowser/mcp@0.3.6` 22-tool MCP contract exactly —
order, names, titles, descriptions, input schemas, defaults, and annotations —
so agents, prompts, and skills written against that contract work unchanged.
Two local convenience tools remain beyond that compatibility boundary.

## How it works

```text
MCP client ── stdio ──> Node.js server ── ws://127.0.0.1:<port> ──> Chrome extension
```

- MCP is exposed only through the child process's standard input/output.
- The extension bridge binds explicitly to IPv4 loopback.
- The extension connects only to `ws://127.0.0.1:<port>` — the port comes from
  `config.js` or, in an unlocked development build, the options page.
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

The base development extension is intentionally unlocked: its **options page**
(right-click the toolbar icon → Options) may override the default port/profile.
Packaged fleet copies are stamped with `locked=true`; stored overrides are
ignored and the options controls are disabled, so a deployed profile cannot be
retargeted. The toolbar popup shows the effective route and connection state.

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
        "--extension-connect-timeout", "90000"
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
| `--port <port>` | `19889` | Vibe-compatible alias for `--extension-port` |
| `--profile <name>` | none | Expected extension profile; mismatches are rejected (close 4403) |
| `--require-extension` | off | Fail startup unless the full tool contract is published |
| `--extension-connect-timeout <ms>` | `90000` | How long `--require-extension` waits |
| `--debug` | off | Verbose stderr logging |

An optional leading `start` subcommand is accepted. The port can also come from
`BROWSER_MCP_EXTENSION_PORT`, `HERMES_VIBE_EXTENSION_PORT`, or
`VIBE_MCP_EXTENSION_PORT` (in that precedence order), and the profile from
`BROWSER_MCP_PROFILE`.

With `--require-extension`, the server refuses to enter the "success with zero
tools" state: it waits up to the connect timeout for the extension to connect
and advertise the exact Vibe-compatible contract, then either serves MCP or exits 1
with a clear stderr diagnosis (no extension, wrong profile, or tool drift). If
the extension later disconnects, an equal-length grace timer runs before the
server exits rather than serving an empty tool list. Without the flag, startup
is tolerant: tools/list waits briefly and late tools are announced via
`notifications/tools/list_changed`.

Startup order does not matter. The extension retries its loopback connection
with bounded exponential backoff; handshake rejections (wrong profile or
protocol) are fatal and stop reconnection until reconfigured.

## Browser tools

Every compatible tool also accepts optional `pageStateFormat` with value
`markdown` or `accessibility_tree`. When supplied, the result appends state
captured from the exact target page after the operation.

The 22 contract tools, in the advertised order:

| Tool | Required params | Optional params | Notes |
|---|---|---|---|
| `navigate_page` | `type`, `pageId` | `url`, `timeoutMs` | Exact page; URL navigation defaults to 45s readiness |
| `list_pages` | — | — | Deterministic page-ID listing with active markers |
| `new_page` | — | `focus`, `url`, `waitForReady` | Background by default; readiness defaults on |
| `switch_to_page` | `pageId` | `waitForReady` | Focuses exact tab/window and establishes visibility |
| `close_page` | `pageId` | — | Refuses to close the final remaining page |
| `click` | `tabId`, `uid` | `openInNewTab` | Real pointer input; link may open a background tab |
| `fill` | `tabId`, `uid`, `value` | — | Native setter plus input/change events |
| `fill_form` | `tabId`, `elements` | — | Ordered array of `{uid, value}` |
| `upload_file` | `tabId`, `uid` | top-level fields or `file` | Inline base64 only; no host filesystem path |
| `type_text` | `tabId`, `text` | `submitKey` | Types into the previously focused control |
| `scroll_page` | `tabId`, `direction`, `numPages` | — | `direction` is `up` or `down` |
| `wait_for` | `tabId`, `text` | `timeout` | Non-empty text array; resolves when any item appears |
| `wait_for_url` | `pattern` | `tabId`, `timeout` | Glob (`*`, `?`) or substring matching |
| `wait_for_network_idle` | — | `tabId`, `idleMs`, `timeout` | Document readiness plus DOM-mutation quiet window |
| `wait_for_condition` | `expression` | `tabId`, `pollMs`, `timeout` | Polls caller-supplied JavaScript until truthy |
| `evaluate_script` | `function` | `tabId`, `args` | Function declaration; string arguments; promises awaited |
| `press_key` | `tabId`, `keys` | `index` | Optional snapshot index focus, then key/chord delivery |
| `hover` | `tabId`, `index` | `duration` | Holds pointer over snapshot index |
| `drag` | `tabId`, `source`, `target` | `duration` | Selector, uid/index, or `{x,y}` endpoints |
| `resize_page` | `tabId`, `width`, `height` | `deviceScaleFactor` | Viewport emulation |
| `take_screenshot` | `tabId` | `maxWidth`, `grayscale`, `quality`, `detail` | Cost-aware JPEG (PNG at quality 90) image block |
| `take_snapshot` | — | `format`, `compact`, `maxDepth`, `scopeSelector`, `changedOnly`, `pageId`, `tabId` | Markdown/accessibility/ARIA with stable uids |

Local extras beyond the established contract (kept from the prototype, clearly
annotated in tools/list):

| Tool | Required params | Optional params | Notes |
|---|---|---|---|
| `get_text` | — | `tabId` | Visible `innerText` of the page |
| `evaluate` | `expression` | `tabId` | Evaluates a bare JS expression |

### The uid workflow

Call `take_snapshot` before interacting with elements. It returns compact
references such as `@e12`; pass those as `uid` to click/fill/upload, or as the
numeric `index` where the Vibe schema uses an index. Drag accepts a uid/index,
CSS selector, or coordinates. Uids are valid only for the **latest** snapshot
of that tab — taking a new snapshot renumbers them, and navigation invalidates
them. If a uid goes stale the tool fails closed with
`Element @eN is stale; call take_snapshot again` (after attempting exactly one
relocation by role and accessible name).

### Readiness vs. waiting

Navigation-flavored tools establish bounded readiness: `new_page` and
`navigate_page` use 45 seconds by default, while `switch_to_page` uses 15.
The extension polls tab status until the page completes loading. On timeout it
**succeed**, appending the warning suffix
`(page did not reach readyState=complete within Ns; it may still be loading)`.

The `wait_for*` tools **hard-error** on timeout with `Timed out after Nms
waiting for …`. Defaults match Vibe: 10 seconds for text/DOM quiet and 15
seconds for URL/condition. Long waits are kept alive end-to-end by progress
frames that extend the server-side call timer.

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

Doctor hashes installed allowlisted files before parsing configuration and
never imports or executes installed JavaScript. It reports whether the
effective route is immutable; profile artifacts must be locked and match their
packaged name/port metadata. Modified or stale installs fail closed.

### Upgrade and rollback

1. Bump the version in all five places (root `package.json`,
   `server/package.json`, `extension/manifest.json`,
   `server/src/contract.ts`, and `package-lock.json`) — the packager, doctor,
   and tests all refuse to run with mismatched versions.
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
- `upload_file` accepts owner-supplied inline base64 only. Its schema and
  executor reject arbitrary host filesystem paths.
- One server process owns each port. Configure one MCP host process per
  port/profile pair.

## Testing

```bash
npm test          # build + all seven suites (below)
npm run test:browser  # just the real-browser suite
```

The suite, in order:

1. **contract-sync** — both production copies deep-match the independent live
   Vibe 0.3.6 fixture (order, text, schemas, defaults, and annotations), with
   synchronized package/manifest/lockfile versions.
2. **e2e** — the real bridge against a scripted fake extension: handshake
   happy path, close codes 4400/4403/4426, progress-extends-timeout, replay
   across reconnects, `waitForContract`.
3. **mcp-contract** — launches the real stdio CLI using `start --port` and
   proves its actual tools/list matches the live fixture.
4. **profile-isolation** — 12 concurrent bridge+extension pairs stay fully
   isolated; a cross-wired profile is rejected without disturbing the others;
   12 parallel calls route correctly.
5. **local-only-audit** — source-level regex audit that no relay, fetch,
   XHR, beacon, or non-loopback WebSocket code exists in any shipped file.
6. **deployment** — packages locked profile artifacts twice, proves identical
   hashes, and verifies the inert hash-first doctor path.
7. **browser-e2e** — loads a stamped extension into a real headless Chromium
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
extension/config.js           Development defaults or locked stamped fleet route
server/src/contract.ts        Vibe-compatible production contract + validation
server/src/                   TypeScript MCP server and loopback bridge
server/test/fixtures/         Independent captured Vibe 0.3.6 tools/list fixture
server/test/                  Seven test suites (see Testing)
scripts/package-extension.mjs Deterministic zip packager + profile stamping
scripts/doctor.mjs            Installation and deployment verification
scripts/clean.mjs             Removes generated output
```

## Commands

```bash
npm run build     # Compile the server
npm test          # Build + all seven test suites (requires a Chromium binary)
npm run doctor    # Check environment, versions, contract; --extension-dir verifies a deploy
npm run package   # Deterministic extension zips; --profile name:port stamps copies
npm run clean     # Remove server/dist and dist
```

## License

Apache-2.0. See [LICENSE](LICENSE). Legal attribution in the license is retained
for provenance; it is not part of the product name or user-facing identity.

# Browser MCP compatibility feedback

> Resolution status (Browser MCP 1.2.0): this document records the original
> migration feedback. The migration-blocking corrections identified in the
> follow-up audit are implemented in 1.2.0 and covered by the live Vibe 0.3.6
> golden contract plus bridge, stdio, 12-profile, deployment, local-only, and
> real-Chrome test suites. Longer-term hardening items remain recorded below.

## Executive summary

The local-only extraction is the right product direction, but the current implementation is not a compatible extraction of the existing browser MCP experience. It is a new, smaller browser-control prototype with a different CLI, a different connection model, different tool names, different schemas, missing capabilities, and weaker readiness behavior.

That misses the market for this project.

The primary customer for an extracted browser MCP is an existing automation operator who wants to remove hosted relay, account, telemetry, and remote-control dependencies **without rewriting every agent, prompt, skill, scheduled job, validator, and credential workflow that already uses the established browser tool contract**. A greenfield 15-tool API is not a replacement for the existing 22-tool contract, even when several operations are conceptually similar.

The required outcome is straightforward:

> Preserve the existing local browser MCP contract exactly at the MCP and browser-behavior boundaries, while replacing the internals with the new small, local-only server and extension.

Internal simplification is welcome. External incompatibility is not.

## What the extraction got right

These parts should be preserved:

- MCP is exposed over stdio only.
- The extension bridge binds explicitly to IPv4 loopback.
- There is no hosted relay, remote URL, account, routing UUID, OAuth flow, telemetry, crash reporting, or remote-control mode.
- There is no detached relay daemon.
- There is no hidden `chrome-devtools-mcp` fallback to stock Chrome.
- The extension is small, unbundled, and inspectable.
- Requests have IDs, timeouts, replay handling, and bounded response caching.
- The extension uses the supported `chrome.debugger` API without requiring a Chrome remote-debugging endpoint.
- The server emits MCP tool-list change notifications when the extension connects or disconnects.

Those are valuable implementation improvements. They do not require changing the public product contract.

## Where the current release misses the market

### 1. It is presented as an extraction but behaves as a redesign

The existing implementation exposes a mature 22-tool surface. This repository exposes 15 tools, only five of which retain the same name. Even those five use different parameter names or interaction semantics.

For example:

| Established contract | Current Browser MCP |
|---|---|
| `list_pages` | `list_tabs` |
| `new_page` | `new_tab` |
| `switch_to_page` | `select_tab` |
| `navigate_page` | `navigate` |
| `take_snapshot` | `snapshot` |
| `click({ tabId, uid })` | `click({ tabId, ref })` |
| `fill({ tabId, uid, value })` | `fill({ tabId, ref, text })` |
| `press_key({ tabId, keys })` | `press_key({ tabId, key })` |

This is not source compatibility, schema compatibility, behavioral compatibility, or prompt compatibility.

Changing an MCP schema is an API break. Models receive those schemas directly, and production skills and scheduled prompts often reinforce the field names. “The model can probably adapt” is not a compatibility strategy.

### 2. Eight production capabilities were removed

The current repository omits:

- `fill_form`
- `upload_file`
- `wait_for`
- `wait_for_url`
- `wait_for_network_idle`
- `wait_for_condition`
- `drag`
- `resize_page`

These are not edge features. Wait tools are foundational reliability primitives for modern asynchronous applications. File upload, multi-field fill, drag, and viewport resize are ordinary business-automation requirements.

An agent forced to replace a bounded `wait_for_url` call with repeated snapshots or arbitrary JavaScript is slower, more expensive, less deterministic, and more likely to mutate the wrong page.

### 3. The hard-coded port makes the extension unusable for profile-isolated fleets

The server accepts `--extension-port`, but the extension hard-codes:

```js
const BRIDGE_URL = 'ws://127.0.0.1:19889';
```

This supports one browser MCP instance on one machine. It does not support multiple isolated Chrome profiles, multiple agents, concurrent browser identities, or staged migration.

When multiple profile extensions connect to the same port, the most recent socket replaces the previous one. That is not merely inconvenient; it breaks browser-profile isolation.

The extension endpoint must be configurable per installed browser profile. The server and extension should also exchange an expected profile identifier and protocol version so a wrong-profile connection fails closed.

### 4. Page selection lost critical behavior

The established `switch_to_page` behavior activates the tab, focuses its owning Chrome window, and waits for page visibility/readiness. The current `select_tab` only activates a tab.

That difference breaks exact-window workflows where the active tab title is used to bind an MCP page to a separately attested native browser window. It also makes subsequent key delivery and visible-tab capture ambiguous when Chrome has multiple windows.

### 5. Navigation and creation no longer establish readiness

The current `navigate` returns immediately after `chrome.tabs.update`. It does not establish navigation completion, document readiness, URL arrival, or DOM quiet.

The established behavior includes bounded readiness for navigation and page creation, plus explicit URL, text, condition, and DOM/network-idle wait tools. Those guarantees need to survive the extraction.

### 6. Startup can report success with no browser tools

`tools/list` waits three seconds and then returns an empty list if no extension is connected. The MCP process remains alive and can therefore look healthy to a host even though it cannot control a browser.

A production server should have an explicit mode such as:

```text
--require-extension
--extension-connect-timeout <milliseconds>
```

In that mode it should either connect to the expected extension and publish the full reviewed tool contract or exit with a clear error. An empty tool list should not masquerade as a successful browser MCP startup.

### 7. The extension is not deployable as a fleet artifact

“Load unpacked” is useful for development, but it is not a complete deployment story for a multi-profile operational fleet.

The project needs:

- deterministic extension versioning;
- a stable build or packaging procedure;
- per-profile configuration;
- a documented upgrade and rollback path;
- a way to verify the installed extension hash/version/profile/port;
- tests proving that 12 or more profile instances can operate concurrently.

### 8. The tests validate the bridge, not the browser product

The current end-to-end test uses a fake WebSocket extension that exposes an `echo` tool. It proves bridge correlation, but it does not test any real browser operation.

There are no automated real-Chromium tests for:

- navigation readiness;
- accessibility snapshots;
- stale references;
- controlled inputs;
- multiple windows;
- cross-origin frames;
- clipboard key chords;
- screenshots;
- upload;
- extension service-worker restart;
- tab closure during a call;
- exact request replay behavior after worker replacement.

The isolation source audit is useful but insufficient as a product acceptance suite.

## Required compatibility contract

The compatibility surface below should be treated as normative. Browser MCP may add new tools later, but it must retain these names, inputs, defaults, and behaviors for a replacement release.

### Common page-state option

Every tool accepts the optional field:

```json
{
  "pageStateFormat": {
    "type": "string",
    "enum": ["markdown", "accessibility_tree"]
  }
}
```

When requested, the returned state must correspond to the exact target page after the operation. Page-state capture must not silently switch to a different active tab.

### Page lifecycle tools

#### `list_pages`

- No required fields.
- Returns every page ID, active state, title, and URL visible to the installed browser profile.
- Output ordering must be deterministic.

#### `new_page`

Inputs:

- `focus?: boolean` — default `false`.
- `url?: string`.
- `waitForReady?: boolean` — default `true`.

Behavior:

- Creates one page.
- Returns its exact page ID.
- When `waitForReady` is true, does not return until bounded navigation/readiness checks complete.
- Does not unexpectedly steal focus when `focus` is false.

#### `switch_to_page`

Inputs:

- `pageId: number` — required.
- `waitForReady?: boolean` — default `true`.

Behavior:

- Activates the page.
- Focuses the page's owning Chrome window.
- Establishes visibility/readiness when requested.
- Fails clearly when the page no longer exists.

#### `close_page`

Inputs:

- `pageId: number` — required.

Behavior:

- Closes only the requested page.
- Refuses to close the final remaining page.

#### `navigate_page`

Inputs:

- `type: "url" | "back" | "forward" | "reload"` — required.
- `pageId: number` — required.
- `url?: string` — required when `type` is `url`.
- `timeoutMs?: number` — default `45000`.

Behavior:

- Operates only on the supplied page.
- Applies destination validation before navigation.
- Waits for bounded navigation/readiness completion.
- Reports the resulting page ID and URL.

### Snapshot and visual-state tools

#### `take_snapshot`

Inputs:

- `format?: "markdown" | "accessibility_tree" | "aria"` — default `markdown`.
- `compact?: boolean`.
- `maxDepth?: number`.
- `scopeSelector?: string`.
- `changedOnly?: boolean`.
- `pageId?: number`.
- `tabId?: number` — retained alias for `pageId`.

Behavior:

- Produces stable UIDs that the interaction tools accept.
- Supports compact and scoped semantic capture.
- Preserves role/name semantics required for forms, editors, and contenteditable controls.
- Detects unchanged state when `changedOnly` is requested.
- Handles stale references through one bounded relocation attempt; ambiguous relocation fails closed.

#### `take_screenshot`

Inputs:

- `tabId: number` — required.
- `maxWidth?: number` — default `1024`.
- `grayscale?: boolean` — default `false`.
- `quality?: number` — default `70`.
- `detail?: "low" | "high"` — default `low`.

Behavior:

- Captures the exact requested page.
- Returns a valid MCP image result.
- Applies the requested token/cost-aware image processing.
- Does not leave an unrelated tab or window active after capture.

### Interaction tools

#### `click`

Inputs:

- `tabId: number` — required.
- `uid: string | number` — required.
- `openInNewTab?: boolean`.

Behavior:

- Resolves the UID from the latest snapshot.
- Uses browser-faithful input behavior.
- Reports a newly opened tab ID when applicable.

#### `fill`

Inputs:

- `tabId: number` — required.
- `uid: string | number` — required.
- `value: string` — required.

Behavior:

- Replaces the existing value.
- Supports input, textarea, select, and contenteditable controls.
- Emits the expected input/change events for controlled applications.

#### `fill_form`

Inputs:

- `tabId: number` — required.
- `elements: Array<{ uid: string | number, value: string }>` — required and non-empty.

Behavior:

- Fills each supplied field in order.
- Stops with a clear field-specific error on failure.

#### `upload_file`

Inputs:

- `tabId: number` — required.
- `uid: string | number` — required.
- Top-level `filename?`, `mimeType?`, `contentBase64?`, and legacy `content?`.
- Or `file?: { filename, mimeType, contentBase64?, content? }`.

Behavior:

- Accepts owner-supplied base64 content without requiring an arbitrary host filesystem path.
- Delivers it only to the exact referenced file input.
- Emits the browser events expected by the page.

#### `type_text`

Inputs:

- `tabId: number` — required.
- `text: string` — required.
- `submitKey?: string`.

Behavior:

- Types into the previously focused control.
- Optionally sends the requested submit key afterward.
- Does not require a new `ref` field that the established contract never used.

#### `press_key`

Inputs:

- `tabId: number` — required.
- `keys: string` — required.
- `index?: number`.

Behavior:

- Supports established chord spellings, including macOS paste chords.
- Targets the requested page and focused control.
- Uses `keys`, not the incompatible singular `key` field.

#### `hover`

Inputs:

- `tabId: number` — required.
- `index: number` — required.
- `duration?: number` — default `1000`.

#### `drag`

Inputs:

- `tabId: number` — required.
- `source` — required selector or `{ x, y }` coordinates.
- `target` — required selector or `{ x, y }` coordinates.
- `duration?: number` — default `500`.

#### `scroll_page`

Inputs:

- `tabId: number` — required.
- `direction: "up" | "down"` — required.
- `numPages: number` — required.

#### `resize_page`

Inputs:

- `tabId: number` — required.
- `width: number` — required.
- `height: number` — required.
- `deviceScaleFactor?: number`.

### Wait tools

#### `wait_for`

Inputs:

- `tabId: number` — required.
- `text: string[]` — required and non-empty.
- `timeout?: number` — default `10000`.

Behavior:

- Resolves when any supplied text appears.
- Searches accessible page/frame content consistently.
- Returns a bounded timeout error containing useful non-secret state.

#### `wait_for_url`

Inputs:

- `tabId?: number`.
- `pattern: string` — required.
- `timeout?: number` — default `15000`.

Behavior:

- Supports `*` and `?` glob matching.
- Treats a pattern without glob characters as a substring.
- Polls browser tab state so it survives full-page navigation.

#### `wait_for_network_idle`

Inputs:

- `tabId?: number`.
- `idleMs?: number` — default `800`.
- `timeout?: number` — default `10000`.

Behavior:

- Waits for document readiness and a bounded DOM-mutation quiet window.
- Does not claim true network quiet when it is only measuring DOM quiet; the returned description should be precise.

#### `wait_for_condition`

Inputs:

- `tabId?: number`.
- `expression: string` — required.
- `pollMs?: number` — default `250`.
- `timeout?: number` — default `15000`.

Behavior:

- Polls the supplied expression until truthy or timeout.
- Survives transient evaluation failures during navigation.

### Script evaluation

#### `evaluate_script`

Inputs:

- `tabId?: number`.
- `function: string` — required JavaScript function declaration.
- `args?: string[]`.

Behavior:

- Preserves function-plus-arguments semantics rather than replacing them with a raw `expression` field.
- Resolves accessibility references in arguments when supported.
- Always returns valid MCP content, including when JavaScript returns `undefined`.

## CLI and process compatibility

The new implementation should retain compatibility entry points even if the internals no longer need the legacy relay topology.

At minimum:

- Accept the established `start` subcommand.
- Accept the established environment-provided extension port.
- Accept a command-line port override.
- Provide a deprecation window for old environment names rather than failing immediately.
- Continue using stdio as the MCP transport.
- Do not reintroduce a hosted relay or agent TCP listener merely to preserve an unused flag.
- Shut down the WebSocket listener when the MCP process exits.
- Leave no detached child, relay, DevTools fallback, or telemetry watchdog.

The extension must support a profile-specific endpoint through one of:

1. a generated profile configuration module;
2. profile-local `chrome.storage` configuration with a safe first-run setup; or
3. a managed extension configuration.

A single compiled constant is not sufficient.

## Reliability requirements

The extracted implementation should preserve or improve these operational guarantees:

- One request ID from MCP call through extension response.
- A bounded server timeout and a shorter bounded extension timeout.
- Replay of unresolved calls when the extension socket is replaced.
- Deduplication of replayed calls while the original execution is running.
- Cached replay response after execution completes.
- Stale socket-close events cannot disconnect a newer socket.
- Heartbeats detect half-open connections.
- Extension reconnect uses bounded exponential backoff.
- Dynamic tool changes are announced through MCP.
- A required-extension startup mode fails clearly rather than publishing an empty healthy server.
- Tab closure, navigation, and extension-worker restart return actionable errors.
- Calls are bound to the exact supplied page ID; active-tab fallback is used only where the established schema permits an omitted page ID.
- Page/window ambiguity fails closed.

## Security and isolation requirements

Local-only is necessary but not sufficient for a profile-isolated product.

Required controls:

- Bind only to `127.0.0.1`.
- No `0.0.0.0`, IPv6 wildcard, remote URL, hosted relay, HTTP/SSE transport, or remote WebSocket client.
- No stock-Chrome fallback.
- No separate `chrome-devtools-mcp` process.
- No remote-debugging endpoint, flag, pipe, or discovery.
- Configurable unique port per browser profile.
- Profile/version handshake before accepting tool publication.
- A wrong-profile extension must not replace the expected profile connection.
- Clearly document that `chrome.debugger` is internal CDP and does not create a remote-debugging endpoint.
- Retain exact destination validation for navigation.
- Refuse restricted/system pages where Chrome cannot safely provide the requested operation.
- Treat `evaluate_script`, upload, click, fill, drag, and key delivery as mutating/open-world capabilities in tool metadata.

## Deployment requirements

A production-ready release needs:

- a tagged version;
- a committed lockfile;
- reproducible server build instructions;
- an installable or deterministically generated extension artifact;
- extension and server version compatibility checking;
- a documented offline runtime mode;
- artifact hashes or equivalent provenance;
- upgrade and rollback instructions;
- a health check that distinguishes “listener exists” from “correct extension connected and full tools published.”

The npm package may remain local/private, but the release artifact must be pin-able. “Clone main and run npm install” is not a sufficient production dependency strategy.

## Required test matrix

### Contract tests

- Store a golden `tools/list` fixture from the established implementation.
- Deep-compare all 22 names, descriptions, input schemas, required fields, enum values, and defaults.
- Execute representative calls using the established argument shapes.
- Prove that compatibility aliases do not change the canonical tool list.

### Bridge and lifecycle tests

- Extension starts before server.
- Server starts before extension.
- Extension disconnects and reconnects.
- Replacement socket arrives during an active call.
- Old socket closes after replacement.
- Server terminates during a call.
- Extension never arrives in required-extension mode.
- Port is occupied.
- Wrong profile/version connects.
- Twelve profile servers and extensions run concurrently on unique ports.
- Shutting down every server leaves no listener or child process.

### Real Chromium tests

- List, create, select, navigate, and close pages.
- Refuse final-page closure.
- Back, forward, and reload.
- Window focus with multiple Chrome windows.
- Readiness after navigation and SPA route changes.
- Markdown, accessibility-tree, and ARIA snapshots.
- Compact, depth-limited, scoped, and changed-only snapshots.
- Click, fill, multi-fill, typing, paste chord, hover, drag, and scroll.
- Native and framework-controlled form fields.
- Contenteditable fields.
- File upload from base64 content.
- URL, text, condition, and DOM-idle waits.
- Screenshot processing and active-tab restoration.
- Same-origin iframe and cross-origin iframe behavior.
- Stale UID recovery and ambiguous recovery failure.
- Extension service-worker suspension/restart.

### Local-only audit

Retain the current forbidden-pattern audit, and add assertions that:

- no optional dependency starts a DevTools fallback;
- no detached process is spawned;
- no telemetry dependency is invoked;
- only the configured loopback port is listened on;
- browser navigation is the only expected source of internet traffic.

## Definition of done

Browser MCP is a compatible replacement only when all of the following are true:

- [ ] The canonical MCP tool list contains the established 22 tools.
- [ ] Tool names and input schemas match the golden compatibility fixture.
- [ ] The eight omitted capabilities are restored.
- [ ] Existing callers do not need to rename fields such as `uid`, `value`, `keys`, or `function`.
- [ ] Navigation and page creation retain bounded readiness behavior.
- [ ] Page switching focuses the owning Chrome window.
- [ ] Snapshot UID semantics remain usable by all interaction tools.
- [ ] The extension endpoint is configurable per browser profile.
- [ ] Multiple profile instances cannot replace or cross-connect to one another.
- [ ] Startup cannot report a healthy empty browser server in required-extension mode.
- [ ] The server leaves no relay, fallback, telemetry, or detached child process.
- [ ] Real-Chromium tests cover the complete tool contract.
- [ ] A versioned, reproducible extension and server artifact can be deployed and rolled back.
- [ ] The local-only and no-remote-control properties remain intact.

## Product recommendation

Do not ask existing operators to migrate their agents to the current 15-tool API. That transfers the extraction cost from the browser MCP team to every downstream customer and defeats the value proposition of the extraction.

Instead:

1. Keep the new local-only bridge and small extension architecture.
2. Restore the established MCP contract as a compatibility layer.
3. Make the extension profile-configurable.
4. Restore production readiness, wait behavior, and missing tools.
5. Ship contract fixtures and real-browser tests.
6. Version the result as the actual drop-in local replacement.

The market opportunity is not “another minimal browser tool server.” The opportunity is **the existing mature browser automation surface, without hosted infrastructure, remote routing, accounts, telemetry, or cross-browser ambiguity**. Deliver that exact compatibility boundary and the extraction becomes immediately useful to established fleets. Change the boundary, and the product competes as an immature greenfield browser agent against many already available alternatives.

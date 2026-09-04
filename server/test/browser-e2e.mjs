/**
 * Real-browser end-to-end test: a stamped extension in headless Chromium
 * against the real bridge and local HTTP pages, exercising the full reviewed
 * tool surface. This test is REQUIRED — it fails hard when no Chrome binary
 * is available (set CHROME_BIN to override discovery).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalExtensionBridge } from '../dist/bridge.js';
import { freePort, sleep } from './fake-extension.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const PROFILE = 'e2e';

// --- Chrome discovery (hard requirement) -----------------------------------

function cachedTestingBrowsers() {
  // Branded Google Chrome >= 137 ignores --load-extension; Chrome for Testing
  // and Chromium builds keep it. Prefer cached automation browsers.
  const home = homedir();
  const roots = [
    join(home, '.cache', 'puppeteer', 'chrome'),
    join(home, 'Library', 'Caches', 'ms-playwright'),
    join(home, '.cache', 'ms-playwright'),
  ];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const version of readdirSync(root).sort().reverse()) {
      const versionDir = join(root, version);
      let platforms = [];
      try { platforms = readdirSync(versionDir); } catch { continue; }
      for (const platform of platforms) {
        for (const suffix of [
          join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
          join('Chromium.app', 'Contents', 'MacOS', 'Chromium'),
          'chrome',
          'chrome-linux/chrome',
        ]) {
          const candidate = join(versionDir, platform, suffix);
          if (existsSync(candidate)) found.push(candidate);
        }
      }
    }
  }
  return found;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ...cachedTestingBrowsers(),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const chromeBin = findChrome();
if (!chromeBin) {
  console.error('browser-e2e: FAIL — no Chrome/Chromium binary found.');
  console.error('  This real-browser test is required: it validates the actual tool contract against a live extension.');
  console.error('  Install Google Chrome or Chromium, or set CHROME_BIN=/path/to/chrome and rerun.');
  process.exit(1);
}
if (!process.env.CHROME_BIN && /\/Applications\/Google Chrome(?: Canary)?\.app\//.test(chromeBin)) {
  console.error(`browser-e2e: FAIL — only branded Chrome was found at ${chromeBin}.`);
  console.error('  Current branded Chrome releases ignore --load-extension; use Chrome for Testing/Chromium or set CHROME_BIN explicitly.');
  process.exit(1);
}

// --- Test pages ------------------------------------------------------------

const INDEX_HTML = `<!doctype html>
<html><head><title>Local MCP Test Page</title></head>
<body>
<h1>Local MCP Test Page</h1>
<p><a id="go" href="/page2.html">Go to page two</a></p>
<p><label for="name">Name</label> <input id="name" type="text"></p>
<p><label for="email">Email</label> <input id="email" type="text"></p>
<p id="auth-email">person@example.com</p>
<p><label for="sms-code">Verification code</label> <input id="sms-code" name="sms-code" type="number" inputmode="numeric" maxlength="6"></p>
<p><label for="file">Attachment</label> <input id="file" type="file"></p>
<p><button id="save">Save</button></p>
<div id="status"></div>
<div id="dragA" role="button" aria-label="Drag source" style="width:90px;height:40px;background:#cce">A</div>
<div id="dragB" role="button" aria-label="Drop target" style="width:90px;height:40px;background:#ecc">B</div>
<div style="height:2000px"></div>
<script>
  document.getElementById('save').addEventListener('click', () => {
    setTimeout(() => { document.getElementById('status').textContent = 'Saved!'; }, 300);
  });
  window.__events = [];
  document.getElementById('dragA').addEventListener('mousedown', () => window.__events.push('down:A'));
  document.getElementById('dragB').addEventListener('mouseup', () => window.__events.push('up:B'));
  document.getElementById('dragB').addEventListener('mouseover', () => window.__events.push('over:B'));
</script>
</body></html>`;

const PAGE2_HTML = `<!doctype html>
<html><head><title>Second Page</title></head>
<body><h1>Page two</h1><a href="/">home</a></body></html>`;

// --- Harness ---------------------------------------------------------------

const watchdog = setTimeout(() => {
  console.error('browser-e2e: FAIL — 180s watchdog fired (something hung)');
  process.exit(1);
}, 180_000);

const bridgePort = await freePort();
const bridge = new LocalExtensionBridge({
  port: bridgePort,
  profile: PROFILE,
  debug: Boolean(process.env.DEBUG_BROWSER_E2E),
});
await bridge.start();

const pages = { '/': INDEX_HTML, '/index.html': INDEX_HTML, '/page2.html': PAGE2_HTML };
const httpServer = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const body = pages[path];
  if (!body) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
});
await new Promise((done) => httpServer.listen(0, '127.0.0.1', done));
const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

// Stamp a copy of the extension for this test's port + profile.
const extensionDir = await mkdtemp(join(tmpdir(), 'local-mcp-ext-'));
await cp(resolve(repoRoot, 'extension'), extensionDir, { recursive: true });
await writeFile(join(extensionDir, 'config.js'),
  `export default { port: ${bridgePort}, profile: ${JSON.stringify(PROFILE)} };\n`);

const cleanups = [];
let chromeChild = null;
let chromeStderr = '';

async function launchChrome(headlessFlag) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'local-mcp-profile-'));
  cleanups.push(() => rm(userDataDir, { recursive: true, force: true }));
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--silent-debugger-extension-api',
    // Re-enables --load-extension on branded Chrome builds that gate it.
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    'about:blank',
  ];
  if (headlessFlag) args.splice(args.length - 1, 0, headlessFlag);
  const child = spawn(chromeBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  chromeStderr = '';
  child.stderr.on('data', (chunk) => {
    chromeStderr += chunk;
    if (chromeStderr.length > 20_000) chromeStderr = chromeStderr.slice(-10_000);
  });
  return child;
}

async function stopChrome(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((done) => child.once('exit', done)), sleep(2_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

// Newer Chrome uses plain --headless for the new headless mode; older builds
// want --headless=new for extension support. Try both. macOS Chrome for
// Testing currently ignores unpacked extensions in headless mode, so local
// real-browser verification can opt into a headed run explicitly.
const headed = process.env.BROWSER_E2E_HEADED === '1';
chromeChild = await launchChrome(headed ? null : '--headless=new');
let contract = await bridge.waitForContract(25_000);
if (!contract.ok && !headed) {
  await stopChrome(chromeChild);
  chromeChild = await launchChrome('--headless');
  contract = await bridge.waitForContract(25_000);
}
if (!contract.ok) {
  console.error('browser-e2e: FAIL — extension never served the contract:');
  for (const problem of contract.problems) console.error(`  - ${problem}`);
  if (chromeStderr.trim()) console.error(`  chrome stderr tail:\n${chromeStderr.slice(-2_000)}`);
  process.exit(1);
}

// --- Assertion helpers -----------------------------------------------------

const text = (result) => (result.content ?? [])
  .map((item) => (item.type === 'text' ? item.text : `[${item.type}]`))
  .join('\n');

async function call(name, args = {}, timeoutMs = 30_000) {
  const result = await bridge.callTool(name, args, timeoutMs);
  assert.ok(!result.isError, `${name} should succeed, got: ${text(result)}`);
  return text(result);
}

async function callRaw(name, args = {}, timeoutMs = 30_000) {
  return bridge.callTool(name, args, timeoutMs);
}

async function callError(name, args = {}, timeoutMs = 30_000) {
  const result = await bridge.callTool(name, args, timeoutMs);
  assert.ok(result.isError, `${name} should fail, got: ${text(result)}`);
  return text(result);
}

function uidByName(snapshot, name, role) {
  const quoted = JSON.stringify(name);
  const line = snapshot.split('\n').find((entry) => entry.trimStart().startsWith('@e')
    && entry.includes(quoted)
    && (!role || entry.includes(`[${role}]`) || entry.includes(`role=${JSON.stringify(role)}`)));
  assert.ok(line, `snapshot has ${role ?? 'a node'} named ${quoted}; snapshot was:\n${snapshot}`);
  return line.trimStart().split(' ')[0];
}

let failed = false;
try {
  // 24 tools advertised through the bridge.
  assert.equal(bridge.getTools().length, 24, 'extension advertises 24 tools');

  // new_page: bounded readiness with no warning on a fast local page.
  const opened = await call('new_page', { url: `${baseUrl}/`, focus: true });
  assert.match(opened, /Tab ID: \d+/);
  assert.ok(!opened.includes('did not reach readyState'), `new_page should be ready: ${opened}`);
  assert.ok(opened.includes('Title: Local MCP Test Page'), `title present after readiness: ${opened}`);
  const tabA = Number(opened.match(/Tab ID: (\d+)/)[1]);

  // list_pages: established plain-text format with [ACTIVE] marker.
  let listing = await call('list_pages');
  assert.match(listing, /^Found \d+ page\(s\):/);
  assert.match(listing, new RegExp(`^Page ${tabA} \\[ACTIVE\\]: "Local MCP Test Page" - `, 'm'));
  for (const line of listing.split('\n').slice(1)) {
    assert.match(line, /^Page\s+\d+\s*(\[ACTIVE\])?\s*: ".*" - .+$/, `list_pages line format: ${line}`);
  }

  // take_snapshot supports the exact Vibe options and assigns @eN uids.
  const semanticSnapshot = await call('take_snapshot', { pageId: tabA, format: 'accessibility_tree', compact: true, maxDepth: 20 });
  assert.match(semanticSnapshot, /Format: accessibility_tree/);
  const scopedSnapshot = await call('take_snapshot', { pageId: tabA, format: 'aria', scopeSelector: '#dragA' });
  assert.match(scopedSnapshot, /Drag source/);
  assert.doesNotMatch(scopedSnapshot, /Drop target/);
  const snapshot = await call('take_snapshot', { tabId: tabA });
  assert.match(snapshot, new RegExp(`^Tab ID: ${tabA}\nTitle: Local MCP Test Page\nURL: `));
  assert.match(snapshot, /Format: markdown/);
  assert.match(await call('take_snapshot', { tabId: tabA, changedOnly: true }), /Snapshot unchanged/);
  const nameUid = uidByName(snapshot, 'Name', 'textbox');
  const emailUid = uidByName(snapshot, 'Email', 'textbox');
  const otpUid = uidByName(snapshot, 'Verification code', 'spinbutton');
  const saveUid = uidByName(snapshot, 'Save', 'button');
  const dragAUid = uidByName(snapshot, 'Drag source', 'button');
  const dragBUid = uidByName(snapshot, 'Drop target', 'button');
  const fileUid = uidByName(snapshot, 'Attachment');

  // fill + verify through the page itself.
  const filledWithState = await call('fill', { uid: nameUid, value: 'hello', tabId: tabA, pageStateFormat: 'markdown' });
  assert.match(filledWithState, new RegExp(`Page state \\(markdown\\) for tab ${tabA}`));
  assert.equal(await call('evaluate_script', { function: "() => document.querySelector('#name').value", tabId: tabA }), 'hello');

  // fill_form fills multiple fields in one call (uids stay valid between fields).
  await call('fill_form', {
    elements: [
      { uid: nameUid, value: 'Alice' },
      { uid: emailUid, value: 'alice@example.com' },
    ],
    tabId: tabA,
  });
  assert.equal(
    await call('evaluate_script', {
      function: "() => [document.querySelector('#name').value, document.querySelector('#email').value].join('|')",
      tabId: tabA,
    }),
    'Alice|alice@example.com',
  );

  // click + wait_for on a 300ms-delayed status message.
  await call('click', { uid: saveUid, tabId: tabA });
  await call('wait_for', { text: ['never-first', 'Saved!'], timeout: 5_000, tabId: tabA });

  // press_key: Shift+h then i inserts "Hi" (the printable-character fix).
  await call('evaluate_script', { function: "() => { const i = document.querySelector('#name'); i.value = ''; i.focus(); }", tabId: tabA });
  await call('press_key', { keys: 'Shift+h', tabId: tabA });
  await call('press_key', { keys: 'i', tabId: tabA });
  assert.equal(await call('evaluate_script', { function: "() => document.querySelector('#name').value", tabId: tabA }), 'Hi');

  // type_text continues at the end of the focused field.
  await call('type_text', { text: ' there', tabId: tabA });
  assert.equal(await call('evaluate_script', { function: "() => document.querySelector('#name').value", tabId: tabA }), 'Hi there');

  // The protected credential broker's private coordinate primitive focuses a
  // screenshot-derived field inside the extension. It is intentionally absent
  // from the public MCP contract, but must remain live for renderer-opaque
  // sign-in forms such as Chase.
  const coordinateTarget = JSON.parse(await call('evaluate_script', {
    function: `() => {
      const field = document.querySelector('#email');
      field.value = '';
      const rect = field.getBoundingClientRect();
      return {
        xRatio: (rect.left + rect.width / 2) / window.innerWidth,
        yRatio: (rect.top + rect.height / 2) / window.innerHeight,
      };
    }`,
    tabId: tabA,
  }));
  await call('click_at_ratio', { tabId: tabA, ...coordinateTarget });
  await call('type_text', { text: 'coordinate-entry', tabId: tabA });
  assert.equal(
    await call('evaluate_script', { function: "() => document.querySelector('#email').value", tabId: tabA }),
    'coordinate-entry',
  );

  // hover fires mouseover on the target.
  await call('hover', { index: Number(dragBUid.replace('@e', '')), duration: 100, tabId: tabA });
  // drag delivers mousedown on the source and mouseup on the target.
  await call('drag', { source: '#dragA', target: '#dragB', duration: 100, tabId: tabA });
  const events = await call('evaluate_script', { function: '() => window.__events.join(",")', tabId: tabA });
  assert.ok(events.includes('over:B'), `hover fired mouseover: ${events}`);
  assert.ok(events.includes('down:A'), `drag pressed on source: ${events}`);
  assert.ok(events.includes('up:B'), `drag released on target: ${events}`);

  // upload_file with the top-level Vibe inline form (no host path).
  await call('upload_file', {
    uid: fileUid,
    filename: 'note.txt',
    mimeType: 'text/plain',
    contentBase64: Buffer.from('hello upload').toString('base64'),
    tabId: tabA,
  });
  assert.equal(
    await call('evaluate_script', { function: "() => document.querySelector('#file').files[0].name", tabId: tabA }),
    'note.txt',
  );

  // scroll_page moves the viewport.
  await call('scroll_page', { direction: 'down', numPages: 1, tabId: tabA });
  const scrolled = Number(await call('evaluate_script', { function: '() => window.scrollY', tabId: tabA }));
  assert.ok(scrolled > 0, `scrolled down ${scrolled}px`);
  await call('scroll_page', { direction: 'up', numPages: 4, tabId: tabA });

  // wait_for_network_idle settles on a static page.
  await call('wait_for_network_idle', { tabId: tabA, timeout: 10_000 });

  // evaluate_script with a callable + args, and the local extras.
  assert.equal(await call('evaluate_script', { function: '(a, b) => Number(a) + Number(b)', args: ['2', '3'], tabId: tabA }), '5');
  assert.equal(await call('evaluate', { expression: '1 + 1', tabId: tabA }), '2');
  assert.ok((await call('get_text', { tabId: tabA })).includes('Local MCP Test Page'));

  // resize_page changes the reported viewport.
  await call('resize_page', { width: 800, height: 600, tabId: tabA });
  assert.equal(await call('evaluate_script', { function: '() => window.innerWidth', tabId: tabA }), '800');

  // take_screenshot honors the Vibe processing options and returns JPEG.
  const shot = await callRaw('take_screenshot', { tabId: tabA, maxWidth: 640, grayscale: true, quality: 60, detail: 'low' });
  assert.ok(!shot.isError, `screenshot should succeed: ${text(shot)}`);
  assert.equal(shot.content[0].type, 'image');
  assert.equal(shot.content[0].mimeType, 'image/jpeg');
  assert.ok(shot.content[0].data.length > 5_000, 'screenshot has real image data');
  assert.deepEqual([...Buffer.from(shot.content[0].data, 'base64').subarray(0, 2)], [0xff, 0xd8], 'screenshot is JPEG');

  // Wait tools fail hard (not warn) on timeout.
  const waitError = await callError('wait_for', { text: ['never-appears-xyz'], timeout: 800, tabId: tabA });
  assert.match(waitError, /Timed out after 800ms/);
  const chordError = await callError('press_key', { keys: 'Bogus+x', tabId: tabA });
  assert.match(chordError, /Unknown modifier: Bogus/);

  // Authentication values and nearby account identifiers are redacted. A
  // fresh snapshot deliberately rotates uids, so use its navigation uids.
  await call('fill', { uid: otpUid, value: '123456', tabId: tabA });
  const protectedSnapshot = await call('take_snapshot', { tabId: tabA, format: 'accessibility_tree' });
  assert.doesNotMatch(protectedSnapshot, /123456/, 'one-time code value must not appear in snapshots');
  assert.match(protectedSnapshot, /\[REDACTED\]/, 'sensitive input subtree is explicitly redacted');
  assert.doesNotMatch(protectedSnapshot, /person@example\.com/, 'account email must not appear beside authentication inputs');
  assert.match(protectedSnapshot, /\[REDACTED EMAIL\]/);
  const navigationLinkUid = uidByName(protectedSnapshot, 'Go to page two', 'link');
  const staleSaveUid = uidByName(protectedSnapshot, 'Save', 'button');

  // wait_for_condition + wait_for_url around real navigation.
  await call('wait_for_condition', { expression: "document.readyState === 'complete'", pollMs: 100, tabId: tabA, timeout: 5_000 });
  await call('click', { uid: navigationLinkUid, tabId: tabA });
  await call('wait_for_url', { pattern: `${baseUrl}/page?.html`, timeout: 5_000, tabId: tabA });

  // Navigation invalidates old snapshot uids (stale interactions fail closed).
  const staleError = await callError('click', { uid: staleSaveUid, tabId: tabA });
  assert.match(staleError, /take_snapshot/);

  // navigate_page: back, then explicit url, both with readiness.
  await call('navigate_page', { type: 'back', pageId: tabA });
  await call('wait_for_condition', { expression: "location.pathname === '/'", tabId: tabA, timeout: 5_000 });
  const navigated = await call('navigate_page', { type: 'url', pageId: tabA, url: `${baseUrl}/page2.html` });
  assert.ok(navigated.includes(`Navigated page ${tabA} (url)`), navigated);
  assert.ok(navigated.includes('Title: Second Page'), `readiness before returning: ${navigated}`);

  // new_page defaults to background; switch_to_page focuses the exact page.
  const openedB = await call('new_page', { url: `${baseUrl}/page2.html` });
  const tabB = Number(openedB.match(/Tab ID: (\d+)/)[1]);
  listing = await call('list_pages');
  assert.ok(!new RegExp(`^Page ${tabB} \\[ACTIVE\\]: `, 'm').test(listing), 'new page is background by default');
  const switchedB = await call('switch_to_page', { pageId: tabB, waitForReady: true });
  assert.ok(switchedB.includes(`Switched to page ${tabB}`), switchedB);
  const switched = await call('switch_to_page', { pageId: tabA });
  assert.ok(switched.includes(`Switched to page ${tabA}`), switched);
  listing = await call('list_pages');
  assert.match(listing, new RegExp(`^Page ${tabA} \\[ACTIVE\\]: `, 'm'));
  assert.ok(!new RegExp(`^Page ${tabB} \\[ACTIVE\\]: `, 'm').test(listing), 'previous tab no longer active');

  // close_page removes the tab from the listing.
  await call('close_page', { pageId: tabB });
  listing = await call('list_pages');
  assert.ok(!listing.includes(`Page ${tabB}`), 'closed tab is gone');

  // Exact page IDs are mandatory for lifecycle calls.
  assert.match(await callError('close_page', { tabId: tabA }), /requires pageId/);
  assert.match(await callError('navigate_page', { type: 'reload', tabId: tabA }), /requires pageId/);

  // Refuse final-page closure after cleaning up every non-owned test page.
  listing = await call('list_pages');
  const allPageIds = [...listing.matchAll(/^Page (\d+)/gm)].map((match) => Number(match[1]));
  for (const pageId of allPageIds) if (pageId !== tabA) await call('close_page', { pageId });
  assert.match(await callError('close_page', { pageId: tabA }), /final remaining page/);

  console.log(`browser e2e ok: full 24-tool contract exercised against a real ${headed ? 'headed' : 'headless'} Chrome`);
} catch (error) {
  failed = true;
  console.error('browser-e2e: FAIL —', error?.message || error);
  if (chromeStderr.trim()) console.error(`chrome stderr tail:\n${chromeStderr.slice(-2_000)}`);
  throw error;
} finally {
  clearTimeout(watchdog);
  await stopChrome(chromeChild);
  await bridge.stop();
  await new Promise((done) => httpServer.close(done));
  await rm(extensionDir, { recursive: true, force: true });
  for (const cleanup of cleanups) await cleanup().catch(() => {});
  if (failed) process.exitCode = 1;
}

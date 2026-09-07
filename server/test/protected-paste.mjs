import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureProtectedServiceTitanSms,
  deliverProtectedClipboardPaste,
  isProtectedPasteCall,
  isProtectedSmsCaptureCall,
  protectedSmsProvider,
  ProfileCredentialBroker,
  ProtectedPasteState,
} from '../dist/protected-paste.js';

function socketExchange(path, request) {
  return new Promise((resolve, reject) => {
    const client = createConnection(path);
    const chunks = [];
    client.on('connect', () => client.end(request));
    client.on('data', (chunk) => chunks.push(chunk));
    client.on('error', reject);
    client.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

assert.equal(isProtectedPasteCall('press_key', { tabId: 7, keys: 'Meta+V' }), true);
assert.equal(isProtectedPasteCall('press_key', { tabId: 7, keys: ' Command + V ' }), true);
assert.equal(isProtectedPasteCall('press_key', { tabId: 7, keys: 'Ctrl+V' }), false);
assert.equal(isProtectedPasteCall('press_key', { tabId: 7, keys: 'Meta+V', index: 2 }), true);
assert.equal(isProtectedPasteCall('press_key', { tabId: 7, keys: 'Meta+V', index: 0 }), true);
assert.equal(isProtectedPasteCall('evaluate', { tabId: 7, keys: 'Meta+V' }), false);
assert.equal(isProtectedSmsCaptureCall('press_key', { tabId: 9, keys: 'Meta+Shift+C' }), true);
assert.equal(isProtectedSmsCaptureCall('press_key', { tabId: 9, keys: ' Command + Shift + C ' }), true);
assert.equal(isProtectedSmsCaptureCall('press_key', { tabId: 9, keys: 'Meta+Shift+P' }), true);
assert.equal(isProtectedSmsCaptureCall('press_key', { tabId: 9, keys: ' Command + Shift + H ' }), true);
assert.equal(isProtectedSmsCaptureCall('press_key', { tabId: 9, keys: 'Meta+C' }), false);
assert.equal(isProtectedSmsCaptureCall('press_key', { tabId: 9, keys: 'Meta+Shift+C', index: 1 }), false);
assert.equal(protectedSmsProvider({ keys: 'Meta+Shift+C' }), 'servicetitan');
assert.equal(protectedSmsProvider({ keys: 'Meta+Shift+P' }), 'paylocity');
assert.equal(protectedSmsProvider({ keys: 'Meta+Shift+H' }), 'chase');
assert.equal(protectedSmsProvider({ keys: 'Meta+Shift+X' }), null);

const dummyValue = 'local-test-clipboard-value';
const clipboard = Buffer.from(dummyValue, 'utf8');
let observed = null;
let clipboardClears = 0;
const bridge = {
  async callTool(name, args, timeoutMs) {
    observed = { name, args, timeoutMs };
    return { content: [{ type: 'text', text: '{"pasted":true}' }] };
  },
};
const result = await deliverProtectedClipboardPaste(
  bridge,
  { tabId: 7, keys: 'Meta+V' },
  async () => clipboard,
  undefined,
  async () => { clipboardClears += 1; },
);
assert.equal(clipboardClears, 1);
assert.equal(observed.name, 'evaluate');
assert.equal(observed.args.tabId, 7);
assert.match(observed.args.expression, new RegExp(JSON.stringify(dummyValue)));
assert.match(observed.args.expression, /document\.activeElement/);
assert.match(observed.args.expression, /field\.value !== ''/);
assert.doesNotMatch(observed.args.expression, /\['text', 'tel', 'number'\]/);
assert.match(observed.args.expression, /return \{ pasted: true \}/);
assert.equal(JSON.stringify(result).includes(dummyValue), false);
assert.deepEqual(result, { content: [{ type: 'text', text: 'Pressed Meta+V' }] });
assert.equal(clipboard.every((byte) => byte === 0), true);

const indexedValue = 'local-test-indexed-value';
const indexedClipboard = Buffer.from(indexedValue, 'utf8');
const indexedPrivateResult = {
  content: [{ type: 'text', text: '{"pasted":true}' }],
};
const indexedObserved = [];
let indexedClipboardClears = 0;
const indexedResult = await deliverProtectedClipboardPaste(
  {
    async callTool(name, args, timeoutMs) {
      indexedObserved.push({ name, args, timeoutMs });
      return indexedPrivateResult;
    },
  },
  { tabId: 7, keys: 'Meta+V', index: 20 },
  async () => indexedClipboard,
  undefined,
  async () => { indexedClipboardClears += 1; },
);
assert.equal(indexedClipboardClears, 1);
assert.deepEqual(indexedObserved, [{
  name: 'fill',
  args: { tabId: 7, uid: 20, value: indexedValue, protectedEntry: true },
  timeoutMs: 15_000,
}]);
assert.equal(indexedPrivateResult.content[0].text, '');
assert.equal(JSON.stringify(indexedResult).includes(indexedValue), false);
assert.deepEqual(indexedResult, {
  content: [{ type: 'text', text: 'Pressed Meta+V' }],
});
assert.equal(indexedClipboard.every((byte) => byte === 0), true);

// Refused/stale indexed targets cannot fall through to typing or expose errors.
for (const throws of [false, true]) {
  const bytes = Buffer.from('synthetic-refused-secret');
  const refused = { isError: true, content: [{ type: 'text', text: 'private-page-error' }] };
  const calls = [];
  await assert.rejects(deliverProtectedClipboardPaste({
    async callTool(name) {
      calls.push(name);
      if (throws) throw new Error('private-page-error');
      return refused;
    },
  }, { tabId: 7, keys: 'Meta+V', index: 999 }, async () => bytes),
  /^Error: Protected clipboard indexed paste was refused$/);
  assert.deepEqual(calls, ['fill']);
  assert.ok(bytes.every(byte => byte === 0));
  if (!throws) assert.equal(refused.content[0].text, '');
}

const coordinateValue = 'local-test-coordinate-value';
const coordinateState = new ProtectedPasteState();
coordinateState.storeCredential(Buffer.from(coordinateValue, 'utf8'));
const coordinateCalls = [];
const coordinatePrivateResults = [];
let coordinateClipboardReads = 0;
const coordinateResult = await deliverProtectedClipboardPaste(
  {
    async callTool(name, args, timeoutMs) {
      coordinateCalls.push({ name, args, timeoutMs });
      const privateResult = {
        content: [{ type: 'text', text: name === 'type_text' ? `Typed ${JSON.stringify(args.text)}` : 'focused' }],
      };
      coordinatePrivateResults.push(privateResult);
      return privateResult;
    },
  },
  { tabId: 18, keys: 'Meta+V', xRatio: 0.625, yRatio: 0.42 },
  async () => {
    coordinateClipboardReads += 1;
    return Buffer.from('ambient-clipboard-must-not-be-read');
  },
  coordinateState,
);
assert.equal(coordinateClipboardReads, 0);
assert.deepEqual(coordinateCalls.map((call) => call.name), ['click_at_ratio', 'type_text']);
assert.deepEqual(coordinateCalls[0].args, { tabId: 18, xRatio: 0.625, yRatio: 0.42 });
assert.equal(coordinateCalls[1].args.text, coordinateValue);
assert.equal(coordinatePrivateResults.every((entry) => entry.content[0].text === ''), true);
assert.equal(JSON.stringify(coordinateResult).includes(coordinateValue), false);
assert.deepEqual(coordinateResult, {
  content: [{ type: 'text', text: 'Pressed Meta+V' }],
});
assert.equal(coordinateState.takeCredential(), null);

// Classify only exact known focus errors before scrubbing; never echo private data.
for (const [text, category] of [
  ['Error: Unknown tool: click_at_ratio', 'primitive_unavailable'],
  ['Error: click_at_ratio could not resolve the current viewport', 'viewport_unavailable'],
  ['private-error INERT-DIAGNOSTIC-VALUE tab=18 xRatio=0.625 snapshot', 'extension_error'],
  ['Error: Unknown tool: click_at_ratio private-suffix', 'extension_error'],
  ['', 'extension_error'],
]) {
  const state = new ProtectedPasteState();
  state.storeCredential(Buffer.from('INERT-DIAGNOSTIC-VALUE'));
  let consumed;
  const take = state.takeCredential.bind(state);
  state.takeCredential = () => (consumed = take());
  const refused = { isError: true, content: [{ type: 'text', text }] };
  const calls = [];
  await assert.rejects(deliverProtectedClipboardPaste({
    async callTool(name) { calls.push(name); return refused; },
  }, { tabId: 18, keys: 'CMD+V', xRatio: 0.625, yRatio: 0.42 },
  async () => { throw new Error('must not read clipboard'); }, state),
  { message: `Protected clipboard coordinate target could not be focused (${category})` });
  assert.deepEqual(calls, ['click_at_ratio']);
  assert.ok(consumed.every(byte => byte === 0));
  assert.equal(take(), null);
  assert.equal(refused.content[0].text, '');
}

// Bridge rejection has no private result to scrub and must not expose its error.
{
  const state = new ProtectedPasteState();
  state.storeCredential(Buffer.from('INERT-DIAGNOSTIC-VALUE'));
  const take = state.takeCredential.bind(state);
  let consumed;
  state.takeCredential = () => (consumed = take());
  const calls = [];
  await assert.rejects(deliverProtectedClipboardPaste({
    async callTool(name) {
      calls.push(name);
      throw new Error('private-transport-error INERT-DIAGNOSTIC-VALUE tab=18');
    },
  }, { tabId: 18, keys: 'CMD+V', xRatio: 0.625, yRatio: 0.42 },
  async () => { throw new Error('must not read clipboard'); }, state),
  { message: 'Protected clipboard coordinate target could not be focused (bridge_error)' });
  assert.deepEqual(calls, ['click_at_ratio']);
  assert.ok(consumed.every(byte => byte === 0));
  assert.equal(take(), null);
}

for (const args of [
  { xRatio: 0.5 },
  { yRatio: 0.5 },
  { xRatio: 0, yRatio: 0.5 },
  { xRatio: 1, yRatio: 0.5 },
  { xRatio: 0.5, yRatio: -0.1 },
  { xRatio: 0.5, yRatio: Number.NaN },
  { xRatio: '0.5', yRatio: 0.5 },
  { index: 20, xRatio: 0.5, yRatio: 0.5 },
]) {
  let invalidCoordinateClipboardReads = 0;
  await assert.rejects(
    () => deliverProtectedClipboardPaste(
      bridge,
      { tabId: 7, keys: 'Meta+V', ...args },
      async () => {
        invalidCoordinateClipboardReads += 1;
        return Buffer.from('must-not-be-read');
      },
    ),
    /coordinate|ratios/,
  );
  assert.equal(invalidCoordinateClipboardReads, 0);
}

let unstagedCoordinateClipboardReads = 0;
await assert.rejects(
  () => deliverProtectedClipboardPaste(
    bridge,
    { tabId: 7, keys: 'Meta+V', xRatio: 0.4, yRatio: 0.6 },
    async () => {
      unstagedCoordinateClipboardReads += 1;
      return Buffer.from('must-not-be-read');
    },
  ),
  /unavailable/,
);
assert.equal(unstagedCoordinateClipboardReads, 0);

const brokerRoot = await mkdtemp(join(tmpdir(), 'profile-credential-broker-'));
const brokerSocket = join(brokerRoot, 'credential.sock');
const brokerState = new ProtectedPasteState();
const broker = new ProfileCredentialBroker(brokerSocket, brokerState);
await broker.start();
try {
  assert.equal((await stat(brokerSocket)).mode & 0o777, 0o600);
  const brokerValue = Buffer.from('profile-local-value', 'utf8');
  const brokerFrame = Buffer.concat([
    Buffer.from(`HERMES-CREDENTIAL/1 ${brokerValue.length}\n`, 'ascii'),
    brokerValue,
  ]);
  assert.equal(String(await socketExchange(brokerSocket, brokerFrame)), 'STAGED\n');
  let brokerClipboardReads = 0;
  const brokerObserved = [];
  const brokerTypedResult = { content: [{ type: 'text', text: '{"pasted":true}' }] };
  const brokerPasteResult = await deliverProtectedClipboardPaste(
    {
      async callTool(name, args, timeoutMs) {
        brokerObserved.push({ name, args, timeoutMs });
        return brokerTypedResult;
      },
    },
    { tabId: 12, keys: 'Meta+V', index: 4 },
    async () => {
      brokerClipboardReads += 1;
      return Buffer.from('global-clipboard-value');
    },
    brokerState,
  );
  assert.equal(brokerClipboardReads, 0);
  assert.deepEqual(brokerObserved.map((call) => call.name), ['fill']);
  assert.equal(brokerObserved[0].args.uid, 4);
  assert.equal(brokerObserved[0].args.protectedEntry, true);
  assert.equal(brokerObserved[0].args.value, 'profile-local-value');
  assert.equal(brokerTypedResult.content[0].text, '');
  assert.deepEqual(brokerPasteResult, {
    content: [{ type: 'text', text: 'Pressed Meta+V' }],
  });
  assert.equal(brokerState.takeCredential(), null);

  const clearValue = Buffer.from('clear-me', 'utf8');
  const clearFrame = Buffer.concat([
    Buffer.from(`HERMES-CREDENTIAL/1 ${clearValue.length}\n`, 'ascii'),
    clearValue,
  ]);
  assert.equal(String(await socketExchange(brokerSocket, clearFrame)), 'STAGED\n');
  assert.equal(String(await socketExchange(brokerSocket, Buffer.from('CLEAR\n'))), 'CLEARED\n');
  assert.equal(brokerState.takeCredential(), null);
} finally {
  await broker.stop();
  await rm(brokerRoot, { recursive: true, force: true });
}

for (const index of [0, -1, 1.5, '20', null]) {
  let invalidIndexClipboardReads = 0;
  await assert.rejects(
    () => deliverProtectedClipboardPaste(
      bridge,
      { tabId: 7, keys: 'Meta+V', index },
      async () => {
        invalidIndexClipboardReads += 1;
        return Buffer.from('must-not-be-read');
      },
    ),
    /positive snapshot index/,
  );
  assert.equal(invalidIndexClipboardReads, 0);
}

const unclearedClipboard = Buffer.from('must-not-be-delivered', 'utf8');
let callsAfterClearFailure = 0;
await assert.rejects(
  () => deliverProtectedClipboardPaste(
    { async callTool() { callsAfterClearFailure += 1; return { content: [] }; } },
    { tabId: 7, keys: 'Meta+V' },
    async () => unclearedClipboard,
    undefined,
    async () => { throw new Error('simulated clear failure'); },
  ),
  /simulated clear failure/,
);
assert.equal(callsAfterClearFailure, 0);
assert.equal(unclearedClipboard.every((byte) => byte === 0), true);

for (const value of (
  [Buffer.alloc(0), Buffer.alloc(65_537, 1), Buffer.from([0xc3, 0x28])]
)) {
  await assert.rejects(
    () => deliverProtectedClipboardPaste(
      bridge,
      { tabId: 7, keys: 'Meta+V' },
      async () => value,
    ),
    /Protected clipboard/,
  );
  assert.equal(value.every((byte) => byte === 0), true);
}

await assert.rejects(
  () => deliverProtectedClipboardPaste(
    bridge,
    { tabId: 0, keys: 'Meta+V' },
    async () => Buffer.from('unused'),
  ),
  /exact tab ID/,
);

const smsState = new ProtectedPasteState();
const dummyCode = '654321';
const privateCaptureResult = {
  content: [{ type: 'text', text: JSON.stringify({ code: dummyCode }) }],
};
let smsCaptureObserved = null;
const smsCaptureBridge = {
  async callTool(name, args, timeoutMs) {
    smsCaptureObserved = { name, args, timeoutMs };
    return privateCaptureResult;
  },
};
const captureResult = await captureProtectedServiceTitanSms(
  smsCaptureBridge,
  { tabId: 9, keys: 'Meta+Shift+C' },
  smsState,
);
assert.equal(smsCaptureObserved.name, 'evaluate');
assert.equal(smsCaptureObserved.args.tabId, 9);
assert.match(smsCaptureObserved.args.expression, /voice\.google\.com/);
assert.doesNotMatch(smsCaptureObserved.args.expression, /document\.visibilityState/);
assert.match(smsCaptureObserved.args.expression, /ocuser@example\.com/);
assert.match(smsCaptureObserved.args.expression, /service\[\\s_-\]\*titan/);
assert.match(smsCaptureObserved.args.expression, /querySelectorAll\('body \*'\)/);
assert.match(smsCaptureObserved.args.expression, /b\.x - a\.x \|\| b\.y - a\.y/);
assert.match(smsCaptureObserved.args.expression, /candidate\.x === best\.x/);
assert.equal(JSON.stringify(captureResult).includes(dummyCode), false);
assert.deepEqual(captureResult, {
  content: [{ type: 'text', text: 'Pressed Meta+Shift+C' }],
});
assert.equal(privateCaptureResult.content[0].text, '');

const smsPasteObserved = [];
let clipboardReads = 0;
const smsBeforeResult = { content: [{ type: 'text', text: '{"ready":true}' }] };
const smsTypedResult = {
  content: [{ type: 'text', text: `Typed ${JSON.stringify(dummyCode)}` }],
};
const smsAfterResult = { content: [{ type: 'text', text: '{"pasted":true}' }] };
const smsPasteBridge = {
  async callTool(name, args, timeoutMs) {
    smsPasteObserved.push({ name, args, timeoutMs });
    if (name === 'type_text') return smsTypedResult;
    return smsPasteObserved.length === 1 ? smsBeforeResult : smsAfterResult;
  },
};
const smsPasteResult = await deliverProtectedClipboardPaste(
  smsPasteBridge,
  { tabId: 11, keys: 'Meta+V' },
  async () => {
    clipboardReads += 1;
    return Buffer.from('unexpected-clipboard-value');
  },
  smsState,
);
assert.equal(clipboardReads, 0);
assert.deepEqual(smsPasteObserved.map((call) => call.name), [
  'evaluate',
  'type_text',
  'evaluate',
]);
assert.equal(smsPasteObserved.every((call) => call.args.tabId === 11), true);
assert.match(smsPasteObserved[0].args.expression, /login\.servicetitan\.com/);
assert.match(smsPasteObserved[0].args.expression, /field\.name === 'sms-code'/);
assert.match(smsPasteObserved[0].args.expression, /\['text', 'tel', 'number'\]/);
assert.match(smsPasteObserved[0].args.expression, /field\.value !== ''/);
assert.doesNotMatch(smsPasteObserved[0].args.expression, new RegExp(dummyCode));
assert.equal(smsPasteObserved[1].args.text, dummyCode);
assert.match(smsPasteObserved[2].args.expression, /\\d\{6\}/);
assert.doesNotMatch(smsPasteObserved[2].args.expression, new RegExp(dummyCode));
assert.equal(smsBeforeResult.content[0].text, '');
assert.equal(smsTypedResult.content[0].text, '');
assert.equal(smsAfterResult.content[0].text, '');
assert.equal(JSON.stringify(smsPasteResult).includes(dummyCode), false);

for (const providerCase of [
  {
    chord: 'Meta+Shift+P',
    code: '54321',
    capturePattern: /paylocity/,
    targetPattern: /one\[- \]\?time\.\*passcode/,
    expectedPattern: /\\d\{5\}/,
  },
  {
    chord: 'Meta+Shift+H',
    code: '87654321',
    capturePattern: /chase/,
    targetPattern: /identification\.\*code/,
    expectedPattern: /\\d\{8\}/,
  },
]) {
  const providerState = new ProtectedPasteState();
  const providerPrivateCapture = {
    content: [{ type: 'text', text: JSON.stringify({ code: providerCase.code }) }],
  };
  let providerCaptureCall = null;
  const providerCaptureResult = await captureProtectedServiceTitanSms(
    {
      async callTool(name, args, timeoutMs) {
        providerCaptureCall = { name, args, timeoutMs };
        return providerPrivateCapture;
      },
    },
    { tabId: 21, keys: providerCase.chord },
    providerState,
  );
  assert.equal(providerCaptureCall.name, 'evaluate');
  assert.match(providerCaptureCall.args.expression, providerCase.capturePattern);
  assert.equal(providerPrivateCapture.content[0].text, '');
  assert.equal(JSON.stringify(providerCaptureResult).includes(providerCase.code), false);

  const providerPasteCalls = [];
  const privateResults = [];
  const providerPasteResult = await deliverProtectedClipboardPaste(
    {
      async callTool(name, args, timeoutMs) {
        providerPasteCalls.push({ name, args, timeoutMs });
        const evaluateCount = providerPasteCalls.filter((call) => call.name === 'evaluate').length;
        const result = name === 'click'
          ? { content: [{ type: 'text', text: 'focused' }] }
          : name === 'type_text'
            ? { content: [{ type: 'text', text: 'typed' }] }
            : { content: [{ type: 'text', text: evaluateCount === 1 ? '{"ready":true}' : '{"pasted":true}' }] };
        privateResults.push(result);
        return result;
      },
    },
    { tabId: 22, keys: 'Meta+V', index: 31 },
    async () => {
      throw new Error('protected SMS paste must not read the system clipboard');
    },
    providerState,
  );
  assert.deepEqual(providerPasteCalls.map((call) => call.name), [
    'click',
    'evaluate',
    'type_text',
    'evaluate',
  ]);
  assert.deepEqual(providerPasteCalls[0].args, { tabId: 22, uid: 31 });
  assert.match(providerPasteCalls[1].args.expression, providerCase.targetPattern);
  assert.match(providerPasteCalls[3].args.expression, providerCase.expectedPattern);
  assert.equal(providerPasteCalls[2].args.text, providerCase.code);
  if (providerCase.chord === 'Meta+Shift+H') {
    const frame = vm.createContext({});
    vm.runInContext(`
      class HTMLInputElement {}
      const location = { origin: 'https://secure.chase.com', hostname: 'secure.chase.com', pathname: '/login' };
      const topView = { location, frameElement: null,
        getComputedStyle: element => element.style || ({display: 'block', visibility: 'visible'}) };
      const outerFrame = { tagName: 'IFRAME', ownerDocument: {defaultView: topView},
        getBoundingClientRect: () => ({width: 500, height: 300}) };
      const middleView = { ...topView, frameElement: outerFrame };
      const innerFrame = { tagName: 'IFRAME', ownerDocument: {defaultView: middleView},
        getBoundingClientRect: () => ({width: 300, height: 100}) };
      const view = { ...topView, HTMLInputElement, frameElement: innerFrame };
      const field = new HTMLInputElement();
      Object.assign(field, { ownerDocument: {defaultView: view}, name: 'identification-code', type: 'text', value: '',
        getAttribute: () => null, getBoundingClientRect: () => ({width: 100, height: 30}) });
      innerFrame.contentDocument = {activeElement: field};
      outerFrame.contentDocument = {activeElement: innerFrame};
      const document = {activeElement: outerFrame};
      globalThis.field = field;
      globalThis.containingFrames = [innerFrame, outerFrame];
    `, frame);
    assert.equal(vm.runInContext(providerPasteCalls[1].args.expression, frame).ready, true);
    frame.field.value = providerCase.code;
    assert.equal(vm.runInContext(providerPasteCalls[3].args.expression, frame).pasted, true);
    // Both preflight and post-paste checks reject any hidden containing frame,
    // even though the nested field still reports a visible rectangle and style.
    for (const containingFrame of frame.containingFrames) {
      const visibleRect = containingFrame.getBoundingClientRect;
      for (const hidden of [
        { style: {display: 'none', visibility: 'visible'} },
        { style: {display: 'block', visibility: 'hidden'} },
        { rect: {width: 0, height: 100} },
        { rect: {width: 100, height: 0} },
      ]) {
        containingFrame.style = hidden.style;
        containingFrame.getBoundingClientRect = hidden.rect ? () => hidden.rect : visibleRect;
        frame.field.value = '';
        assert.throws(() => vm.runInContext(providerPasteCalls[1].args.expression, frame), /not visible/);
        frame.field.value = providerCase.code;
        assert.throws(() => vm.runInContext(providerPasteCalls[3].args.expression, frame), /not visible/);
      }
      containingFrame.style = undefined;
      containingFrame.getBoundingClientRect = visibleRect;
    }
    assert.equal(vm.runInContext(providerPasteCalls[3].args.expression, frame).pasted, true);
    frame.field.ownerDocument.defaultView.location = {origin: 'https://other.test'};
    assert.throws(() => vm.runInContext(providerPasteCalls[3].args.expression, frame), /origin was refused/);
  }

  assert.equal(privateResults.every((result) => result.content[0].text === ''), true);
  assert.equal(JSON.stringify(providerPasteResult).includes(providerCase.code), false);
}

const invalidCaptureResult = {
  content: [{ type: 'text', text: '{"code":"not-six-digits"}' }],
};
smsState.storeSmsCode(Buffer.from('111111'));
await assert.rejects(
  () => captureProtectedServiceTitanSms(
    { async callTool() { return invalidCaptureResult; } },
    { tabId: 9, keys: 'Meta+Shift+C' },
    smsState,
  ),
  /invalid result/,
);
assert.equal(invalidCaptureResult.content[0].text, '');
assert.equal(smsState.takeSmsCode(), null);

const overbroadCaptureResult = {
  content: [{ type: 'text', text: '{"code":"222222","message":"unexpected"}' }],
};
await assert.rejects(
  () => captureProtectedServiceTitanSms(
    { async callTool() { return overbroadCaptureResult; } },
    { tabId: 9, keys: 'Meta+Shift+C' },
    smsState,
  ),
  /invalid result/,
);
assert.equal(overbroadCaptureResult.content[0].text, '');
assert.equal(smsState.takeSmsCode(), null);
smsState.clear();

console.log('protected paste: exact credential paste and one-use provider SMS bridge ok');

// Fresh-request ServiceTitan capture never reuses a code visible before send.
const freshState = new ProtectedPasteState();
const privateSmsResult = value => ({content:[{type:'text',text:JSON.stringify(value)}]});
let smsFixture = { codes: ['123456'] };
let lastPrivate;
const freshBridge = {async callTool(name,args) {
  assert.equal(name,'evaluate');
  lastPrivate=privateSmsResult(smsFixture);
  return lastPrivate;
}};
assert.equal(isProtectedSmsCaptureCall('press_key',{tabId:41,keys:'CMD+SHIFT+B'}),true);
assert.equal(isProtectedSmsCaptureCall('press_key',{tabId:41,keys:'CMD+SHIFT+S'}),true);
await captureProtectedServiceTitanSms(freshBridge,{tabId:41,keys:'CMD+SHIFT+B'},freshState);
assert.equal(lastPrivate.content[0].text,'');
smsFixture={codes:['123456']};
for(let i=0;i<2;i++) {
  assert.equal((await captureProtectedServiceTitanSms(freshBridge,{tabId:41,keys:'CMD+SHIFT+S'},freshState)).content[0].text,'Waiting for a new provider SMS code');
  assert.equal(lastPrivate.content[0].text,'');
  assert.equal(freshState.takeSmsCode(),null);
}
smsFixture={codes:['123456','654321']};
const freshReceipt=await captureProtectedServiceTitanSms(freshBridge,{tabId:41,keys:'CMD+SHIFT+S'},freshState);
assert.equal(JSON.stringify(freshReceipt).includes('654321'),false);
assert.equal(freshReceipt.content[0].text,'ServiceTitan fresh SMS captured');
assert.equal(lastPrivate.content[0].text,'');
let freshCode=freshState.takeSmsCode();assert.equal(freshCode.value.toString(),'654321');freshCode.value.fill(0);
assert.equal(freshState.takeSmsCode(),null);
await assert.rejects(captureProtectedServiceTitanSms(freshBridge,{tabId:41,keys:'CMD+SHIFT+S'},freshState),/current matching request baseline/);
for(const mode of ['wrong-tab','expired','cleared']) {
  smsFixture={codes:[]};
  await captureProtectedServiceTitanSms(freshBridge,{tabId:41,keys:'CMD+SHIFT+B'},freshState);
  smsFixture={codes:['123456','654321']};
  const originalNow=Date.now;
  if(mode==='expired') {const now=Date.now();Date.now=()=>now+120001;}
  if(mode==='cleared')freshState.clear();
  try {await assert.rejects(captureProtectedServiceTitanSms(freshBridge,{tabId:mode==='wrong-tab'?42:41,keys:'CMD+SHIFT+S'},freshState),/current matching request baseline/);}
  finally {Date.now=originalNow;}
  assert.equal(freshState.takeSmsCode(),null);
}
for(const value of [{codes:['not-a-code']},{codes:['123456'],extra:true},{code:'123456'}]) {
  smsFixture=value;
  await assert.rejects(captureProtectedServiceTitanSms(freshBridge,{tabId:41,keys:'CMD+SHIFT+B'},freshState),/baseline returned an invalid result/);
  assert.equal(lastPrivate.content[0].text,'');
}
console.log('ServiceTitan fresh-request baseline: stale, missing, wrong-tab, expired and replayed codes rejected');

// Exercise the generated baseline expression against a bounded DOM fixture.
let baselineExpression;
await captureProtectedServiceTitanSms({async callTool(name,args){baselineExpression=args.expression;return privateSmsResult({codes:[]});}}, {tabId:41,keys:'CMD+SHIFT+B'},new ProtectedPasteState());
const fixtureContext=vm.createContext({});
vm.runInContext(`
const location={hostname:'voice.google.com',pathname:'/u/0/messages'};
const getComputedStyle=()=>({display:'block',visibility:'visible'});
const node=(text,x=1,y=1)=>({children:[],textContent:text,getAttribute:()=>'',getBoundingClientRect:()=>({width:10,height:10,left:x,top:y})});
const identity={getAttribute:()=> 'ocuser@example.com'};
let messages=[node('ServiceTitan code 123456'),node('ServiceTitan code 654321',2,2),node('Other code 987654')];
const document={body:{innerText:''},querySelectorAll:s=>s==='body *'?messages:[identity]};
`,fixtureContext);
assert.equal(JSON.stringify(vm.runInContext(baselineExpression,fixtureContext)),JSON.stringify({codes:['123456','654321']}));
vm.runInContext("messages=[node('Messages')]",fixtureContext);
assert.equal(JSON.stringify(vm.runInContext(baselineExpression,fixtureContext)),JSON.stringify({codes:[]}));
vm.runInContext("location.hostname='other.example'",fixtureContext);
assert.throws(()=>vm.runInContext(baselineExpression,fixtureContext),/verified Google Voice/);

const ambiguityState=new ProtectedPasteState();
smsFixture={codes:['123456']};
await captureProtectedServiceTitanSms(freshBridge,{tabId:41,keys:'CMD+SHIFT+B'},ambiguityState);
smsFixture={codes:['123456','654321','222222']};
await assert.rejects(captureProtectedServiceTitanSms(freshBridge,{tabId:41,keys:'CMD+SHIFT+S'},ambiguityState),/ambiguous new provider codes/);
assert.equal(ambiguityState.takeSmsCode(),null);
assert.equal(lastPrivate.content[0].text,'');
smsFixture={codes:[]};
assert.equal((await captureProtectedServiceTitanSms(freshBridge,{tabId:41,keys:'CMD+SHIFT+S'},ambiguityState)).content[0].text,'Waiting for a new provider SMS code');
let freshExpression;
await captureProtectedServiceTitanSms({async callTool(name,args){freshExpression=args.expression;return privateSmsResult({codes:['123456']});}}, {tabId:41,keys:'CMD+SHIFT+S'},ambiguityState);
vm.runInContext("location.hostname='voice.google.com';messages=[node('ServiceTitan code 123456',100,100),node('ServiceTitan code 654321',1,1)]",fixtureContext);
assert.equal(JSON.stringify(vm.runInContext(freshExpression,fixtureContext)),JSON.stringify({codes:['123456','654321']}));
console.log('Fresh SMS selection includes inbox previews and refuses multiple new candidates');

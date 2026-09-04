import assert from 'node:assert/strict';
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
const indexedFocusResult = {
  content: [{ type: 'text', text: 'Clicked @e20' }],
};
const indexedObserved = [];
let indexedClipboardClears = 0;
const indexedResult = await deliverProtectedClipboardPaste(
  {
    async callTool(name, args, timeoutMs) {
      indexedObserved.push({ name, args, timeoutMs });
      return name === 'click' ? indexedFocusResult : indexedPrivateResult;
    },
  },
  { tabId: 7, keys: 'Meta+V', index: 20 },
  async () => indexedClipboard,
  undefined,
  async () => { indexedClipboardClears += 1; },
);
assert.equal(indexedClipboardClears, 1);
assert.deepEqual(indexedObserved, [
  {
    name: 'click',
    args: { tabId: 7, uid: 20 },
    timeoutMs: 15_000,
  },
  {
    name: 'evaluate',
    args: {
      tabId: 7,
      expression: indexedObserved[1].args.expression,
    },
    timeoutMs: 15_000,
  },
]);
assert.match(indexedObserved[1].args.expression, /document\.activeElement/);
assert.match(indexedObserved[1].args.expression, /dispatchEvent\(new Event\('input'/);
assert.match(indexedObserved[1].args.expression, /return \{ pasted: true \}/);
assert.doesNotMatch(indexedObserved[1].args.expression, /field\.value !== ''/);
assert.equal(indexedObserved[1].args.expression.includes(indexedValue), true);
assert.equal(indexedFocusResult.content[0].text, '');
assert.equal(indexedPrivateResult.content[0].text, '');
assert.equal(JSON.stringify(indexedResult).includes(indexedValue), false);
assert.deepEqual(indexedResult, {
  content: [{ type: 'text', text: 'Pressed Meta+V' }],
});
assert.equal(indexedClipboard.every((byte) => byte === 0), true);

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
  const brokerFocusResult = { content: [{ type: 'text', text: 'focused' }] };
  const brokerTypedResult = { content: [{ type: 'text', text: '{"pasted":true}' }] };
  const brokerPasteResult = await deliverProtectedClipboardPaste(
    {
      async callTool(name, args, timeoutMs) {
        brokerObserved.push({ name, args, timeoutMs });
        return name === 'click' ? brokerFocusResult : brokerTypedResult;
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
  assert.deepEqual(brokerObserved.map((call) => call.name), ['click', 'evaluate']);
  assert.equal(brokerObserved[0].args.uid, 4);
  assert.match(brokerObserved[1].args.expression, /return \{ pasted: true \}/);
  assert.equal(brokerObserved[1].args.expression.includes('profile-local-value'), true);
  assert.equal(brokerFocusResult.content[0].text, '');
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
assert.match(smsCaptureObserved.args.expression, /ocuser@qualitechmgmt\.com/);
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

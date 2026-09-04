import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const here = import.meta.dirname;
const { isMissingProtocolVersion, isRetryableLegacyProtocolFatal } = await import(
  pathToFileURL(resolve(here, '../../extension/handshake.js')).href
);

assert.equal(isMissingProtocolVersion(undefined), true);
assert.equal(isMissingProtocolVersion(null), true);
assert.equal(isMissingProtocolVersion(1), false);
assert.equal(isMissingProtocolVersion(2), false);

assert.equal(isRetryableLegacyProtocolFatal({
  code: 4426,
  reason: 'Server protocol (none) does not match extension protocol 2',
}), true);
assert.equal(isRetryableLegacyProtocolFatal({
  code: 4426,
  reason: 'Server protocol 1 does not match extension protocol 2',
}), false);
assert.equal(isRetryableLegacyProtocolFatal({ code: 4403, reason: 'profile mismatch' }), false);
assert.equal(isRetryableLegacyProtocolFatal(null), false);

console.log('extension handshake migration checks passed');

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const here = import.meta.dirname;
const { isSensitiveInputNode, redactSensitiveAccessibleName, redactSensitiveUrl } = await import(
  pathToFileURL(resolve(here, '../../extension/redaction.js')).href
);

assert.equal(isSensitiveInputNode('spinbutton', ['autocomplete', 'one-time-code']), true);
assert.equal(isSensitiveInputNode('textbox', ['type', 'password']), true);
assert.equal(isSensitiveInputNode('spinbutton', ['id', 'verificationCode']), true);
assert.equal(isSensitiveInputNode('spinbutton', ['name', 'sms-code']), true);
assert.equal(isSensitiveInputNode('spinbutton', ['inputmode', 'numeric', 'maxlength', '6']), true);
assert.equal(isSensitiveInputNode('spinbutton', ['name', 'employeeCount']), false);
assert.equal(isSensitiveInputNode('button', ['name', 'verificationCode']), false);
assert.equal(redactSensitiveAccessibleName('123456', true), '[REDACTED]');
assert.equal(redactSensitiveAccessibleName('••••••', true), '[REDACTED]');
assert.equal(redactSensitiveAccessibleName('Verification code', true), 'Verification code');
assert.equal(redactSensitiveAccessibleName('123456', false), '123456');
assert.equal(
  redactSensitiveAccessibleName(
    'ServiceTitan: Your ServiceTitan verification code is: 123456. Do not share it.',
    false,
  ),
  'ServiceTitan: Your ServiceTitan verification code is: [REDACTED CODE]. Do not share it.',
);
assert.equal(
  redactSensitiveAccessibleName('123456 is your verification code for ServiceTitan', false),
  '[REDACTED CODE] is your verification code for ServiceTitan',
);
assert.equal(
  redactSensitiveAccessibleName('A code was sent to the number ending in 4132', false),
  'A code was sent to the number ending in 4132',
);
assert.equal(redactSensitiveAccessibleName('person@example.com', false, true), '[REDACTED EMAIL]');
assert.equal(redactSensitiveAccessibleName('person@example.com', false, false), 'person@example.com');
const sanitized = redactSensitiveUrl('https://login.example.test/authorize?client_id=public&state=secret-state&nonce=secret-nonce');
assert.match(sanitized, /client_id=public/);
assert.doesNotMatch(sanitized, /secret-state|secret-nonce/);
assert.match(sanitized, /state=%5BREDACTED%5D/);
assert.equal(redactSensitiveUrl('https://example.test/#/home'), 'https://example.test/#/home');

console.log('extension snapshot redaction checks passed');

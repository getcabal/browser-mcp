import assert from 'node:assert/strict';
import { errorCategory, recordToolFailure } from '../dist/diagnostics.js';

for (const [message, category] of [
  ['Error: Cannot find context with specified id', 'execution_context_lost'],
  ['No node with given id found', 'dom_target_missing'],
  ['Another debugger is already attached to the tab with id: 12345', 'debugger_conflict'],
  ['Element @e3 is stale; call take_snapshot again', 'stale_element'],
  ['Cannot access a chrome-extension://private-url of different extension', 'cross_extension_page'],
  ['Protected paste was refused for private-value', 'protected_entry_refused'],
  ['click timed out after 30000ms', 'browser_timeout'],
  ['TypeError: sensitive field value', 'javascript_exception'],
]) assert.equal(errorCategory(new Error(message)), category);

const lines = [];
recordToolFailure('hr', 'click', 'Cannot find context with specified id', line => lines.push(line));
recordToolFailure('private-profile', 'private-tool', 'private-password secret-code https://private.example', line => lines.push(line));
assert.deepEqual(JSON.parse(lines[0]), {
  event: 'browser_tool_failure', at: JSON.parse(lines[0]).at,
  profile: 'hr', tool: 'click', category: 'execution_context_lost',
});
assert.equal(JSON.parse(lines[1]).category, 'other');
assert.equal(JSON.parse(lines[1]).profile, 'other');
assert.equal(JSON.parse(lines[1]).tool, 'other');
assert.ok(!lines.join('').match(/private|password|secret-code|https:/));
assert.equal(errorCategory({toString(){throw Error('must not inspect arbitrary objects');}}), 'other');
console.log('PASS: fixed browser error categories exclude raw messages, identifiers and credentials');

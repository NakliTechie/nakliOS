#!/usr/bin/env node
// A mirrored page whose Content-Security-Policy pins its inline scripts by hash (Draft does) must keep running after
// the managed SDK splice: prepareManagedSdk re-pins the one script it rewrote and leaves other pins alone.
// Found 2026-11-16: the splice changed Draft's script, its old pin no longer matched, and the browser blocked the
// whole script with no error event.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareManagedSdk } from './mirror-lib.mjs';

const pin = text => `'sha256-${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('base64')}'`;
const sdk = Buffer.from('/*! @naklios-sdk-version 2 */\n(function(){ window.naklios = { v: "new" }; })();');
const other = 'console.log("other script");';
const body = 'const app = 1;\n/* naklios-sdk:begin ver=2 sha256=old */\n(function(){ window.naklios = { v: "old" }; })();\n/* naklios-sdk:end */\napp;';
const html = `<meta http-equiv="Content-Security-Policy" content="script-src ${pin(other)} ${pin(body)} https://cdn.example">\n` +
  `<script>${other}</script>\n<script type="module">${body}</script>`;
const out = prepareManagedSdk(Buffer.from(html), 'inline', sdk).bytes.toString('utf8');
const script = out.slice(out.indexOf('<script type="module">') + 22, out.lastIndexOf('</script>'));
assert.ok(script.includes('v: "new"'), 'the canonical SDK is spliced in');
assert.ok(out.includes(pin(script)), 'the rewritten script is pinned by its new hash');
assert.ok(!out.includes(pin(body)), 'its old pin is gone');
assert.ok(out.includes(pin(other)), 'other scripts keep their pins');
assert.ok(out.includes('https://cdn.example'), 'the rest of the policy is unchanged');

// A page without a hash policy is unchanged apart from the splice.
const plain = prepareManagedSdk(Buffer.from(`<script>${body}</script>`), 'inline', sdk).bytes.toString('utf8');
assert.ok(!plain.includes('sha256-'), 'no pin is invented');
console.log('managed SDK splice keeps CSP script hashes valid: PASS');

// Conformance — "Open with" and "Send to" come from declarations (sys/host/file-targets.mjs).
//
//   node sys/host/test/file-targets.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAccepts, targetsFor, extensionOf, mimeOf } from '../file-targets.mjs';

assert.equal(extensionOf('a/b/Report.PDF'), '.pdf');
assert.equal(extensionOf('noext'), '');
assert.equal(mimeOf('x.csv'), 'text/csv');
assert.equal(mimeOf('x.bin'), 'application/octet-stream');
assert.match(parseAccepts([{ action: 'run', extensions: ['.x'], label: 'x' }]).error, /action/);
assert.match(parseAccepts([{ action: 'import', extensions: ['pdf'], label: 'x' }]).error, /extensions/);
assert.match(parseAccepts([{ action: 'import', extensions: ['.pdf'] }]).error, /label/);

const manifest = id => JSON.parse(readFileSync(new URL(`../../../apps/${id}/commands.json`, import.meta.url), 'utf8'));
const apps = ['editor', 'notes', 'calendar'].map(id => {
  const parsed = parseAccepts(manifest(id).accepts);
  assert.ok(!parsed.error, id);
  return { id, name: id, accepts: parsed.accepts };
});
assert.deepEqual(targetsFor('todo.md', apps).map(t => [t.appId, t.action]), [['editor', 'edit'], ['notes', 'import']]);
assert.deepEqual(targetsFor('trip.ics', apps).map(t => t.appId), ['calendar']);
assert.deepEqual(targetsFor('photo.heic', apps), []);
console.log('file-targets: PASS');

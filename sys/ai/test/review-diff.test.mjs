import assert from 'node:assert/strict';
import { buildReviewDiff, loadWorkingReview, reviewPrompt, reviewVersion } from '../review-diff.mjs';

const insertion = buildReviewDiff({ before: 'one\nthree\n', after: 'one\ntwo\nthree\n', beforePath: 'src/a.js' });
assert.deepEqual(insertion.rows.map(({ kind, beforeLine, afterLine, anchorLine }) =>
  [kind, beforeLine, afterLine, anchorLine]), [
  ['context', 1, 1, 1], ['add', null, 2, 2], ['context', 2, 3, 3],
]);

const deletion = buildReviewDiff({ before: 'first\nlast\n', after: 'first\n', beforePath: 'a' });
assert.equal(deletion.rows.at(-1).kind, 'delete');
assert.equal(deletion.rows.at(-1).anchorLine, 2, 'a deleted final row anchors after the last working row');

const twoHunks = buildReviewDiff({
  before: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
  after: Array.from({ length: 30 }, (_, i) => i === 1 || i === 27 ? `changed ${i + 1}` : `line ${i + 1}`).join('\n') + '\n',
  beforePath: 'a', context: 2,
});
assert.equal(twoHunks.hunks.length, 2);
assert.equal(twoHunks.hunks[0].afterStart, 1);
assert.equal(twoHunks.hunks[1].afterStart, 26);

const added = buildReviewDiff({ beforeExists: false, after: 'new\n', afterPath: 'new.txt' });
assert.equal(added.kind, 'new');
assert.equal(added.rows.length, 1);
assert.equal(added.rows[0].afterLine, 1);
const removed = buildReviewDiff({ before: 'gone\n', afterExists: false, beforePath: 'old.txt' });
assert.equal(removed.kind, 'deleted');
assert.equal(removed.rows[0].anchorLine, 1);
const renamed = buildReviewDiff({ before: 'same\n', after: 'same\n', beforePath: 'old', afterPath: 'new' });
assert.equal(renamed.kind, 'renamed');
assert.equal(renamed.rows.length, 1);
assert.equal(renamed.hunks.length, 0);
assert.equal(buildReviewDiff({ before: '', after: '', beforePath: 'empty' }).rows.length, 0);
assert.equal(buildReviewDiff({ before: 'x\n', after: 'x', beforePath: 'x' }).afterFinalNewline, false);
assert.equal(buildReviewDiff({ before: 'x\0', after: 'x', beforePath: 'x' }).state, 'binary');
assert.equal(buildReviewDiff({ before: 'a\nb\n', after: 'c\nd\n', maxCells: 1 }).state, 'too-large');
assert.equal(buildReviewDiff({ beforeExists:false, afterExists:false, beforePath:'gone' }).kind, 'absent');
assert.equal(buildReviewDiff({ before:'', after:'x\n'.repeat(50_001), beforePath:'many' }).state, 'too-large');

assert.notEqual(reviewVersion('a'), reviewVersion('b'));
assert.notEqual(reviewVersion('', true), reviewVersion('', false));
assert.notEqual(reviewVersion(new Uint8Array([0, 1])), reviewVersion(new Uint8Array([0, 2])));
const prompt = reviewPrompt([{ file: 'src/a.js', anchorLine: 3, kind: 'delete', text: 'Keep the check.' }]);
assert.deepEqual(JSON.parse(prompt.split('\n\n')[1]), { file:'src/a.js', line:3, anchor:'deleted line anchor', comment:'Keep the check.' });
const joined = await loadWorkingReview({ filepath: 'new.txt',
  git: { readBlob: async ({ filepath, ref }) => {
    assert.equal(filepath, 'new.txt'); assert.equal(ref, 'HEAD');
    return { ok: false, code: 'ENOENT' };
  } },
  fs: { read: async (path, opts) => {
    assert.equal(path, 'new.txt'); assert.equal(opts.maxBytes, 4 * 1024 * 1024);
    return { ok: true, data: new TextEncoder().encode('new\n') };
  } },
});
assert.equal(joined.kind, 'new');
assert.equal(joined.rows[0].text, 'new');
let failed = false;
try { await loadWorkingReview({ filepath: 'secret', git: { readBlob: async () => ({ ok:false, code:'EACCES' }) },
  fs: { read: async () => ({ ok:true, data:new Uint8Array() }) } }); } catch { failed = true; }
assert.equal(failed, true, 'a denied HEAD read must not become an empty baseline');
const missing = await loadWorkingReview({ filepath:'gone', git:{ readBlob:async()=>({ok:true,data:new TextEncoder().encode('old')}) },
  fs:{ read:async()=>({ok:false,error:'ENOENT'}) } });
assert.equal(missing.kind,'deleted');
console.log('review diff line and version contract passed');

import assert from 'node:assert/strict';
import { highlightLine } from '../review-highlight.mjs';

for (const [line, language] of [
  ['const url = "https://example.test"; // note', 'js'],
  ['<section class="a">Title</section>', 'html'],
  ['# comment', 'py'],
  ['{"value": 42}', 'json'],
]) {
  const tokens = highlightLine(line, language);
  assert.equal(tokens.map((token) => token.text).join(''), line, 'highlighting preserves every character');
}
assert.ok(highlightLine('const x = 42;', 'mjs').some((token) => token.kind === 'keyword' && token.text === 'const'));
assert.ok(highlightLine('const x = 42;', 'mjs').some((token) => token.kind === 'number' && token.text === '42'));
assert.ok(highlightLine('<div>ok</div>', 'html').some((token) => token.kind === 'tag'));
console.log('shared review highlighting preserves source text');

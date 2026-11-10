// Pi's window: its inline module parses, tool cards fill with their results, and a streamed final
// reply is not shown twice. Grep checks miss syntax errors, so the module goes through `node --check`.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const page = await readFile(new URL('../apps/pi/index.html', import.meta.url), 'utf8');
const mod = page.match(/<script type="module">([\s\S]*?)<\/script>/);
assert.ok(mod, 'Pi has one inline module');

const dir = await mkdtemp(join(tmpdir(), 'pi-ui-'));
try {
  const file = join(dir, 'pi-module.mjs');
  await writeFile(file, mod[1]);
  execFileSync(process.execPath, ['--check', file]); // throws on a syntax error
} finally { await rm(dir, { recursive: true, force: true }); }

// A stand-in DOM, enough for the tool-card helpers.
function el(tag) {
  const e = { tag, children: [], className: '', textContent: '', hidden: false,
    append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); return c; }, remove() { this.removed = true; } };
  return e;
}
const log = el('div');
const document = { createElement: el };
const start = mod[1].indexOf('const toolCards = new Map();');
const end = mod[1].indexOf('let lastLive = null;');
assert.ok(start > 0 && end > start, 'the tool-card block is found');
const { addToolCard, fillToolResults, toolCards } = new Function('document', 'log',
  `${mod[1].slice(start, end)}; return { addToolCard, fillToolResults, toolCards };`)(document, log);

addToolCard({ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls /workspace"}' } });
addToolCard({ id: 'c2', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } });
assert.equal(log.children.length, 2, 'one card per tool call');
const card = log.children[0];
assert.equal(card.tag, 'details');
assert.equal(card.children[0].children[0].textContent, 'bash ls /workspace', 'the card names the tool and its command');
assert.equal(card.children[0].children[1].textContent, 'running…');

fillToolResults([{ role: 'assistant', content: '' }, { role: 'tool', tool_call_id: 'c1', content: 'a.txt\nb.txt' }]);
assert.equal(card.children[0].children[1].textContent, 'done', 'the result marks the card done');
assert.equal(card.children[2].textContent, 'a.txt\nb.txt');
assert.equal(card.children[2].hidden, false);
assert.ok(toolCards.has('c2') && !toolCards.has('c1'), 'only the answered card is closed');

// The page streams and assembles one completion for the Worker, and skips a duplicate final bubble.
assert.match(mod[1], /ai\.chat\.completions\.create\(\{ \.\.\.msg\.request, agent: true, stream: true \}\)/, 'Pi asks for a stream');
assert.match(mod[1], /worker\.postMessage\(\{ type: 'broker-reply', id: msg\.id, completion \}\)/, 'the Worker still gets one completion');
assert.match(mod[1], /lastLive\.textContent\.trim\(\) === String\(r\.answer \|\| ''\)\.trim\(\)/, 'a streamed final reply is not added twice');
console.log('pi-ui: the module parses; tool cards fill with results; replies stream once');

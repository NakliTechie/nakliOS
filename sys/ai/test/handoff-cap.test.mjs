// Frozen owner-authored B04 criterion. Only the import path changes between gate and native locations.
import { capHandoff, HANDOFF_MAX_CHARS } from '../context-budget.mjs';
function assert(ok, message) { if (!ok) throw new Error(message); }
let checks = 0;
const original = 'checkpoint evidence '.repeat(1200);
for (const usable of [-100, -1, 0, 0.25, 0.5, 1, 2, 8, 16, 31.5, 32, 40, 50, 64, 100, 500, 6000, 40000]) {
  const cap = Math.min(HANDOFF_MAX_CHARS, Math.max(0, Math.floor(usable * 2)));
  const got = capHandoff(original, { usable });
  assert(typeof got === 'string', 'handoff must remain a string');
  assert(got.length <= cap, `usable ${usable}: ${got.length} chars exceed ${cap}`);
  if (got) {
    const marker = /\n\[handoff truncated: kept the first (\d+) of (\d+) chars; (\d+) dropped from the end\]$/.exec(got);
    assert(marker, `usable ${usable}: truncation requires a complete marker`);
    const kept = Number(marker[1]), total = Number(marker[2]), dropped = Number(marker[3]);
    assert(kept + dropped === original.length && total === original.length, 'counts must describe original input');
    assert(got.slice(0, kept) === original.slice(0, kept), 'retained prefix must match input');
    assert(got.indexOf('\n[handoff') === kept, 'kept count must equal prefix length');
  }
  checks++;
}
for (let cap = 64; cap <= 256; cap++) {
  const got = capHandoff(original, { usable: cap / 2 });
  assert(got.length <= cap, `cap ${cap}: output exceeds cap`);
  if (cap >= 128) assert(got.includes('[handoff truncated:'), 'a fitting marker must retain truncation evidence');
  checks++;
}
assert(capHandoff('abc', { usable: 2 }) === 'abc', 'an input within the cap must remain unchanged');
assert(capHandoff('', { usable: 0 }) === '', 'empty input with zero usable tokens');
assert(capHandoff('abc', { usable: null }) === 'abc', 'unknown window retains short input');
const defaultResult = capHandoff(original, {});
assert(defaultResult.length <= HANDOFF_MAX_CHARS && defaultResult.includes('[handoff truncated:'), 'unknown window retains bounded metadata');
const small = capHandoff('x'.repeat(50000), { usable: 6000 });
assert(small.length <= 12000 && /of 50000 chars/.test(small), 'normal small-window behavior remains');
console.log('handoff cap acceptance: ' + (checks + 5) + ' checks passed');

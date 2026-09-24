// Conformance — the honest context budget (B4).
//   node sys/ai/test/context-budget.test.mjs
import { contextBudget, windowFromOllama, windowForPreset, capHandoff, reminderFingerprint, carryLimits, CARRY_DEFAULTS,
         shouldRemind, filterStaleReminders, contextRemainingTool, checkpointTool,
         MIN_USABLE_TOKENS, OLLAMA_DEFAULT_NUM_CTX, HANDOFF_MAX_CHARS, DEFAULT_RESERVE } from '../context-budget.mjs';

let passed = 0; const failures = [];
function test(n, fn) { try { fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const SHOW = { model_info: { 'qwen3.context_length': 40960 } };

test('windowFromOllama: num_ctx set → min(num_ctx, model max), not assumed; unset → the 4096 default, assumed and flagged', () => {
  const set = windowFromOllama(SHOW, 8192); eq(set.window, 8192, 'num_ctx honoured'); eq(set.assumed, false, 'not assumed'); assert(/num_ctx 8192/.test(set.source) && /model max 40960/.test(set.source), set.source);
  eq(windowFromOllama(SHOW, 65536).window, 40960, 'num_ctx above the model max is clamped to it');
  const unset = windowFromOllama(SHOW, null); eq(unset.window, OLLAMA_DEFAULT_NUM_CTX, 'unset → 4096, the silent default'); eq(unset.assumed, true, 'flagged assumed'); assert(/num_ctx unset/.test(unset.source), unset.source);
  eq(windowFromOllama({}, null).window, OLLAMA_DEFAULT_NUM_CTX, 'no model_info → still the default'); eq(OLLAMA_DEFAULT_NUM_CTX, 4096, 'the finding: Ollama defaults to 4096');
});

test('windowForPreset: ollama needs a probe; a known preset is fixed; unknown → window not known', () => {
  eq(windowForPreset('ollama', { probe: { show: SHOW, numCtx: 16384 } }).window, 16384, 'ollama from the probe');
  eq(windowForPreset('ollama').window, null, 'ollama with no probe → unknown');
  eq(windowForPreset('gemini-nano').window, 32768, 'a fixed preset');
  const u = windowForPreset('mystery'); eq(u.window, null, 'unknown → null'); assert(/not known/.test(u.source), u.source);
});

test('contextBudget: usable = window − reserve; below 10k usable → automatic OFF with a named reason', () => {
  const big = contextBudget({ window: 40960, used: 5000 }); eq(big.usable, 40960 - DEFAULT_RESERVE, 'usable'); eq(big.supported, true, 'supported'); eq(big.automatic, true, 'automatic on'); eq(big.remaining, big.usable - 5000, 'remaining'); eq(big.reason, null, 'no complaint');
  const small = contextBudget({ window: 4096 }); eq(small.supported, false, 'a 4096 window is not enough'); eq(small.automatic, false, 'automatic off'); assert(/automatic behaviour off/.test(small.reason) && /larger model/.test(small.reason), small.reason);
  eq(contextBudget({ window: MIN_USABLE_TOKENS + DEFAULT_RESERVE }).supported, true, 'exactly the floor is supported');
  const unknown = contextBudget({ window: null }); eq(unknown.supported, false, 'unknown window'); eq(unknown.usable, null, 'no usable'); assert(/usage not known/.test(unknown.reason), unknown.reason);
});

test('capHandoff: 20,000 chars AND half the usable window, whichever is smaller', () => {
  eq(capHandoff('x'.repeat(100), { usable: 40000 }), 'x'.repeat(100), 'short handoff untouched');
  const bigWin = capHandoff('x'.repeat(50000), { usable: 40000 }); assert(bigWin.length <= HANDOFF_MAX_CHARS + 40 && /truncated at 20000/.test(bigWin), '20k char cap dominates a big window');
  const smallWin = capHandoff('x'.repeat(50000), { usable: 6000 }); assert(/truncated at 12000/.test(smallWin), 'half the usable window (6000/2*4=12000) dominates a small one');
  assert(capHandoff('x'.repeat(50000), {}).length <= HANDOFF_MAX_CHARS + 40, 'no window → the 20k char cap still applies');
});

test('reminder: fingerprinted by budget shape; a stale-shape reminder is dropped from the projection; fires only near the line', () => {
  const fp1 = reminderFingerprint({ window: 40960, reserve: 2000 }), fp2 = reminderFingerprint({ window: 8192, reserve: 2000 });
  assert(fp1 !== fp2, 'a different window re-fingerprints');
  const b = contextBudget({ window: 40960 });
  assert(!shouldRemind(b, { used: 1000 }), 'a fresh window does not remind'); assert(shouldRemind(b, { used: b.usable - 100 }), 'near the line it does');
  assert(!shouldRemind(contextBudget({ window: 4096 }), { used: 4000 }), 'an unsupported budget never reminds');
  const msgs = [{ role: 'user', content: 'hi' }, { role: 'system', content: 'remind', _reminderFp: fp2 }, { role: 'system', content: 'ok', _reminderFp: fp1 }];
  const kept = filterStaleReminders(msgs, fp1); eq(kept.length, 2, 'the stale-shape reminder is dropped'); assert(!kept.some((m) => m._reminderFp === fp2), 'fp2 gone'); assert(kept.some((m) => m._reminderFp === fp1), 'fp1 kept');
});

test('the tools advertise themselves', () => {
  eq(contextRemainingTool().function.name, 'context_remaining', 'context_remaining');
  const c = checkpointTool(); eq(c.function.name, 'checkpoint', 'checkpoint'); assert(c.function.parameters.required.includes('handoff'), 'handoff required');
});

await test('X1: carry limits follow the window; an unknown window keeps the fixed ones', () => {
  const unk = carryLimits({ window: null });
  eq(unk.threshold, 24000, 'unknown threshold'); eq(unk.keepRecentTokens, 10000, 'unknown recent'); eq(unk.maxChars, 120000, 'unknown chars');
  eq(JSON.stringify(carryLimits()), JSON.stringify({ ...CARRY_DEFAULTS }), 'no argument = the defaults');
  const big = carryLimits({ window: 128000, source: 'owner set' });
  eq(big.threshold, 63000, 'half of 126000 usable'); eq(big.keepRecentTokens, 25200, '40% of the threshold'); eq(big.maxChars, 315000, '1.25x the threshold in chars');
  assert(/128000 \(owner set\)/.test(big.source), 'says where the window came from');
  const tiny = carryLimits({ window: 4096 });
  eq(tiny.threshold, 2000, 'a 4k Ollama default carries a small transcript, not 24k it cannot hold');
  assert(carryLimits({ window: 1e6 }).threshold > carryLimits({ window: 128000 }).threshold, 'monotone in the window');
});

if (failures.length) { console.error(`context-budget: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`context-budget conformance: ${passed}/${passed} passed — honest window (Ollama num_ctx incl. the 4096 default), usable floor + refusal, handoff cap, fingerprinted reminder`);

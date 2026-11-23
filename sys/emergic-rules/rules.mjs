// Emergic's common rules (deadlines in plain words, dated promises in mail), loaded as WebAssembly.
// Emergic owns the rules; this module only moves JSON across the wasm boundary
// (sys/emergic-rules/crate/src/lib.rs). Nothing here reads files, the network or a model.
//
//   const rules = await loadEmergicRules();            // in a page: fetches emergic-rules.wasm beside this file
//   const rules = await loadEmergicRules(bytes);       // in node: pass the file's bytes
//   rules.dueInMail('Will revert by Friday.', '2026-11-19')  → { due: '2026-11-20', inferred: false }
//
// Days are 'YYYY-MM-DD' in the person's own time zone; moments are 'YYYY-MM-DDTHH:MM' on their clock.

const WASM_URL = new URL('./emergic-rules.wasm', import.meta.url);

let shared = null;

function instantiate(module) {
  const instance = new WebAssembly.Instance(module, {});
  const { memory, alloc, dealloc, run } = instance.exports;
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  return function call(request) {
    const input = encoder.encode(JSON.stringify(request));
    const ptr = alloc(input.length);
    new Uint8Array(memory.buffer, ptr, input.length).set(input);
    let packed;
    try { packed = run(ptr, input.length); }
    finally { dealloc(ptr, input.length); }
    const outPtr = Number(BigInt.asUintN(64, packed) >> 32n), outLen = Number(BigInt.asUintN(64, packed) & 0xffffffffn);
    const reply = JSON.parse(decoder.decode(new Uint8Array(memory.buffer, outPtr, outLen)));
    dealloc(outPtr, outLen);
    if ('error' in reply) throw Object.assign(new Error('emergic-rules: ' + reply.error), { code: 'EINVAL' });
    return reply.ok;
  };
}

function api(module) {
  // A trap (a panic in the crate) leaves the instance unusable, so the next call starts a fresh one.
  let call = instantiate(module);
  const safe = (request) => {
    try { return call(request); }
    catch (error) { if (error instanceof WebAssembly.RuntimeError) call = instantiate(module); throw error; }
  };
  return Object.freeze({
    /** Deadline words from a meeting ("by Friday", "next week") → { due, inferred } or null. */
    due: (words, day) => safe({ op: 'due', words: String(words), day: String(day) }),
    /** The deadline in one sentence of mail, counted from the day it was sent → { due, inferred } or null. */
    dueInMail: (sentence, sent) => safe({ op: 'due_in_mail', sentence: String(sentence), sent: String(sent) }),
    /** Whether the words speak of when at all. */
    hasTimeWords: (words) => safe({ op: 'has_time_words', words: String(words) }),
    /** The moment a reminder names ("tomorrow at 3pm"), from now → 'YYYY-MM-DDTHH:MM' or null. */
    when: (words, now) => safe({ op: 'when', words: String(words), now: String(now) }),
    /**
     * Dated promises in one message, both ways. mail: { from, to: [..], reply_to, body, sent_on }.
     * me: the person's address, or several joined by commas. Each promise: { direction: 'i_owe' |
     * 'owed_to_me', who, what (redacted, at most 140 characters), due, inferred, quote_start, quote_end }
     * (quote_* index the body string passed in).
     */
    promisesIn: (mail, me) => safe({ op: 'promises_in', mail, me: String(me) }),
    /** Whether a later message in the thread closes a promise → 'replied' | 'answered' | 'done' | 'dropped' | null. */
    closes: (promise, reply, me) => safe({ op: 'closes', promise, reply, me: String(me) }),
    /** The person's own word for closing a promise ("done", "drop") → 'done' | 'dropped' | null. */
    closedFromWord: (word) => safe({ op: 'closed_from_word', word: String(word) }),
  });
}

export async function loadEmergicRules(bytes) {
  if (bytes) return api(await WebAssembly.compile(bytes));
  if (!shared) {
    shared = (async () => {
      const response = await fetch(WASM_URL);
      if (!response.ok) throw new Error(`emergic-rules: ${WASM_URL.pathname} answered ${response.status}`);
      // arrayBuffer, not compileStreaming: the latter refuses any server that labels .wasm differently.
      return api(await WebAssembly.compile(await response.arrayBuffer()));
    })();
    shared.catch(() => { shared = null; });
  }
  return shared;
}

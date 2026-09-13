// CRIB-B B4 (Paseo 3.4 / 3.5, 2026-09-13): structured output from a model that does not always give
// it. Three pure pieces, no dependencies:
//   extractJson   — a balanced brace/bracket scanner that honours string and escape state and tries
//                   every `{` / `[` start until one parses (and satisfies `want`), so JSON wrapped in
//                   prose or a code fence still comes out;
//   repairPrompt  — the re-prompt carries the FORMATTED validation errors, not "try again";
//   inferStructured — an ordered ladder of rungs ({ name, infer }); each rung gets `retries` repair
//                   turns; the caller gets the value and the whole attempt trail (what was tried and
//                   why each attempt failed), so a run record is diagnostic rather than terminal.
// Every model call goes through whatever `infer` the caller hands in; a caller that hands in the
// recording infer gets the repair turn on the chain (the app's learn review does not record today).

// Find the first balanced JSON value in `text` that parses and satisfies `want`.
// Returns { value, start, end } or null.
export function extractJson(text, { want = () => true } = {}) {
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '{' && c !== '[') continue;
    const end = balancedEnd(s, i);
    if (end < 0) continue;
    let value;
    try { value = JSON.parse(s.slice(i, end + 1)); } catch (_) { continue; }
    let ok = false; try { ok = !!want(value); } catch (_) { ok = false; }
    if (ok) return { value, start: i, end };
  }
  return null;
}

// The index of the bracket that closes the one at `start`, honouring strings and escapes; -1 if the
// text ends first.
function balancedEnd(s, start) {
  const stack = [];
  let inString = false, escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') { stack.push(c); continue; }
    if (c === '}' || c === ']') {
      stack.pop(); // a mismatched pair is JSON.parse's to refuse — the scanner only finds the balance point
      if (!stack.length) return i;
    }
  }
  return -1;
}

// The repair turn: what was wrong, then the ask again. `errors` are the validator's sentences.
export function repairPrompt(errors, { ask = 'Reply again with ONLY the JSON — no prose, no code fence, no commentary.' } = {}) {
  const list = (Array.isArray(errors) ? errors : [errors]).map((e) => String(e || '').trim()).filter(Boolean);
  return `Your reply was not the JSON that was asked for${list.length ? ':\n' + list.map((e) => '- ' + e).join('\n') : '.'}\n${ask}`;
}

// Walk the ladder. `validate(value)` returns an array of error sentences (empty = valid); `extract`
// defaults to extractJson. Returns { ok, value, rung, attempts: [{ rung, try, error }] }.
export async function inferStructured({ ladder, messages, tools = [], validate = () => [], extract = null, retries = 1, signal = null }) {
  const rungs = Array.isArray(ladder) ? ladder.filter((r) => r && typeof r.infer === 'function') : [];
  if (!rungs.length) throw new Error('inferStructured needs a ladder with at least one { name, infer } rung');
  // the default extract prefers the first candidate the validator accepts, then the first that parses
  const pick = extract || ((text) => extractJson(text, { want: (v) => !(validate(v) || []).length }) || extractJson(text));
  const attempts = [];
  let partial = null, partialRung = null; // the last value that parsed but did not validate, and whose reply it was — a caller may salvage what it can
  for (const rung of rungs) {
    let convo = messages.slice();
    for (let t = 0; t <= retries; t++) {
      let reply;
      try { reply = await rung.infer({ messages: convo, tools, signal }); }
      catch (e) { attempts.push({ rung: rung.name, try: t + 1, error: `model call failed: ${String(e && e.message || e)}` }); break; }
      const text = String(reply?.content ?? '');
      const found = pick(text);
      const errors = found ? (validate(found.value) || []) : ['no JSON value could be found in the reply' + (text.trim() ? '' : ' (the reply was empty)')];
      if (!errors.length) return { ok: true, value: found.value, rung: rung.name, attempts, partial: null };
      if (found) { partial = found.value; partialRung = rung.name; }
      attempts.push({ rung: rung.name, try: t + 1, error: errors.join('; ') });
      if (t < retries) convo = [...convo, { role: 'assistant', content: text }, { role: 'user', content: repairPrompt(errors) }];
    }
  }
  return { ok: false, value: null, rung: null, attempts, partial, partialRung };
}

// One line for a record or a report: which rung answered, after what.
export function attemptsLine(result) {
  const a = result?.attempts || [];
  const head = result?.ok ? `answered by ${result.rung}${a.length ? ` after ${a.length} failed attempt${a.length === 1 ? '' : 's'}` : ' first try'}` : `no rung answered after ${a.length} attempt${a.length === 1 ? '' : 's'}`;
  return a.length ? `${head}: ${a.map((x) => `${x.rung}#${x.try} — ${x.error}`).join('; ')}` : head;
}

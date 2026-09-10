#!/usr/bin/env node
// Pre-flight for the local Anvil test bed. Run it BEFORE a live agent run.
//
// Why this exists: the test bed's remote fuel is `hermes proxy` forwarding to
// Nous Portal on a SHORT-LIVED bearer. When that bearer expires mid-run the
// proxy keeps answering /v1/models while /v1/chat/completions starts failing,
// so the run dies looking like a broken agent or a broken harness. That
// misattribution costs more than the check does. The 2026-09-10 bring-up
// observed a bearer with 37 minutes left on it.
//
// It also refuses to bless a model that is merely LISTED. The Nous catalog
// advertises 396 ids but the account has no credits, so every paid id answers
// 404 `insufficient_credits_for_paid_model`; and at least one free id
// (poolside/laguna-xs-2.1:free) answers 500. Listing is not availability, so
// this probes a real completion with a real tools array — tool-calling is what
// Anvil's agent tier requires, and a model that chats but will not call a tool
// is useless here.
//
// Exit 0 = at least one fuel can serve a tool-calling run. Exit 1 = none can.
//
// Usage: node scripts/testbed-preflight.mjs [--min-minutes 15] [--json]

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MIN_MINUTES = Number(argOf('--min-minutes', '15'));
const AS_JSON = argv.includes('--json');

const PROXY = 'http://127.0.0.1:8645/v1';
const OLLAMA = 'http://127.0.0.1:11434/v1';
// Verified tool-calling on the free tier 2026-09-10. laguna-xs-2.1:free is
// deliberately absent: it answered 500 on the same probe its siblings passed.
const FREE_MODELS = [
  'inclusionai/ling-3.0-flash-sante:free',
  'inclusionai/ling-3.0-flash-fin:free',
  'poolside/laguna-s-2.1:free',
  'stepfun/step-3.7-flash:free',
  'upstage/solar-pro4:free',
];

const TOOLS = [{
  type: 'function',
  function: {
    name: 'shell',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
}];

const notes = [];
const fuels = [];

async function timed(url, init = {}, ms = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// Does this base+model actually RETURN a tool call? Not "is it listed".
async function probeToolCall(base, model, key = 'local') {
  const body = {
    model,
    messages: [{ role: 'user', content: 'List the files in the current directory. Use the shell tool.' }],
    tools: TOOLS, tool_choice: 'auto', stream: false,
  };
  let res;
  try {
    res = await timed(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    }, 90000);
  } catch (err) {
    return { ok: false, why: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  }
  let json = null;
  try { json = await res.json(); } catch { return { ok: false, why: `http ${res.status}, unparseable body` }; }
  if (!res.ok) return { ok: false, why: `http ${res.status}: ${String(json?.message || json?.error?.message || '').slice(0, 90)}` };
  const choice = json?.choices?.[0];
  const calls = choice?.message?.tool_calls;
  if (!calls || !calls.length) return { ok: false, why: `answered but did not call a tool (finish_reason=${choice?.finish_reason})` };
  return { ok: true, answered: json.model || model, finish: choice.finish_reason };
}

// The bearer, read from hermes itself rather than re-implementing its auth.
async function bearerMinutesLeft() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run(`${process.env.HOME}/.local/bin/hermes`, ['proxy', 'status'], { timeout: 60000 });
    // hermes prints the expiry inside a parenthesised clause, so trim trailing
    // punctuation before parsing or Date() yields NaN and the check silently passes.
    const m = stdout.match(/bearer expires\s+([0-9T:+\-.Z]+)/i);
    if (!m) return { minutes: null, why: stdout.includes('not logged in') ? 'not logged in' : 'no expiry reported' };
    const at = new Date(m[1].replace(/[^0-9A-Za-z:+.\-]+$/, ''));
    if (Number.isNaN(at.getTime())) return { minutes: null, why: `unparseable expiry ${m[1]}` };
    return { minutes: Math.floor((at.getTime() - Date.now()) / 60000), expiry: at.toISOString() };
  } catch (err) {
    return { minutes: null, why: `hermes proxy status failed: ${String(err.message || err).slice(0, 80)}` };
  }
}

// ---- hermes proxy ----
let proxyUp = false;
try {
  const res = await timed(`${PROXY}/models`, { headers: { authorization: 'Bearer local' } }, 10000);
  proxyUp = res.ok;
  if (!res.ok) notes.push(`hermes proxy /models answered http ${res.status}`);
} catch {
  notes.push('hermes proxy is DOWN — start it with: hermes proxy start --provider nous --host 127.0.0.1 --port 8645');
}

if (proxyUp) {
  const bearer = await bearerMinutesLeft();
  if (bearer.minutes === null) {
    notes.push(`bearer expiry unknown (${bearer.why}) — a mid-run expiry will look like a broken agent`);
  } else if (bearer.minutes < 0) {
    notes.push(`bearer EXPIRED ${-bearer.minutes} min ago — re-auth before running`);
  } else if (bearer.minutes < MIN_MINUTES) {
    notes.push(`bearer expires in ${bearer.minutes} min (< ${MIN_MINUTES}) — too short for a full run; re-auth first`);
  } else {
    notes.push(`bearer good for ${bearer.minutes} more min (expires ${bearer.expiry})`);
  }
  // First free model that actually tool-calls wins; the rest are the fallback ladder.
  for (const model of FREE_MODELS) {
    const r = await probeToolCall(PROXY, model);
    if (r.ok) { fuels.push({ fuel: 'hermes proxy', base: PROXY, model, answered: r.answered }); break; }
    notes.push(`  ${model}: ${r.why}`);
  }
  if (!fuels.some((f) => f.fuel === 'hermes proxy')) notes.push('no free model on hermes proxy returned a tool call');
}

// ---- ollama (the control: no quota, no bearer) ----
try {
  const res = await timed(`${OLLAMA}/models`, {}, 8000);
  if (res.ok) {
    const listed = await res.json();
    const model = listed?.data?.[0]?.id;
    if (!model) notes.push('ollama is up but has no models pulled');
    else {
      const r = await probeToolCall(OLLAMA, model, 'none');
      if (r.ok) fuels.push({ fuel: 'ollama', base: OLLAMA, model, answered: r.answered });
      else notes.push(`ollama ${model}: ${r.why}`);
    }
  }
} catch {
  notes.push('ollama is DOWN (control fuel unavailable) — start it with: ollama serve');
}

if (AS_JSON) {
  console.log(JSON.stringify({ ok: fuels.length > 0, fuels, notes }, null, 2));
} else {
  console.log('Anvil test-bed pre-flight\n');
  for (const f of fuels) console.log(`  READY  ${f.fuel.padEnd(13)} ${f.model}${f.answered && f.answered !== f.model ? `  (answered: ${f.answered})` : ''}`);
  if (!fuels.length) console.log('  no fuel can serve a tool-calling run');
  if (notes.length) { console.log(''); for (const n of notes) console.log(`  ${n.startsWith(' ') ? n : `note: ${n}`}`); }
  console.log(`\n${fuels.length} of 2 fuels ready.`);
}

process.exit(fuels.length > 0 ? 0 : 1);

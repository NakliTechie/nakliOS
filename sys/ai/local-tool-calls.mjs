// Tool calling for in-browser models — the pure shaping core (headless, testable).
//
// Endpoint models return OpenAI `tool_calls` on the wire. An in-browser model
// (LFM3 1.7B through the LocalMind worker) only produces text, so the broker
// does the two translations here:
//
//   • toLocalTemplateMessages — the agent transcript (OpenAI shape, arguments as
//     JSON strings) into what a Hugging Face chat template expects: assistant
//     `tool_calls` with arguments as OBJECTS, `tool` messages kept as-is.
//   • parseLocalToolCalls — the model's reply text back into OpenAI tool calls.
//     LFM3 writes `<tool_call><function=NAME><parameter=KEY>VALUE</parameter>
//     </function></tool_call>` (the form its own template renders); other small
//     models write `<tool_call>{"name":…,"arguments":…}</tool_call>`; LFM2 and
//     LFM2.5 write `<|tool_call_start|>[name(key='v')]<|tool_call_end|>`. All parse.
//
// Only names in the request's tool list become calls, so a model cannot invent
// a tool the app did not offer. Pure: no DOM, no worker, no fetch.

// Turn the agent transcript into chat-template messages. Never mutates input.
export function toLocalTemplateMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((m) => {
    const role = m?.role === 'developer' ? 'system' : m?.role;
    if (role === 'tool') {
      return { role: 'tool', tool_call_id: String(m.tool_call_id || ''), content: String(m.content ?? '') };
    }
    const out = { role, content: typeof m?.content === 'string' ? m.content : '' };
    if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls.map((c) => {
        let args = {};
        const raw = c?.function?.arguments;
        if (raw && typeof raw === 'object') args = raw;
        else if (typeof raw === 'string' && raw.trim()) {
          try { const v = JSON.parse(raw); if (v && typeof v === 'object' && !Array.isArray(v)) args = v; } catch (_) {}
        }
        return { id: c?.id, type: 'function', function: { name: String(c?.function?.name || ''), arguments: args } };
      });
    }
    return out;
  });
}

function toolSchemas(tools) {
  const byName = new Map();
  for (const t of Array.isArray(tools) ? tools : []) {
    const fn = t?.function || t;
    if (fn && typeof fn.name === 'string') byName.set(fn.name, fn.parameters || {});
  }
  return byName;
}

// A parameter's text value, converted to the type its JSON schema names.
// Strings stay strings (one leading/trailing newline from the XML layout is
// dropped); anything else is tried as JSON and kept as text when that fails.
function coerceParam(text, schema) {
  const value = text.replace(/^\n/, '').replace(/\n$/, '');
  const type = Array.isArray(schema?.type) ? schema.type.find((t) => t !== 'null') : schema?.type;
  if (type === 'string') return value;
  try { return JSON.parse(value.trim()); } catch (_) { return value; }
}

// LFM2 / LFM2.5 write `<|tool_call_start|>[name(key='text', n=3, obj={"a":1}), other()]<|tool_call_end|>`
// (the form their chat template renders): strings in single quotes with \\ \' \n \r escapes, lists and
// objects as JSON, anything else as its plain text. Returns [{ name, args }], or null when the text does
// not parse, so a malformed block is dropped rather than half-read.
const LFM2_BLOCK = /<\|tool_call_start\|>([\s\S]*?)(?:<\|tool_call_end\|>|(?=<\|tool_call_start\|>)|$)/g;
function parseLfm2Calls(body) {
  let i = 0;
  const s = body.trim();
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const fail = () => { throw new Error('lfm2 call'); };
  const quoted = () => {
    const q = s[i++];
    let out = '';
    while (i < s.length && s[i] !== q) {
      if (s[i] === '\\' && i + 1 < s.length) {
        const c = s[++i];
        out += c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c;
      } else out += s[i];
      i++;
    }
    if (s[i] !== q) fail();
    i++;
    return out;
  };
  const json = () => {   // a balanced {...} or [...] that skips brackets inside JSON strings
    const start = i;
    let depth = 0, inStr = false;
    for (; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { if (--depth === 0) { i++; break; } }
    }
    const text = s.slice(start, i);
    try { return JSON.parse(text); } catch (_) { fail(); }
  };
  const bare = () => {
    const start = i;
    while (i < s.length && !/[,)]/.test(s[i])) i++;
    const text = s.slice(start, i).trim();
    if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
    if (/^(none|null)$/i.test(text)) return null;
    if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) return Number(text);
    return text;
  };
  const value = () => {
    ws();
    if (s[i] === "'" || s[i] === '"') return quoted();
    if (s[i] === '{' || s[i] === '[') return json();
    return bare();
  };
  try {
    ws();
    const listed = s[i] === '[';
    if (listed) i++;
    const calls = [];
    for (;;) {
      ws();
      if (listed && s[i] === ']') break;
      if (i >= s.length) break;
      const m = /^[A-Za-z_][\w.-]*/.exec(s.slice(i));
      if (!m) fail();
      i += m[0].length;
      ws();
      if (s[i++] !== '(') fail();
      const args = {};
      ws();
      while (s[i] !== ')') {
        ws();
        const k = /^[A-Za-z_]\w*/.exec(s.slice(i));
        if (!k) fail();
        i += k[0].length;
        ws();
        if (s[i++] !== '=') fail();
        args[k[0]] = value();
        ws();
        if (s[i] === ',') i++;
        else if (s[i] !== ')') fail();
        ws();
      }
      i++;
      calls.push({ name: m[0], args });
      ws();
      if (s[i] === ',') { i++; continue; }
      if (!listed) break;
    }
    return calls;
  } catch (_) { return null; }
}

const XML_CALL = /<function=([^>\n]+)>([\s\S]*?)(?:<\/function>|(?=<function=)|$)/g;
const XML_PARAM = /<parameter=([^>\n]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|(?=<\/function>)|$)/g;
const CALL_BLOCK = /<tool_call>([\s\S]*?)(?:<\/tool_call>|(?=<tool_call>)|$)/g;

// Parse the reply text. Returns { content, toolCalls } where `content` is the
// text with every call block removed and `toolCalls` are OpenAI-shaped
// ({ id, type:'function', function:{ name, arguments:<JSON string> } }).
export function parseLocalToolCalls(text, tools, { idPrefix = 'call_local' } = {}) {
  const source = String(text ?? '');
  const schemas = toolSchemas(tools);
  const toolCalls = [];
  // Small models sometimes change a tool name's case ("bash" for "Bash"); one
  // case-insensitive match is accepted, an ambiguous or missing one is not.
  const resolve = (name) => {
    const clean = String(name || '').trim();
    if (schemas.has(clean)) return clean;
    const folded = [...schemas.keys()].filter((k) => k.toLowerCase() === clean.toLowerCase());
    return folded.length === 1 ? folded[0] : null;
  };
  const add = (name, args) => {
    const clean = resolve(name);
    if (!clean) return;
    toolCalls.push({
      id: `${idPrefix}_${toolCalls.length}`,
      type: 'function',
      function: { name: clean, arguments: JSON.stringify(args && typeof args === 'object' ? args : {}) },
    });
  };
  const readXml = (body) => {
    for (const call of body.matchAll(XML_CALL)) {
      const name = call[1].trim();
      const props = schemas.get(resolve(name))?.properties || {};
      const args = {};
      for (const p of call[2].matchAll(XML_PARAM)) {
        const key = p[1].trim();
        args[key] = coerceParam(p[2], props[key]);
      }
      add(name, args);
    }
  };

  let content = source;
  if (source.includes('<|tool_call_start|>')) {
    for (const block of source.matchAll(LFM2_BLOCK)) {
      for (const call of parseLfm2Calls(block[1]) || []) add(call.name, call.args);
    }
    content = source.replace(LFM2_BLOCK, '');
  } else if (source.includes('<tool_call>')) {
    for (const block of source.matchAll(CALL_BLOCK)) {
      const body = block[1].trim();
      if (body.startsWith('{')) {
        try {
          const v = JSON.parse(body);
          let args = v?.arguments ?? v?.parameters ?? {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = {}; } }
          add(v?.name, args);
        } catch (_) {}
      } else {
        readXml(body);
      }
    }
    content = source.replace(CALL_BLOCK, '');
  } else if (source.includes('<function=')) {
    // The <tool_call> wrapper is sometimes lost; the function block alone still counts.
    readXml(source);
    content = source.replace(XML_CALL, '');
  }
  return { content: content.replace(/<\/?tool_call>/g, '').trim(), toolCalls };
}

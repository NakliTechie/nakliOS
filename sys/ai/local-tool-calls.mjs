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
//     models write `<tool_call>{"name":…,"arguments":…}</tool_call>`. Both parse.
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
  if (source.includes('<tool_call>')) {
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

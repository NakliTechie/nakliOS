// The text and vision AI adapter (spec 002 §9.4) for describe-and-rate (L65) and the edit assistant (L67).
// Route 1: the NakliOS host's AI broker (naklios.ai.chat.completions.create) when capabilities.ai is true;
// Atelier never sees that model, endpoint or key. Route 2: the person's own OpenAI-compatible endpoint and
// key, entered by the person in Atelier's settings, stored only in this browser (localStorage), off by
// default. With neither, the AI controls are hidden and the AI commands answer `unsupported`.

const KEY = 'atelier.ai.byok';

export function readByok(storage = globalThis.localStorage) {
  try { const v = JSON.parse(storage?.getItem(KEY) || 'null'); return v && typeof v === 'object' ? v : { enabled: false }; } catch { return { enabled: false }; }
}
export function writeByok(v, storage = globalThis.localStorage) {
  const clean = { enabled: !!v.enabled, endpoint: String(v.endpoint || '').trim(), model: String(v.model || '').trim(), key: String(v.key || '') };
  storage?.setItem(KEY, JSON.stringify(clean));
  return clean;
}
export function forgetByok(storage = globalThis.localStorage) { storage?.removeItem(KEY); }

// settings(): the BYOK record; naklios: the SDK object (or null standalone); fetchFn for tests.
export function textAi({ settings = () => readByok(), naklios = globalThis.naklios, fetchFn = (...a) => fetch(...a) } = {}) {
  const host = () => !!(naklios?.capabilities?.hosted && naklios.capabilities.ai && naklios.ai?.chat?.completions?.create);
  const own = () => { const s = settings(); return s.enabled && /^https?:\/\//.test(s.endpoint || '') && s.model ? s : null; };
  return {
    get available() { return host() || !!own(); },
    get route() { return host() ? 'host' : own() ? 'own key' : null; },
    get label() { if (host()) return naklios.capabilities.aiModelLabel || 'NakliOS AI'; const s = own(); return s ? `${s.model} at ${new URL(s.endpoint).host}` : 'none'; },
    // messages in OpenAI chat shape; returns the reply text.
    async chat(messages, { max_tokens = 600, signal } = {}) {
      if (host()) {
        const r = await naklios.ai.chat.completions.create({ messages, max_tokens, ...(signal ? { signal } : {}) });
        return r?.choices?.[0]?.message?.content ?? '';
      }
      const s = own();
      if (!s) throw Object.assign(new Error('no AI is set up: turn on your own key in AI settings, or use Atelier in NakliOS with AI on'), { code: 'unsupported' });
      const res = await fetchFn(`${s.endpoint.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', ...(s.key ? { Authorization: `Bearer ${s.key}` } : {}) },
        body: JSON.stringify({ model: s.model, messages, max_tokens, temperature: 0.2 }),
      });
      if (!res.ok) throw new Error(`the AI endpoint answered ${res.status}`);
      const j = await res.json();
      return j?.choices?.[0]?.message?.content ?? '';
    },
  };
}

// The first JSON object in a reply (models often wrap it in prose or a code fence).
export function firstJson(text) {
  const s = String(text); const i = s.indexOf('{');
  if (i < 0) return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) { try { return JSON.parse(s.slice(i, k + 1)); } catch { return null; } }
  }
  return null;
}

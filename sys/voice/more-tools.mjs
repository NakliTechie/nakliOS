// more-tools.mjs — the rest of LocalMind's agent tools, on NakliOS's own storage, relay, runtime and skills library.
// Every dependency is injected by the host (index.html), so the node test runs each tool on stand-ins.
//
//   memory     — { read(path) → text|null, write(path, text) } at MEMORY_PATH (Folder or Crate, else browser storage)
//   apps       — { tools: [{ name, description, inputSchema }], invoke(name, args) → { ok, result | code, message } }:
//                the commands apps declare on the common rail (apps/<id>/commands.json), called through the
//                desktop catalog with the assistant's own grant; the apps alone read and write their files
//   fetchText  — (url) → { status, text, via, plain? }: direct, then the NakliOS web relay, then a reader service the
//                person allowed once (plain: true when it already returns readable text, not HTML)
//   search     — () → { provider, key, url }: Brave, Tavily or SearXNG, set by the person in the assistant's settings
//   python     — () → Promise<{ runCode(code) → { stdout, stderr, result } }>: NakliOS's own Pyodide runtime (Kiln)
//   skills     — { propose({ name, description, body }) }: a staged skill in the shared library, active only once a
//                person activates it in Settings → Skills
//   webOn      — () → bool: the panel's "Web lookups" switch

export const MEMORY_PATH = 'assistant/memory.json';
const MEMORY_CATEGORIES = ['fact', 'preference', 'task', 'finding'];

async function readMemories(memory) {
  try { const v = JSON.parse((await memory.read(MEMORY_PATH)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
const words = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
// Plain word overlap: memories are short, and a spoken query names the thing it wants.
function rank(memories, query) {
  const q = new Set(words(query));
  return memories.map((m) => ({ m, score: words(m.content).filter((w) => q.has(w)).length }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).map((x) => x.m);
}

// The newest memories as a system-prompt paragraph, so the model answers "who is my dentist" without having to pick a
// tool: on the real model it looked that up on Wikipedia instead of calling search_memory (headless check, 2026-10-30).
export async function memoryContext(memory, { max = 30 } = {}) {
  const list = await readMemories(memory);
  if (!list.length) return '';
  // The model saw these facts and still searched the web for them, so the rule says plainly not to.
  return 'What the person asked you to remember (true, and about them personally). When a question is about one of '
    + 'these, answer from it directly and call no tool:\n' + list.slice(-max).map((m) => `- ${m.content}`).join('\n');
}

// ── app commands on the common rail ──
// The model was tuned on these tool names (the 95-question battery, 2026-10-30), so the catalog names map onto them;
// every other app command is reached through two fixed tools, because a small model's accuracy falls as its tool list
// grows and the catalog keeps growing.
const APP_TOOL_NAMES = {
  'notes.list.add': 'add_to_list', 'notes.list.read': 'read_list', 'notes.note.create': 'create_note',
  'calendar.events.create': 'create_calendar_event', 'calendar.events.list': 'get_calendar_events',
};
// A small model reads a tool result whole, so a large one is cut with a note saying so.
const RESULT_MAX_CHARS = 4000;
function fitResult(result) {
  const text = JSON.stringify(result);
  return text && text.length > RESULT_MAX_CHARS ? `${text.slice(0, RESULT_MAX_CHARS)} … (cut; ask for a smaller part)` : result;
}
async function runAppCommand(apps, name, args) {
  const out = await apps.invoke(name, args);
  if (!out || !out.ok) throw new Error(out?.message || out?.code || `${name} did not answer`);
  return out.result;
}
function appTools(apps) {
  const commands = apps.tools || [];
  const tuned = commands.filter((command) => APP_TOOL_NAMES[command.name]).map((command) => ({
    name: APP_TOOL_NAMES[command.name],
    description: command.description,
    parameters: command.inputSchema,
    run: (args) => runAppCommand(apps, command.name, args),
  }));
  const others = commands.filter((command) => !APP_TOOL_NAMES[command.name]);
  if (!others.length) return tuned;
  return [...tuned, {
    name: 'find_app_action',
    description: 'Find what another app can do, such as Reckon sheets, Draft documents, KanZen boards or Sheaf PDFs. Call this first, then run_app_action.',
    parameters: { type: 'object', properties: { about: { type: 'string', description: 'The app or the task, e.g. "kanzen card"' } }, required: ['about'] },
    async run({ about }) {
      const words = String(about || '').toLowerCase().split(/\W+/).filter(Boolean);
      const score = (command) => words.filter((word) => `${command.name} ${command.description}`.toLowerCase().includes(word)).length;
      return others.map((command) => [score(command), command]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 5)
        .map(([, { name, description, inputSchema }]) => ({ name, description, input: inputSchema }));
    },
  }, {
    name: 'run_app_action',
    description: 'Run an action that find_app_action returned, by its exact name.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, input: { type: 'object' } }, required: ['name'] },
    run({ name, input }) {
      if (!others.some((command) => command.name === name)) throw new Error(`no app action named ${name}; call find_app_action first`);
      return runAppCommand(apps, name, input || {}).then(fitResult);
    },
  }];
}

// ── web search: LocalMind's three providers ──
const PROVIDERS = {
  async brave(query, { key }) {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      { headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
    if (!res.ok) throw new Error(`Brave Search answered HTTP ${res.status}`);
    const d = await res.json();
    return (d.web?.results || []).slice(0, 5).map((r) => ({ title: r.title, url: r.url, snippet: r.description || '' }));
  },
  async tavily(query, { key }) {
    const res = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, search_depth: 'basic', max_results: 5 }) });
    if (!res.ok) throw new Error(`Tavily answered HTTP ${res.status}`);
    const d = await res.json();
    return (d.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content || '' }));
  },
  async searxng(query, { url }) {
    const res = await fetch(`${String(url).replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json&categories=general`);
    if (!res.ok) throw new Error(`SearXNG answered HTTP ${res.status}`);
    const d = await res.json();
    return (d.results || []).slice(0, 5).map((r) => ({ title: r.title, url: r.url, snippet: r.content || '' }));
  },
};
export const SEARCH_PROVIDERS = Object.keys(PROVIDERS);

// Readable text from HTML: drops scripts, styles and navigation, prefers <article> or <main>.
export function pageText(html, { cap = 3000, parse = (h) => new DOMParser().parseFromString(h, 'text/html') } = {}) {
  const doc = parse(String(html));
  doc.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,svg').forEach((n) => n.remove());
  const node = doc.querySelector('article') || doc.querySelector('main') || doc.body;
  const text = String(node?.textContent || '').replace(/\s+/g, ' ').trim();
  return { title: String(doc.title || '').trim(), text: text.length > cap ? text.slice(0, cap) + ' …' : text };
}

export function moreTools({ memory, apps, fetchText, search, python, skills, webOn = () => true, now = () => new Date(), parseHtml } = {}) {
  const needWeb = () => { if (!webOn()) throw new Error('web lookups are switched off in the assistant panel'); };
  return [
    {
      name: 'store_memory',
      description: 'Remember a fact, preference or task the person tells you, so it is there in later conversations.',
      parameters: { type: 'object', properties: {
        content: { type: 'string', description: 'What to remember, as one short sentence' },
        category: { type: 'string', enum: MEMORY_CATEGORIES, description: 'Kind of memory (default fact)' },
      }, required: ['content'] },
      async run({ content, category = 'fact' }) {
        const text = String(content).trim().slice(0, 500);
        if (!text) throw new Error('content is empty');
        const list = await readMemories(memory);
        const item = { id: `m${now().getTime().toString(36)}-${list.length}`, content: text, category: MEMORY_CATEGORIES.includes(category) ? category : 'fact', at: now().toISOString() };
        list.push(item);
        await memory.write(MEMORY_PATH, JSON.stringify(list, null, 2));
        return { stored: true, id: item.id, count: list.length };
      },
    },
    {
      name: 'search_memory',
      description: 'Find what the person told you before. Use when they ask about something you may have been told.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look for' } }, required: ['query'] },
      async run({ query }) {
        const hits = rank(await readMemories(memory), query).slice(0, 5);
        return hits.length ? { found: hits.map(({ content, category, at }) => ({ content, category, at })) } : { found: [], message: 'Nothing stored matches.' };
      },
    },
    {
      name: 'list_memories',
      description: 'List everything you remember about the person, newest first.',
      parameters: { type: 'object', properties: {}, required: [] },
      async run() {
        const list = await readMemories(memory);
        return { count: list.length, memories: list.slice(-20).reverse().map(({ content, category }) => ({ content, category })) };
      },
    },
    {
      name: 'delete_memory',
      description: 'Forget memories that match what the person asks you to forget.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to forget' } }, required: ['query'] },
      async run({ query }) {
        const list = await readMemories(memory);
        const gone = new Set(rank(list, query).map((m) => m.id));
        if (!gone.size) return { deleted: 0, message: 'Nothing stored matches.' };
        await memory.write(MEMORY_PATH, JSON.stringify(list.filter((m) => !gone.has(m.id)), null, 2));
        return { deleted: gone.size };
      },
    },
    ...(apps ? appTools(apps) : []),
    {
      name: 'web_search',
      description: 'Search the web for current information, such as news or facts you do not know.',
      // Offered only once the person has set a provider in the panel's settings, as in LocalMind.
      available: () => { const cfg = search(); return !!(webOn() && cfg && PROVIDERS[cfg.provider] && (cfg.key || cfg.url)); },
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search words, 3 to 8' } }, required: ['query'] },
      async run({ query }) {
        needWeb();
        const cfg = search();
        if (!cfg || !PROVIDERS[cfg.provider] || !(cfg.key || cfg.url)) throw new Error('no search provider is set; the person can add one in the assistant settings (⚙)');
        return { provider: cfg.provider, results: await PROVIDERS[cfg.provider](String(query).slice(0, 200), cfg) };
      },
    },
    {
      name: 'fetch_page',
      description: 'Read the text of a web page, for example a result from web_search.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full https URL' } }, required: ['url'] },
      async run({ url }) {
        needWeb();
        let u;
        try { u = new URL(String(url)); } catch { throw new Error('url is not a valid address'); }
        if (!/^https?:$/.test(u.protocol)) throw new Error('only http and https pages can be read');
        const got = await fetchText(u.href);
        if (got.status >= 400) throw new Error(`the page answered HTTP ${got.status}`);
        if (got.plain) { const t = String(got.text).replace(/\s+/g, ' ').trim(); return { url: u.href, via: got.via, text: t.length > 3000 ? t.slice(0, 3000) + ' …' : t }; }
        return { url: u.href, via: got.via, ...pageText(got.text, parseHtml ? { parse: parseHtml } : {}) };
      },
    },
    {
      name: 'run_python',
      description: 'Run a short Python program and return what it prints. Use for exact calculations or data work.',
      parameters: { type: 'object', properties: { code: { type: 'string', description: 'Python source' } }, required: ['code'] },
      async run({ code }) {
        const rt = await python();
        const out = await rt.runCode(String(code), { outputCapBytes: 4000 });
        return { stdout: String(out.stdout || '').slice(0, 2000), stderr: String(out.stderr || '').slice(0, 1000), result: out.result ?? null };
      },
    },
    {
      name: 'save_skill',
      description: 'Propose a reusable instruction for a kind of task. It waits for the person to approve it in Settings → Skills.',
      parameters: { type: 'object', properties: {
        name: { type: 'string', description: 'Short lowercase name with dashes, e.g. "brief-weather"' },
        description: { type: 'string', description: 'When to use it, one sentence' },
        instructions: { type: 'string', description: 'The approach, as a direct instruction' },
      }, required: ['name', 'description', 'instructions'] },
      async run({ name, description, instructions }) {
        const r = await skills.propose({ name: String(name), description: String(description), body: String(instructions) });
        if (!r?.ok) throw new Error(r?.message || 'the skill was not saved');
        return { proposed: true, name, status: r.status, note: 'The person activates it in Settings → Skills.' };
      },
    },
  ];
}

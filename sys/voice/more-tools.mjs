// more-tools.mjs — the rest of LocalMind's agent tools, on NakliOS's own storage, relay, runtime and skills library.
// Every dependency is injected by the host (index.html), so the node test runs each tool on stand-ins.
//
//   memory     — { read(path) → text|null, write(path, text) } at MEMORY_PATH (Folder or Crate, else browser storage)
//   calendar   — { read() → text|null, write(text) }: the Calendar app's own calendar.json, wherever Calendar keeps it
//   calendarCore — () → Promise<CalendarCore>: the Calendar app's own date code (apps/calendar/core.js), for repeats
//   notes      — { label, read(path) → text|null, write(path, text) }: the Notes app's own files (library.json and
//                notes/<id>.md|json), wherever Notes keeps them; lists are ordinary notes titled by the list's name
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

// ── calendar: the Calendar app's event shape (apps/calendar/index.html) ──
const pad = (n) => String(n).padStart(2, '0');
const localStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function calendarEvent(args, { now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, id } = {}) {
  const title = String(args?.title ?? '').trim();
  if (!title) throw new Error('title is required');
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(String(args?.start ?? '').trim());
  if (!m) throw new Error('start must be a local date-time such as "2026-11-02T15:00", or a date for an all-day event');
  const allDay = m[4] === undefined;
  const start = new Date(+m[1], +m[2] - 1, +m[3], allDay ? 0 : +m[4], allDay ? 0 : +m[5]);
  if (start.getMonth() !== +m[2] - 1 || start.getDate() !== +m[3]) throw new Error(`start ${args.start} is not a real date`);
  if (start.getTime() < now.getTime() - (allDay ? 86400e3 : 3600e3)) throw new Error(`start ${args.start} is in the past; call get_time for today's date`);
  const minutes = args?.duration_minutes == null ? 60 : Math.round(Number(args.duration_minutes));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10080) throw new Error('duration_minutes must be between 1 and 10080');
  const end = allDay ? new Date(start.getTime() + 86400e3) : new Date(start.getTime() + minutes * 60e3);
  return {
    id: id || globalThis.crypto?.randomUUID?.() || `event-${now.getTime().toString(36)}`,
    title: title.slice(0, 180), description: '', location: String(args?.location ?? '').slice(0, 200),
    startLocal: allDay ? localStamp(start).slice(0, 10) : localStamp(start),
    endLocal: allDay ? localStamp(end).slice(0, 10) : localStamp(end),
    allDay, timeZone, recurrence: { frequency: 'none', interval: 1, until: null },
  };
}

// ── Notes: the app's own library shape (apps/notes/index.html: normaliseLibrary, createNote, writeMetadata) ──
const NOTES_LIBRARY = 'library.json';
const notesExcerpt = (text) => String(text || '').replace(/[#>*_`~[\]-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
async function readNotesLibrary(notes, now) {
  let lib; try { lib = JSON.parse((await notes.read(NOTES_LIBRARY)) || 'null'); } catch { lib = null; }
  const ts = now().getTime();
  if (!lib || lib.version !== 1) lib = { version: 1, updatedAt: ts, notebooks: [{ id: 'inbox', name: 'Notes', createdAt: ts }], notes: [] };
  if (!Array.isArray(lib.notes)) lib.notes = [];
  if (!Array.isArray(lib.notebooks) || !lib.notebooks.some((b) => b.id === 'inbox')) lib.notebooks = [{ id: 'inbox', name: 'Notes', createdAt: ts }, ...(lib.notebooks || [])];
  return lib;
}
// "my shopping list", "the shopping list", "Shopping list" and "shopping" are the same list.
const listKey = (t) => String(t).trim().toLowerCase().replace(/^(my|the|our)\s+/, '').replace(/\s+list$/, '');
const sameTitle = (a, b) => listKey(a) === listKey(b);
async function saveNote(notes, lib, note, body, now) {
  const ts = now().getTime();
  Object.assign(note, { excerpt: notesExcerpt(body), updatedAt: ts });
  await notes.write(`notes/${note.id}.md`, body);
  await notes.write(`notes/${note.id}.json`, JSON.stringify(note, null, 2));
  lib.updatedAt = ts;
  await notes.write(NOTES_LIBRARY, JSON.stringify(lib, null, 2));
}
function newNote(lib, title, now) {
  const ts = now().getTime();
  const note = { id: `note-${globalThis.crypto?.randomUUID?.() || ts.toString(36)}`, notebookId: 'inbox', title: String(title).slice(0, 180),
    excerpt: '', pinned: false, trashedAt: null, createdAt: ts, updatedAt: ts };
  lib.notes.unshift(note);
  return note;
}
const listItems = (body) => String(body || '').split('\n').map((l) => l.match(/^\s*[-*]\s+(?:\[[ x]\]\s+)?(.*\S)/)?.[1]).filter(Boolean);

function notesTools(notes, now) {
  const findList = (lib, list) => lib.notes.find((n) => !n.trashedAt && sameTitle(n.title, list));
  const listTitle = (list) => { const t = listKey(list); return `${t[0].toUpperCase() + t.slice(1)} list`; };
  return [
    {
      name: 'add_to_list',
      description: 'Add items to a list in the Notes app, e.g. "add milk and eggs to my shopping list". Creates the list if it is new.',
      parameters: { type: 'object', properties: {
        list: { type: 'string', description: 'List name, e.g. "shopping"' },
        items: { type: 'string', description: 'The items, separated by commas or "and"' },
      }, required: ['list', 'items'] },
      async run({ list, items }) {
        const add = String(items).split(/,|\band\b/i).map((x) => x.trim()).filter(Boolean).slice(0, 30);
        if (!add.length) throw new Error('no items to add');
        const lib = await readNotesLibrary(notes, now);
        const note = findList(lib, list) || newNote(lib, listTitle(list), now);
        let body = ''; try { body = (await notes.read(`notes/${note.id}.md`)) || ''; } catch { body = ''; }
        body = `${body.replace(/\s*$/, '')}${body.trim() ? '\n' : ''}${add.map((x) => `- ${x}`).join('\n')}\n`;
        await saveNote(notes, lib, note, body, now);
        return { list: note.title, added: add, count: listItems(body).length, where: notes.label || 'Notes' };
      },
    },
    {
      name: 'read_list',
      description: 'Read a list from the Notes app, e.g. "what is on my shopping list".',
      parameters: { type: 'object', properties: { list: { type: 'string', description: 'List name' } }, required: ['list'] },
      async run({ list }) {
        const lib = await readNotesLibrary(notes, now);
        const note = findList(lib, list);
        if (!note) return { list, items: [], message: `There is no ${list} list.` };
        return { list: note.title, items: listItems((await notes.read(`notes/${note.id}.md`)) || '') };
      },
    },
    {
      name: 'create_note',
      description: 'Write a new note in the Notes app, e.g. "make a note that the plumber comes on Tuesday".',
      parameters: { type: 'object', properties: {
        title: { type: 'string', description: 'A short title' },
        text: { type: 'string', description: 'The note' },
      }, required: ['text'] },
      async run({ title, text }) {
        const lib = await readNotesLibrary(notes, now);
        const body = `${String(text).trim()}\n`;
        const note = newNote(lib, title || String(text).trim().split(/[.\n]/)[0].slice(0, 60) || 'Note', now);
        await saveNote(notes, lib, note, body, now);
        return { created: note.title, where: notes.label || 'Notes' };
      },
    },
  ];
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

export function moreTools({ memory, calendar, calendarCore, notes, fetchText, search, python, skills, webOn = () => true, now = () => new Date(), parseHtml } = {}) {
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
    {
      name: 'create_calendar_event',
      description: 'Add an event to the NakliOS Calendar. For a relative day ("next Friday") call get_time first.',
      parameters: { type: 'object', properties: {
        title: { type: 'string', description: 'Event title, e.g. "Dentist"' },
        start: { type: 'string', description: 'Local start, e.g. "2026-11-02T15:00", or "2026-11-02" for all day' },
        duration_minutes: { type: 'number', description: 'Length in minutes (default 60)' },
        location: { type: 'string', description: 'Where (optional)' },
      }, required: ['title', 'start'] },
      async run(args) {
        const event = calendarEvent(args, { now: now() });
        let data;
        try { data = JSON.parse((await calendar.read()) || 'null'); } catch { data = null; }
        if (!data || data.version !== 1 || !Array.isArray(data.events)) data = { version: 1, updatedAt: now().toISOString(), events: [] };
        data.events.push(event);
        data.updatedAt = now().toISOString();
        await calendar.write(JSON.stringify(data, null, 2));
        return { created: true, title: event.title, start: event.startLocal, end: event.endLocal, all_day: event.allDay, where: calendar.label || 'Calendar' };
      },
    },
    ...(notes ? notesTools(notes, now) : []),
    {
      name: 'get_calendar_events',
      description: 'Read what is on the NakliOS Calendar for a day or a few days, e.g. "what is on today", "am I free tomorrow".',
      parameters: { type: 'object', properties: {
        date: { type: 'string', description: 'First day, "YYYY-MM-DD" (default today); call get_time first for "tomorrow" or a weekday' },
        days: { type: 'number', description: 'How many days, 1 to 14 (default 1)', minimum: 1, maximum: 14 },
      }, required: [] },
      async run({ date, days = 1 }) {
        const today = now();
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim());
        if (date != null && !m) throw new Error('date must be "YYYY-MM-DD"');
        const start = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const end = new Date(start); end.setDate(end.getDate() + Math.round(days));
        let data; try { data = JSON.parse((await calendar.read()) || 'null'); } catch { data = null; }
        const events = data?.version === 1 && Array.isArray(data.events) ? data.events : [];
        const core = await calendarCore();
        const hits = core.expandEvents(events, start.getTime(), end.getTime()).slice(0, 30).map((o) => ({
          title: o.event.title, start: o.event.allDay ? `${o.startLocal} (all day)` : o.startLocal.replace('T', ' '),
          ...(o.event.location ? { location: o.event.location } : {}),
        }));
        const label = `${localStamp(start).slice(0, 10)}${days > 1 ? ` for ${Math.round(days)} days` : ''}`;
        return hits.length ? { range: label, events: hits } : { range: label, events: [], message: 'Nothing on the calendar.' };
      },
    },
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

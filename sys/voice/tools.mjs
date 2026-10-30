// tools.mjs — the voice assistant's tools, in the LocalMind shape ({ name, description, parameters }).
// Each tool also carries run(args) → result. The registry checks arguments against the schema
// before a tool runs, because a small model's arguments are not trusted.

function checkArgs(parameters, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const props = parameters?.properties || {};
  for (const key of parameters?.required || []) if (args[key] === undefined) return `missing ${key}`;
  for (const [key, value] of Object.entries(args)) {
    const rule = props[key];
    if (!rule) return `unknown argument ${key}`;
    if (rule.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `${key} must be a number`;
    if (rule.type === 'string' && typeof value !== 'string') return `${key} must be a string`;
    if (rule.enum && !rule.enum.includes(value)) return `${key} must be one of ${rule.enum.join(', ')}`;
    if (rule.minimum !== undefined && value < rule.minimum) return `${key} must be at least ${rule.minimum}`;
    if (rule.maximum !== undefined && value > rule.maximum) return `${key} must be at most ${rule.maximum}`;
  }
  return null;
}

// The LFM3 chat template loops over a call's arguments with `args.items()`, and the browser's Jinja looks up a key before
// the method, so an argument named `items` breaks every later turn ("Cannot call something that is not a function").
const RESERVED_ARGS = new Set(['items', 'keys', 'values', 'get']);

export function createToolRegistry(tools = []) {
  const byName = new Map();
  const reg = {
    add(tool) {
      if (!tool?.name || typeof tool.run !== 'function') throw new Error('A tool needs a name and run()');
      const clash = Object.keys(tool.parameters?.properties || {}).find((k) => RESERVED_ARGS.has(k));
      if (clash) throw new Error(`${tool.name}: an argument may not be named "${clash}" (the chat template reads it as a method)`);
      byName.set(tool.name, tool);
      return reg;
    },
    has: (name) => byName.has(name),
    // A tool with available() → false (web search with no provider set) is not offered, so the model never calls it.
    list: () => [...byName.values()].filter((t) => !t.available || t.available())
      .map(({ name, description, parameters }) => ({ name, description, parameters })),
    async run(name, args = {}) {
      const tool = byName.get(name);
      if (!tool || (tool.available && !tool.available())) return { ok: false, error: `unknown tool ${name}` };
      const bad = checkArgs(tool.parameters, args);
      if (bad) return { ok: false, error: bad };
      try { return { ok: true, result: await tool.run(args) }; }
      catch (error) { return { ok: false, error: String(error?.message || error) }; }
    },
  };
  tools.forEach(reg.add);
  return reg;
}

// Timers live in the assistant, so they survive closing the panel; onDone announces each one.
export function createTimers({ onDone = () => {}, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, now = Date.now } = {}) {
  const active = new Map();
  let seq = 0;
  return {
    start(seconds, label = '') {
      const id = `timer-${++seq}`;
      const endsAt = now() + seconds * 1000;
      const handle = setTimeoutFn(() => { active.delete(id); onDone({ id, seconds, label }); }, seconds * 1000);
      active.set(id, { id, seconds, label, endsAt, handle });
      // Local clock time, because the model reads the result out loud.
      return { id, seconds, label, endsAt: new Date(endsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }) };
    },
    cancel(id) { const t = active.get(id); if (!t) return false; clearTimeoutFn(t.handle); active.delete(id); return true; },
    list: () => [...active.values()].map(({ id, seconds, label, endsAt }) => ({ id, seconds, label, endsAt })),
  };
}

// Reminders at a clock time ("remind me at 5 pm", "wake me at 7"). Kept in `store` (this browser's localStorage), so they
// survive a reload; one that came due while the page was closed fires as soon as the assistant loads, marked late.
const MAX_DELAY = 2 ** 31 - 1;   // setTimeout's limit (about 24.8 days); longer waits re-arm
export function createReminders({ onDue = () => {}, store = null, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let list = [];
  try { list = (store?.load() || []).filter((r) => r && r.id && Number.isFinite(r.at)); } catch (_) {}
  const handles = new Map();
  let seq = 0;
  const save = () => { try { store?.save(list); } catch (_) {} };
  function fire(r, late) { handles.delete(r.id); list = list.filter((x) => x.id !== r.id); save(); onDue({ ...r, late }); }
  function arm(r, first = false) {
    const wait = r.at - now();
    if (wait <= 0) return fire(r, first && wait < -60000);
    handles.set(r.id, setTimeoutFn(() => (r.at - now() > 0 ? arm(r) : fire(r, false)), Math.min(wait, MAX_DELAY)));
  }
  const spoken = (at) => new Date(at).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  list.forEach((r) => arm(r, true));
  return {
    add(at, message) {
      const r = { id: `reminder-${now().toString(36)}-${++seq}`, at, message: String(message || '').slice(0, 200) };
      list.push(r); save(); arm(r);
      return { id: r.id, message: r.message, when: spoken(at) };
    },
    cancel(id) { const h = handles.get(id); if (h) clearTimeoutFn(h); handles.delete(id); const n = list.length; list = list.filter((r) => r.id !== id); save(); return list.length < n; },
    list: () => [...list].sort((a, b) => a.at - b.at).map((r) => ({ id: r.id, message: r.message, when: spoken(r.at) })),
    raw: () => [...list],
  };
}

// "17:00", "5 pm", "2026-11-02T17:00" → a time in ms; a bare clock time already past today means tomorrow.
export function parseReminderTime(text, nowDate = new Date()) {
  const s = String(text ?? '').trim().toLowerCase();
  let m = /^(\d{4})-(\d{2})-(\d{2})[t ](\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    if (d.getDate() !== +m[3] || +m[4] > 23 || +m[5] > 59) throw new Error(`${text} is not a real date and time`);
    return d.getTime();
  }
  m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
  if (!m) throw new Error('at must be a clock time such as "17:00" or "5 pm", or a local date-time such as "2026-11-02T17:00"');
  let h = +m[1]; const min = m[2] ? +m[2] : 0; const ap = m[3]?.[0];
  if (ap && (h < 1 || h > 12)) throw new Error(`${text} is not a clock time`);
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || min > 59) throw new Error(`${text} is not a clock time`);
  const d = new Date(nowDate); d.setHours(h, min, 0, 0);
  if (d.getTime() <= nowDate.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function reminderTools(reminders, now) {
  return [
    {
      name: 'set_reminder',
      description: 'Remind the person at a clock time, e.g. "remind me at 5 pm to call Mum" or "wake me at 7". For a length of time ("in 10 minutes") use set_timer.',
      parameters: { type: 'object', properties: {
        at: { type: 'string', description: 'Clock time ("17:00", "5 pm") or local date-time ("2026-11-02T17:00")' },
        message: { type: 'string', description: 'What to remind them of' },
      }, required: ['at'] },
      run: ({ at, message = '' }) => reminders.add(parseReminderTime(at, now()), message),
    },
    {
      name: 'list_reminders',
      description: 'List the reminders that are set.',
      parameters: { type: 'object', properties: {}, required: [] },
      run: () => ({ reminders: reminders.list() }),
    },
    {
      name: 'cancel_reminder',
      description: 'Cancel a reminder, by words from its message.',
      parameters: { type: 'object', properties: { message: { type: 'string', description: 'Words from the reminder' } }, required: ['message'] },
      run({ message }) {
        const want = String(message).toLowerCase();
        const hit = reminders.list().find((r) => r.message.toLowerCase().includes(want) || want.includes(r.message.toLowerCase()));
        if (!hit) throw new Error(`no reminder matches "${message}"`);
        reminders.cancel(hit.id);
        return { cancelled: hit.message, was: hit.when };
      },
    },
  ];
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// host: { listApps() → [{id,name}], openApp(id) } — the host passes its command registry's apps.* commands.
export function builtinTools({ host, timers, reminders = null, nav = globalThis.navigator, now = () => new Date() }) {
  return [
    ...(reminders ? reminderTools(reminders, now) : []),
    {
      name: 'set_timer',
      description: 'Start a countdown timer. Say when it ends.',
      parameters: { type: 'object', properties: {
        seconds: { type: 'number', description: 'Length of the timer in seconds', minimum: 1, maximum: 86400 },
        label: { type: 'string', description: 'Optional name for the timer' },
      }, required: ['seconds'] },
      run: ({ seconds, label }) => timers.start(seconds, label),
    },
    {
      name: 'get_battery',
      description: "Read the device's battery level and whether it is charging.",
      parameters: { type: 'object', properties: {}, required: [] },
      async run() {
        if (typeof nav?.getBattery !== 'function') return { available: false };
        const b = await nav.getBattery();
        return { available: true, level: b.level, charging: b.charging };
      },
    },
    {
      name: 'get_network_status',
      description: 'Check whether the device is online, and the connection type when the browser reports it.',
      parameters: { type: 'object', properties: {}, required: [] },
      run: () => ({ online: nav?.onLine !== false, effectiveType: nav?.connection?.effectiveType ?? null }),
    },
    {
      name: 'open_app',
      description: 'Open a NakliOS app by its name, for example Notes, Files or Calendar.',
      parameters: { type: 'object', properties: {
        name: { type: 'string', description: 'App name or id' },
      }, required: ['name'] },
      async run({ name }) {
        const apps = await host.listApps();
        const want = norm(name);
        const app = apps.find((a) => norm(a.id) === want) || apps.find((a) => norm(a.name) === want)
          || apps.find((a) => norm(a.name).startsWith(want));
        if (!app) throw new Error(`No app called ${name}`);
        await host.openApp(app.id);
        return { id: app.id, name: app.name };
      },
    },
    {
      name: 'get_time',
      description: 'Read the current date and time, here or in another time zone.',
      parameters: { type: 'object', properties: {
        timezone: { type: 'string', description: 'IANA time zone, e.g. "America/New_York" (default: this device)' },
      }, required: [] },
      run({ timezone } = {}) {
        const d = now();
        const timeZone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        return {
          iso: d.toISOString(),
          local: d.toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone }),
          timeZone,
        };
      },
    },
  ];
}

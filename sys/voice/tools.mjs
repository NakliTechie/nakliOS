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

export function createToolRegistry(tools = []) {
  const byName = new Map();
  const reg = {
    add(tool) {
      if (!tool?.name || typeof tool.run !== 'function') throw new Error('A tool needs a name and run()');
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

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// host: { listApps() → [{id,name}], openApp(id) } — the host passes its command registry's apps.* commands.
export function builtinTools({ host, timers, nav = globalThis.navigator, now = () => new Date() }) {
  return [
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

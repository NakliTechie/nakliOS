// Plugin commands (P59): list the plugins in the workspace and run one in its locked-down Worker
// (src/plugins/host.js). Every call a plugin makes goes through bus.dispatch with door 'plugin'.

import { PLUGIN_DIR, checkPlugin, checkScript, runPluginWorker } from '../plugins/host.js';
import { fail } from './util.js';

export function register(bus, ctx) {
  const store = () => { const s = ctx.storage(); if (!s) fail('unsupported', 'no workspace storage; grant a folder or allow browser storage', 'use_ui_control', 'grant_folder'); return s; };

  async function readPlugin(s, path) {
    let p; try { p = JSON.parse(await s.readText(path)); } catch (e) { return { path, error: `not valid JSON: ${e.message}` }; }
    const bad = checkPlugin(p, bus.manifest);
    return bad ? { path, error: bad } : { path, plugin: p, scriptPath: `${path.replace(/plugin\.json$/, '')}${p.script}` };
  }

  bus.register('query.plugins', async () => {
    const s = store(); const out = [];
    for (const e of await s.list(PLUGIN_DIR)) {
      if (!e.path.endsWith('/plugin.json')) continue;
      const r = await readPlugin(s, e.path);
      out.push(r.error ? { path: r.path, error: r.error } : { name: r.plugin.name, description: r.plugin.description ?? '', commands: r.plugin.commands, path: r.path });
    }
    return { plugins: out, runs: typeof Worker !== 'undefined' };
  });

  bus.register('plugin.run', async (a, { viewOnly, door }) => {
    viewOnly();   // the plugin's own calls change the revision
    if (door === 'plugin') fail('person_only', 'a plugin cannot run plugins', 'use_ui_control', 'run_plugin');
    if (typeof Worker === 'undefined') fail('unsupported', 'plugins run in the app window (a Web Worker)', 'use_ui_control', 'run_plugin');
    const s = store();
    const path = `${PLUGIN_DIR}/${a.name}/plugin.json`;
    if (!(await s.exists(path))) fail('invalid', `no plugin ${a.name} (looked for ${path})`, 'fix_argument', 'list_plugins');
    const r = await readPlugin(s, path);
    if (r.error) fail('invalid', `${path}: ${r.error}`, 'fix_argument', 'list_plugins');
    if (!(await s.exists(r.scriptPath))) fail('invalid', `no script ${r.scriptPath}`, 'fix_argument', 'list_plugins');
    const src = await s.readText(r.scriptPath);
    const bad = checkScript(src);
    if (bad) fail('invalid', `${r.scriptPath}: ${bad}`, 'fix_argument', 'list_plugins');
    const out = await runPluginWorker(src, r.plugin, (command, args) => bus.dispatch(command, args, { door: 'plugin', caller: `plugin ${r.plugin.name}` }), { timeoutMs: (a.timeoutSeconds ?? 60) * 1000 });
    return { plugin: r.plugin.name, ...out };
  });
}

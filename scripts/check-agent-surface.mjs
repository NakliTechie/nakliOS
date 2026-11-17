#!/usr/bin/env node
// App-shell layer 4 (docs/specs/app-shell-001.md section 10.8): every app that adopts the shared assistant publishes
// the agent surface, and every visible control in it names a published command or says why it has none.
//
//   node scripts/check-agent-surface.mjs                      static: apps/<id>/commands.json in this checkout
//   node scripts/check-agent-surface.mjs --apps <dir>         static, reading <dir>/<id>/commands.json instead
//   node scripts/check-agent-surface.mjs --live <origin>      also live: loads <origin>/apps/<id>/index.html in Chrome
//                                                             over the CDP daemon (127.0.0.1:9334) and runs
//                                                             naklishell.current.parity() in the page
import { readFileSync } from 'node:fs';
import { createCatalog } from '../sys/host/catalog.mjs';
import { createHostRegistry, HOST_COMMANDS } from '../sys/host/agent.mjs';

export const ADOPTERS = ['pellucia', 'reckon', 'draft', 'chartella', 'sonella', 'montella'];
export const REQUIRED = ['file.save', 'file.save_as', 'file.open', 'file.new', 'file.info',
  'assistant.ask', 'assistant.status', 'assistant.stop', 'script.run', 'view.snapshot', 'doc.describe'];

const arg = (name, fallback = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const appsDir = arg('--apps', new URL('../apps/', import.meta.url).pathname);
const live = arg('--live');
const only = arg('--only');
const ids = only ? only.split(',') : ADOPTERS;

export function surfaceProblems(id, manifest, base) {
  const problems = [];
  const commands = Array.isArray(manifest?.commands) ? manifest.commands : [];
  const names = new Set(commands.map(c => c.name));
  // Sonella publishes grouped rail entries ({ command, params }); its individual commands reach the assistant in-process.
  for (const name of REQUIRED) if (!names.has(name)) problems.push(`${id}: commands.json lacks ${name}`);
  for (const c of commands) {
    if (typeof c.description !== 'string' || c.description.length < 8) problems.push(`${id}: ${c.name} has no description`);
    if (!c.input || typeof c.input !== 'object' || c.input.type !== 'object') problems.push(`${id}: ${c.name} has no object input schema`);
  }
  if (base) {
    const out = createCatalog({ base }).declare(id, commands, () => {});
    if (!out.ok) problems.push(`${id}: the host catalog refuses the manifest: ${out.error}`);
  }
  return problems;
}

async function cdp(body) {
  const res = await fetch('http://127.0.0.1:9334', { method: 'POST', body: JSON.stringify(body) });
  return JSON.parse(await res.text());
}
async function liveParity(origin, id) {
  const { targetId } = await cdp({ cmd: 'raw', text: JSON.stringify({ method: 'Target.createTarget', params: { url: `${origin}/apps/${id}/index.html`, newWindow: true, background: true } }) });
  try {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      const ready = await cdp({ cmd: 'eval', t: targetId, js: '!!(window.naklishell && window.naklishell.current)' });
      if (ready === true) break;
    }
    return await cdp({ cmd: 'eval', t: targetId, js: 'JSON.stringify(window.naklishell.current.parity())' });
  } finally {
    await cdp({ cmd: 'raw', text: JSON.stringify({ method: 'Target.closeTarget', params: { targetId } }) });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = createHostRegistry(Object.fromEntries(HOST_COMMANDS.map(row => [row[2], async () => null])));
  const problems = [];
  for (const id of ids) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(`${appsDir.replace(/\/$/, '')}/${id}/commands.json`, 'utf8')); }
    catch (e) { problems.push(`${id}: cannot read commands.json (${e.message})`); continue; }
    problems.push(...surfaceProblems(id, manifest, base));
  }
  const report = [];
  if (live) {
    for (const id of ids) {
      const raw = await liveParity(live.replace(/\/$/, ''), id);
      let r; try { r = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { r = null; }
      if (!r || typeof r.total !== 'number') { problems.push(`${id}: live parity did not run (${JSON.stringify(raw).slice(0, 200)})`); continue; }
      report.push(`${id}: ${r.covered}/${r.total} visible controls accounted for`);
      for (const m of r.missing) problems.push(`${id}: control "${m.label}" (${m.path}) has no data-command or data-parity`);
      for (const u of r.unknown) problems.push(`${id}: control "${u.label}" (${u.path}) names unpublished command ${u.command}`);
    }
  }
  if (report.length) console.log(report.join('\n'));
  if (problems.length) { console.error(problems.join('\n')); console.error(`agent surface: ${problems.length} problem(s)`); process.exit(1); }
  console.log(`agent surface: ${ids.length} apps publish ${REQUIRED.length} required commands${live ? ' and pass the live parity check' : ''}: PASS`);
}

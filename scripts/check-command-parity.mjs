#!/usr/bin/env node
// Two doors, one core (doctrine rule 6, common rail step 6): a control that changes data has a declared command, or
// says why it stays the person's. Notes and Calendar are checked control by control: every id on a button, input,
// select, textarea or form must appear in `parity` in commands.json, as a command, `view`, or `person: <reason>`.
// Mirrored apps draw their controls at run time, so they are held to a valid manifest with a handler for each command.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCatalog } from '../sys/host/catalog.mjs';
import { createHostRegistry, HOST_COMMANDS } from '../sys/host/agent.mjs';
import { parseWidgets } from '../sys/host/widgets.mjs';
import { parseAccepts } from '../sys/host/file-targets.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const base = createHostRegistry(Object.fromEntries(HOST_COMMANDS.map(row => [row[2], async () => null])));
const problems = [];

export function controlIds(html) {
  return [...html.matchAll(/<(?:button|input|select|textarea|form)\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
}

function manifestOf(id) {
  const manifest = JSON.parse(read(`apps/${id}/commands.json`));
  const out = createCatalog({ base }).declare(id, manifest.commands, () => {});
  if (!out.ok) problems.push(`${id}: ${out.error}`);
  for (const [label, parsed] of [['widgets', parseWidgets(manifest.widgets)], ['accepts', parseAccepts(manifest.accepts)]])
    if (parsed.error) problems.push(`${id}: ${label}: ${parsed.error}`);
  return manifest;
}

for (const id of ['notes', 'calendar']) {
  const manifest = manifestOf(id);
  const html = read(`apps/${id}/index.html`);
  const parity = manifest.parity || {};
  const names = new Set(manifest.commands.map(command => command.name));
  const ids = new Set(controlIds(html));
  for (const control of ids) if (!Object.hasOwn(parity, control)) problems.push(`${id}: #${control} has no parity entry`);
  for (const [control, value] of Object.entries(parity)) {
    if (!ids.has(control)) problems.push(`${id}: parity names #${control}, which is gone`);
    if (value !== 'view' && !/^person: \S/.test(value) && !names.has(value)) problems.push(`${id}: #${control} maps to unknown command ${value}`);
  }
  for (const name of names) if (!html.includes(`'${name}'`)) problems.push(`${id}: ${name} has no handler`);
}

for (const id of ['reckon', 'draft', 'kanzen', 'sheaf', 'figger']) {
  const manifest = manifestOf(id);
  const html = read(`apps/${id}/index.html`);
  for (const { name } of manifest.commands) if (!html.includes(name)) problems.push(`${id}: ${name} has no handler in the mirror`);
}

assert.deepEqual(controlIds('<button class="a" id="x">X</button><div id="y"></div><input id="z">'), ['x', 'z']);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('command parity: every Notes and Calendar control is accounted for, and all seven manifests are valid: PASS');

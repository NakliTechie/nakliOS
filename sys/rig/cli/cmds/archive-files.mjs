// Archive names remain relative to one extraction root. No member can create a
// link, traverse an existing link, or bypass the command's governed I/O boundary.
import { IOFailure, toBytes, normalizePath } from '../io.mjs';
import { utf8Length } from './u2-common.mjs';
import { resolveVirtualPath } from './path-resolution.mjs';
import { parseGlob, matchesGlob } from './find-match.mjs';

export const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function decodeName(ctx, bytes) {
  try { return decoder.decode(bytes); } catch (_) { ctx.fail('archive names must contain valid UTF-8'); }
}
export function memberName(ctx, name, directory = false) {
  ctx.budget.spend('pathBytes', utf8Length(name));
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\\\x00-\x1f\x7f]/.test(name)
    || /%(?:2e|2f|5c|00|25)/i.test(name) || name.split('/').includes('..')) ctx.fail(`unsafe archive pathname: ${JSON.stringify(name)}`);
  const clean = name.split('/').filter((part) => part && part !== '.').join('/');
  if (!clean && !directory) ctx.fail('archive file has an empty pathname');
  return clean;
}
export function selectors(ctx, patterns, { descendants = false, basename = false } = {}) {
  const compiled = patterns.map((pattern) => ({ pattern: pattern.replace(/^\.\//, '').replace(/\/$/, ''),
    tokens: parseGlob(pattern.replace(/^\.\//, '').replace(/\/$/, '')) }));
  return (name) => compiled.some(({ pattern, tokens }) => {
    const tick = () => ctx.budget.spend('steps');
    return matchesGlob(tokens, name, { tick }) || basename && matchesGlob(tokens, name.split('/').at(-1), { tick })
      || descendants && name.startsWith(pattern + '/');
  });
}
export async function archiveInput(ctx, io, path) {
  ctx.budget.check();
  if (path === '-') {
    const [source] = ctx.inputs.operands(['-']); const bytes = await (await source.open()).rest();
    return ctx.retain(bytes);
  }
  ctx.budget.spend('inputFiles');
  const resolved = await resolveVirtualPath(io, path, { context: ctx, mode: 'existing' });
  const bytes = toBytes(await io.readBytes('/' + resolved.path, { maxBytes: ctx.budget.remaining('inputBytes'), rejectSymlinks: true }));
  ctx.budget.check(); ctx.budget.spend('inputBytes', bytes.length); return ctx.retain(bytes);
}
async function stat(ctx, io, path) {
  await ctx.budget.checkpoint();
  try {
    const result = await io.stat('/' + path, { follow: false, metadataOnly: true, rejectSymlinks: true });
    ctx.budget.check(); if (result.type === 'symlink') ctx.fail(`symbolic links are unsupported: ${path}`); return result;
  } catch (error) { if (error instanceof IOFailure && error.code === 'ENOENT') return null; throw error; }
}
async function permit(ctx, authorize, operation, input) {
  ctx.budget.check();
  if (typeof authorize !== 'function') ctx.fail('destination grant preflight is unavailable');
  const result = await authorize(operation, input); ctx.budget.check();
  if (!result?.ok) throw new IOFailure(operation, result ?? { code: 'ENOTSUP', message: 'destination grant preflight is unavailable' });
}

export async function gatherEntries(ctx, io, sources, { recursive = true, exclude = [], omitPath } = {}) {
  const excluded = selectors(ctx, exclude, { basename: true, descendants: true }), entries = [];
  const stack = [...sources].reverse();
  while (stack.length) {
    await ctx.budget.checkpoint(); const source = stack.pop();
    const path = normalizePath(source.directory ?? io.resolve('.'), source.operand);
    const name = memberName(ctx, source.name ?? source.operand.replace(/^\/+/, ''), true);
    if (excluded(name) || omitPath !== undefined && path === omitPath) continue;
    const metadata = await stat(ctx, io, path);
    if (!metadata) ctx.fail(`no such source: ${source.operand}`);
    if (!['file', 'dir'].includes(metadata.type)) ctx.fail(`unsupported source type: ${path}`);
    ctx.budget.spend('files');
    const directory = metadata.type === 'dir';
    const data = directory ? new Uint8Array() : await archiveInput(ctx, io, '/' + path);
    if (!directory && !name) ctx.fail('archive file has an empty pathname');
    entries.push({ name, directory, data, mtime: metadata.mtimeMs ?? 0 });
    if (directory && recursive) {
      const children = await io.list('/' + path, { metadataOnly: true, rejectSymlinks: true }); ctx.budget.check();
      if (children.length > ctx.limits.maxFiles - entries.length) ctx.fail('archive entry count exceeds the resource limit');
      children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (child.name.includes('/') || !child.name || child.name === '.' || child.name === '..') ctx.fail('invalid directory entry');
        stack.push({ directory: path, operand: child.name, name: name ? name + '/' + child.name : child.name });
      }
    }
  }
  return entries;
}

// Preflight all selected paths and grants before mkdir/write can stage or run.
// The governed mutation rechecks rejectSymlinks at acceptance time as well.
export async function prepareExtraction(ctx, io, authorize, entries, { directory = '.', overwrite = 'yes' } = {}) {
  const root = io.resolve(directory), roots = new Set([root, ...entries.map((entry) => entry.extractionDirectory ?? root)]);
  for (const base of roots) {
    const rootStat = await stat(ctx, io, base);
    if (rootStat && rootStat.type !== 'dir') ctx.fail('extraction destination is not a directory');
  }
  const planned = new Map(), directories = new Map(), files = [];
  const addDirectory = (path) => {
    const parts = path.split('/').filter(Boolean); let prefix = '';
    for (const part of parts) {
      prefix = prefix ? prefix + '/' + part : part;
      if (planned.get(prefix) === 'file') ctx.fail(`archive path conflicts with a file: ${prefix}`);
      directories.set(prefix, true);
    }
  };
  for (const entry of entries) {
    await ctx.budget.checkpoint();
    const base = entry.extractionDirectory ?? root;
    const name = memberName(ctx, entry.name || (entry.directory ? '.' : ''), entry.directory), path = base ? base + (name ? '/' + name : '') : name;
    if (!path && !entry.directory) ctx.fail('cannot replace the filesystem root');
    const kind = entry.directory ? 'dir' : 'file';
    if (planned.has(path) && planned.get(path) !== kind || kind === 'file' && directories.has(path)) ctx.fail(`conflicting archive entries: ${name}`);
    planned.set(path, kind); addDirectory(entry.directory ? path : path.split('/').slice(0, -1).join('/'));
    if (!entry.directory) files.push({ ...entry, path });
  }
  const actions = [];
  for (const path of directories.keys()) {
    const current = await stat(ctx, io, path);
    if (current && current.type !== 'dir') ctx.fail(`destination parent is not a directory: ${path}`);
    if (!current) {
      const input = { path, createParents: false, rejectSymlinks: true };
      await permit(ctx, authorize, 'fs.mkdir', input); actions.push({ operation: 'mkdir', path });
    }
  }
  for (const entry of files) {
    const current = await stat(ctx, io, entry.path);
    if (current && current.type !== 'file') ctx.fail(`destination is not a regular file: ${entry.path}`);
    if (current && overwrite === 'no') ctx.fail(`destination exists; use -o to overwrite: ${entry.path}`);
    if (current && overwrite === 'skip') continue;
    await permit(ctx, authorize, 'fs.write', { path: entry.path, data: entry.data, createParents: false, rejectSymlinks: true,
      ...(entry.expectedData === undefined ? {} : { expectedData: entry.expectedData }) });
    actions.push({ operation: 'write', ...entry });
  }
  return actions;
}
export async function applyExtraction(ctx, io, actions) {
  for (const action of actions) {
    await ctx.budget.checkpoint();
    if (action.operation === 'mkdir') await io.mkdir('/' + action.path, { rejectSymlinks: true });
    else await io.write('/' + action.path, action.data, { rejectSymlinks: true,
      ...(action.expectedData === undefined ? {} : { expectedData: action.expectedData }) });
    ctx.budget.check();
  }
}
export async function saveArchive(ctx, io, authorize, path, data, { overwrite = true, expectedData } = {}) {
  if (path === '-') { ctx.output.append(data); return; }
  const target = io.resolve(path), parts = target.split('/'), name = parts.pop();
  if (!name) ctx.fail('cannot write an archive to the filesystem root');
  const actions = await prepareExtraction(ctx, io, authorize, [{ name, directory: false, data, ...(expectedData === undefined ? {} : { expectedData }) }],
    { directory: '/' + parts.join('/'), overwrite: overwrite ? 'yes' : 'no' });
  await applyExtraction(ctx, io, actions);
}
export async function existingArchive(ctx, io, path) { return stat(ctx, io, io.resolve(path)); }

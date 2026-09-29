// Canonical virtual paths. Every resolved component crosses governed metadata I/O.
// No host paths, backend handles, or file-content reads enter this resolver.
import { ArgError } from '../args.mjs';
import { IOFailure } from '../io.mjs';
import { utf8Length } from './u2-common.mjs';

const failure = (code, message) => { throw new IOFailure('fs.stat', { code, message }); };
const badPath = (text) => /[\\\x00-\x1f]/.test(text) || /%(2e|2f|5c|00|25)/i.test(text);

export async function resolveVirtualPath(io, input, { context: ctx, mode = 'all-but-last', logical = false,
  strip = false, followFinal = true, missingParents = false } = {}) {
  if (!ctx) throw new TypeError('path resolution requires a shared context');
  if (!['all-but-last', 'existing', 'missing'].includes(mode)) throw new TypeError('invalid path resolution mode');
  if (typeof input !== 'string' || !input.length) failure('ENOENT', 'empty pathname');
  const releases = [], maxComponents = ctx.limits.maxPathComponents ?? 1024, maxLinks = ctx.limits.maxSymlinks ?? 8;
  const chargeText = (text) => {
    const size = utf8Length(text, ctx.budget.remaining('pathBytes'));
    ctx.budget.spend('pathBytes', size);
    if (badPath(text)) failure('EINVAL_PATH', 'invalid or encoded pathname component');
    return size;
  };
  const split = async (text) => {
    chargeText(text); let components = 1;
    for (let i = 0; i < text.length; i++) {
      if ((i & 4095) === 0) await ctx.budget.checkpoint();
      if (text[i] === '/' && ++components > maxComponents) throw new ArgError(`${ctx.command}: path component limit exceeded`);
    }
    releases.push(ctx.budget.reserveRetained(text.length * 4 + components * 96));
    return text.split('/').filter((part) => part !== '');
  };
  const lexical = async (parts) => {
    const result = [];
    for (const part of parts) {
      await ctx.budget.checkpoint();
      if ((part === '.' || part === '..') && result.length && mode !== 'missing') {
        // Lexical normalization still traverses the component it removes.
        // A missing entry or regular file cannot become a directory via /..
        // Existing-mode resolution also checks canonical target grants.
        const before = await resolveVirtualPath(io, '/' + result.join('/') + '/',
          { context: ctx, mode: 'existing', followFinal: true });
        if (before.stat?.type !== 'dir') failure('ENOTDIR', 'pathname component is not a directory');
      }
      if (part === '.') continue;
      if (part === '..') { if (!result.length) failure('EINVAL_PATH', 'path escapes mount root'); result.pop(); }
      else result.push(part);
    }
    return result;
  };
  const probe = async (parts, last) => {
    // Charge before joining a potentially long sequence of path components.
    const length = parts.reduce((n, part) => n + utf8Length(part) + 1, 1);
    ctx.budget.spend('pathBytes', length);
    const release = ctx.budget.reserveRetained(length * 4 + 64);
    try {
      await ctx.budget.checkpoint();
      const stat = await io.stat('/' + parts.join('/'), { follow: false, metadataOnly: true, rejectSymlinks: true });
      ctx.budget.check(); return stat;
    } catch (error) {
      if (error instanceof IOFailure && (mode === 'missing' && ['ENOENT', 'ENOTDIR'].includes(error.code)
        || mode === 'all-but-last' && (last || missingParents) && error.code === 'ENOENT')) return null;
      throw error;
    } finally { release(); }
  };
  try {
    const cwd = input.startsWith('/') ? '' : io.resolve('.');
    // Bound the concatenation before constructing it.
    if (utf8Length(cwd) + utf8Length(input) + 2 > ctx.budget.remaining('pathBytes')) {
      throw new ArgError(`${ctx.command}: path bytes exceed the resource limit`);
    }
    let queue = await split(input.startsWith('/') ? input : '/' + cwd + '/' + input);
    const requireDirectory = mode === 'existing' && input.endsWith('/');
    if (logical || strip) queue = await lexical(queue);
    if (strip) {
      const path = queue.join('/');
      if (mode === 'missing') return { path, stat: null };
      // Existence checks still resolve governed targets, while output keeps its
      // lexical spelling. -sm is the explicitly pure-string form.
      const resolved = await resolveVirtualPath(io, '/' + path + (requireDirectory && path ? '/' : ''),
        { context: ctx, mode, followFinal: true });
      return { path, stat: resolved.stat };
    }
    let parts = [], index = 0, links = 0, stat = null, needsProbe = true, linkRequiresDirectory = false;
    while (index < queue.length) {
      await ctx.budget.checkpoint();
      const part = queue[index++];
      if (part === '.') continue;
      if (part === '..') {
        if (!parts.length) failure('EINVAL_PATH', 'path escapes mount root');
        parts.pop(); stat = null; needsProbe = true; continue;
      }
      if (parts.length >= maxComponents) throw new ArgError(`${ctx.command}: path component limit exceeded`);
      parts.push(part);
      const last = index === queue.length;
      stat = await probe(parts, last); needsProbe = false;
      if (stat?.type === 'symlink' && (!last || followFinal || requireDirectory)) {
        if (++links > maxLinks) failure('ELOOP', 'too many symlink levels');
        if (typeof stat.target !== 'string' || !stat.target.length) failure('EINVAL_PATH', 'invalid symlink target');
        const target = await split(stat.target);
        // A final target slash rejects an existing non-directory, but the
        // all-but-last policy still permits a missing final component.
        // Preserve the requirement through another final-link expansion.
        if (last && stat.target.endsWith('/')) linkRequiresDirectory = true;
        const count = target.length + queue.length - index;
        const retainedPrefix = stat.target.startsWith('/') ? 0 : parts.length - 1;
        if (retainedPrefix + count > maxComponents) throw new ArgError(`${ctx.command}: path component limit exceeded`);
        releases.push(ctx.budget.reserveRetained(count * 16));
        parts.pop(); if (stat.target.startsWith('/')) parts = [];
        queue = target.concat(queue.slice(index)); index = 0; stat = null; needsProbe = true;
        continue;
      }
      if ((!last || requireDirectory) && stat && stat.type !== 'dir' && mode !== 'missing') {
        failure('ENOTDIR', 'pathname component is not a directory');
      }
    }
    if (needsProbe) stat = await probe(parts, true);
    if (requireDirectory && stat?.type !== 'dir') failure('ENOTDIR', 'trailing slash requires a directory');
    if (linkRequiresDirectory && stat && stat.type !== 'dir' && mode !== 'missing') {
      failure('ENOTDIR', 'symbolic-link target slash requires a directory');
    }
    return { path: parts.join('/'), stat };
  } finally { for (const release of releases) release(); }
}

export function relativeVirtualPath(from, to) {
  const a = from ? from.split('/') : [], b = to ? to.split('/') : [];
  let common = 0; while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/') || '.';
}

export const withinVirtualPath = (base, path) => !base || path === base || path.startsWith(base + '/');

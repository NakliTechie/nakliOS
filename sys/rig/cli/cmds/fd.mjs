import { parseArgs } from '../args.mjs';
import { IOFailure, toBytes } from '../io.mjs';
import { createDataContext } from './data-common.mjs';
import { parseCount, utf8Length } from './u2-common.mjs';
import { resolveVirtualPath } from './path-resolution.mjs';
import { parseRegex, findRegex, parseGlob, matchesGlob } from './find-match.mjs';

const flag = (short, long, value = false, multiple = false) => ({ ...(short ? { short } : {}), ...(long ? { long } : {}), ...(value ? { value } : {}), ...(multiple ? { multiple } : {}) });
const binary = (text) => { let out = ''; for (const byte of toBytes(text)) out += String.fromCharCode(byte); return out; };
const basename = (path) => path.split('/').at(-1);
const lower = (text) => text.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
function pathPattern(ctx, raw) {
  if (utf8Length(raw) > ctx.limits.maxRegexBytes) ctx.fail('ignore pattern exceeds the byte resource limit', 2);
  const rooted = raw.startsWith('/'); if (rooted) raw = raw.slice(1);
  const directory = raw.endsWith('/'); if (directory) raw = raw.slice(0, -1);
  const segments = raw.split('/').map((part) => part === '**' ? null : parseGlob(binary(part)));
  const nameOnly = !rooted && segments.length === 1;
  return { directory, test(path, isDirectory) {
    const parts = path.split('/').map(binary);
    const match = (prefix) => {
      if (nameOnly) return matchesGlob(segments[0] ?? parseGlob('*'), prefix.at(-1), { tick: () => ctx.budget.spend('steps') });
      let positions = new Set([0]);
      for (const segment of segments) {
        const next = new Set();
        for (const start of positions) {
          ctx.budget.spend('steps');
          if (segment === null) for (let end = start; end <= prefix.length; end++) { ctx.budget.spend('steps'); next.add(end); }
          else if (start < prefix.length && matchesGlob(segment, prefix[start], { tick: () => ctx.budget.spend('steps') })) next.add(start + 1);
        }
        positions = next;
      }
      return positions.has(prefix.length);
    };
    for (let end = 1; end <= parts.length; end++) {
      if (directory && end === parts.length && !isDirectory) continue;
      if (match(parts.slice(0, end))) return true;
    }
    return false;
  } };
}
export function createFdCommand(io, { signal = () => null, limits = {} } = {}) {
  return async (argv) => {
    const ctx = createDataContext('fd', io, '', signal, limits); ctx.arguments(argv);
    const { options, operands, occurrences } = parseArgs(argv, {
      hidden: flag('H', 'hidden'), noIgnore: flag('I', 'no-ignore'), unrestricted: flag('u', 'unrestricted'),
      insensitive: flag('i', 'ignore-case'), sensitive: flag('s', 'case-sensitive'), glob: flag('g', 'glob'), literal: flag('F', 'fixed-strings'),
      full: flag('p', 'full-path'), absolute: flag('a', 'absolute-path'), zero: flag('0', 'print0'),
      type: flag('t', 'type', true, true), extension: flag('e', 'extension', true, true), exclude: flag('E', 'exclude', true, true),
      maxDepth: flag('d', 'max-depth', true), minDepth: flag(null, 'min-depth', true),
    }, { command: 'fd' });
    if (options.glob && options.literal) ctx.fail('-g and -F conflict', 2);
    const pattern = operands.shift() ?? '', roots = operands.length ? operands : ['.'];
    if (utf8Length(pattern) > ctx.limits.maxRegexBytes) ctx.fail('pattern exceeds the byte resource limit', 2);
    const hidden = options.hidden || options.unrestricted, noIgnore = options.noIgnore || options.unrestricted;
    let insensitive = !/[A-Z]/.test(pattern);
    for (const item of occurrences) if (item.key === 'insensitive') insensitive = true; else if (item.key === 'sensitive') insensitive = false;
    const minDepth = options.minDepth === undefined ? 1 : parseCount(options.minDepth, { command: 'fd', label: 'minimum depth' });
    const maxDepth = options.maxDepth === undefined ? Infinity : parseCount(options.maxDepth, { command: 'fd', label: 'maximum depth' });
    const types = new Set(options.type ?? []);
    for (const type of types) if (!['f', 'd', 'l'].includes(type)) ctx.fail(`unsupported type ${type}`, 2);
    const exclusions = (options.exclude ?? []).map((value) => pathPattern(ctx, value));
    const glob = options.glob ? parseGlob(binary(pattern)) : null, regex = !options.glob && !options.literal ? parseRegex(binary(pattern), { wholePath: false }) : null;
    const extensions = options.extension ?? [];
    const optionalStat = async (path) => {
      try { return await io.stat('/' + path, { follow: false, metadataOnly: true }); }
      catch (error) { if (error instanceof IOFailure && error.code === 'ENOENT') return null; throw error; }
    };
    const cache = new Map();
    async function directoryRules(path, repo) {
      if (noIgnore) return { repo, rules: [] };
      if (cache.has(path)) return cache.get(path);
      const marker = await optionalStat(path ? path + '/.git' : '.git');
      const inRepo = repo || marker?.type === 'dir' || marker?.type === 'file', rules = [];
      const files = [...(inRepo ? [['.gitignore', 0]] : []), ['.ignore', 1], ['.fdignore', 2]];
      if (marker?.type === 'dir') files.unshift(['.git/info/exclude', -1]);
      for (const [name, priority] of files) {
        const file = path ? path + '/' + name : name;
        const metadata = await optionalStat(file); if (!metadata) continue;
        if (metadata.type !== 'file') ctx.fail(`ignore file must be a regular file: ${file}`);
        const data = await io.readBytes('/' + file, { maxBytes: ctx.budget.remaining('inputBytes'), rejectSymlinks: true });
        ctx.budget.spend('inputBytes', data.length); ctx.budget.reserveRetained(data.length * 4);
        for (let line of ctx.decode(data).split('\n')) {
          await ctx.budget.checkpoint(); line = line.replace(/\r$/, '').replace(/(?<!\\) +$/, '');
          if (!line || line.startsWith('#')) continue;
          let negate = false;
          if (line.startsWith('!')) { negate = true; line = line.slice(1); }
          if (!line) continue;
          const match = pathPattern(ctx, line); ctx.value(); rules.push({ base: path, priority, negate, match });
        }
      }
      const result = { repo: inRepo, rules }; cache.set(path, result); return result;
    }
    function ignored(path, directory, rules) {
      let result = false;
      for (const rule of [...rules].sort((a, b) => a.priority - b.priority)) {
        const relative = rule.base ? path.slice(rule.base.length + 1) : path;
        if (rule.match.test(relative, directory)) result = !rule.negate;
      }
      return result;
    }
    function matches(path) {
      const value = binary(path), needle = binary(pattern), tick = () => ctx.budget.spend('steps');
      if (options.literal) return insensitive ? lower(value).includes(lower(needle)) : value.includes(needle);
      if (glob) return matchesGlob(glob, value, { insensitive, tick });
      for (let start = 0; start <= value.length; start++) if (findRegex(regex, value, start, { insensitive, tick })) return true;
      return false;
    }
    const results = [], seen = new Set();
    for (const operand of roots) {
      await ctx.budget.checkpoint(); ctx.budget.spend('inputFiles');
      const root = await resolveVirtualPath(io, operand, { context: ctx, mode: 'existing', followFinal: false });
      if (root.stat?.type !== 'dir') ctx.fail(`search root must be a directory: ${operand}`);
      let inherited = [], repo = false;
      const parts = root.path.split('/').filter(Boolean);
      for (let count = 0; count < parts.length; count++) {
        const data = await directoryRules(parts.slice(0, count).join('/'), repo); repo = data.repo; inherited = inherited.concat(data.rules);
      }
      const queue = [{ path: root.path, depth: 0, rules: inherited, repo }];
      while (queue.length) {
        await ctx.budget.checkpoint(); const item = queue.pop();
        const current = await directoryRules(item.path, item.repo), rules = item.rules.concat(current.rules);
        if (item.depth >= maxDepth) continue;
        if (item.depth >= ctx.limits.maxDepth) ctx.fail('traversal depth exceeds the resource limit');
        const entries = await io.list('/' + item.path, { metadataOnly: true, rejectSymlinks: true });
        for (const entry of entries) {
          await ctx.budget.checkpoint(); ctx.budget.spend('files');
          const name = basename(entry.path ?? entry.name ?? '');
          if (!name || name === '.' || name === '..' || name.includes('/')) ctx.fail('invalid directory metadata');
          const path = item.path ? item.path + '/' + name : name;
          ctx.budget.spend('pathBytes', utf8Length(path)); ctx.budget.reserveRetained(64 + path.length * 2);
          if (!hidden && name.startsWith('.')) continue;
          const metadata = await resolveVirtualPath(io, '/' + path, { context: ctx, mode: 'existing', followFinal: false });
          const type = metadata.stat?.type, directory = type === 'dir';
          if (!['file', 'dir', 'symlink'].includes(type)) ctx.fail(`unsupported metadata type: ${path}`);
          const relative = root.path ? path.slice(root.path.length + 1) : path;
          if (exclusions.some((exclude) => exclude.test(relative, directory)) || !noIgnore && ignored(path, directory, rules)) continue;
          const depth = item.depth + 1;
          if (directory && depth < maxDepth) queue.push({ path: metadata.path, depth, rules, repo: current.repo });
          if (depth < minDepth || types.size && !types.has({ file: 'f', dir: 'd', symlink: 'l' }[type])) continue;
          if (extensions.length && !extensions.some((extension) => insensitive ? lower(name).endsWith('.' + lower(extension.replace(/^\./, ''))) : name.endsWith('.' + extension.replace(/^\./, '')))) continue;
          if (!matches(options.full ? '/' + path : name)) continue;
          let display = options.absolute || operand.startsWith('/') ? '/' + path : path;
          if (!options.absolute && !operand.startsWith('/')) {
            const cwd = io.resolve('.'); if (cwd && display.startsWith(cwd + '/')) display = display.slice(cwd.length + 1);
          }
          if (directory) display += '/';
          if (!seen.has(display)) { ctx.result(); seen.add(display); results.push(display); }
        }
      }
    }
    for (const path of results.sort()) ctx.output.argument(path + (options.zero ? '\0' : '\n'));
    return ctx.finish();
  };
}

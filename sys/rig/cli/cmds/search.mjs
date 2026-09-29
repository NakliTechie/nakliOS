// Search commands share governed I/O and the fileops trigram search route.
import { parseArgs } from '../args.mjs';
import { autoData, toText } from '../io.mjs';
import { createPatch } from '../../fileops/patch.mjs';

const switches = (letters) => Object.fromEntries([...letters].map((short) => [short, { short }]));
const result = (lines, code = 0) => ({ text: lines.length ? lines.join('\n') + '\n' : '', code, raw: true });
const linesOf = (text) => text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);
const dirName = (path) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const join = (a, b) => a === '/' ? '/' + b : a.replace(/\/$/, '') + '/' + b;
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function propagateControl(error) {
  if (error?.code === 130 || error?.cancelled) throw error;
}
const errorText = (error) => error === 'ENOENT' ? 'ENOENT (no such file or directory)' : error;
function numberOption(name, value, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    const error = new Error(`${name}: invalid non-negative count: ${value}`);
    error.code = 2; throw error;
  }
  return Number(value);
}

// Shell glob characters plus bracket classes. A basename glob also selects files
// at any directory depth; patterns containing slashes select relative paths.
function globRegex(pattern) {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; source += '(?:.*/)?'; }
        else source += '.*';
      } else source += '[^/]*';
    } else if (c === '?') source += '[^/]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) { source += '\\['; continue; }
      let inner = pattern.slice(i + 1, end);
      if (inner.startsWith('!')) inner = '^' + inner.slice(1);
      source += '[' + inner + ']'; i = end;
    } else source += literal(c);
  }
  return new RegExp(source + '$');
}

const TYPES = Object.freeze({
  py: ['py'], js: ['js', 'mjs', 'cjs'], ts: ['ts', 'tsx'], jsx: ['jsx'],
  html: ['html', 'htm'], css: ['css'], json: ['json'], md: ['md', 'markdown'],
  rust: ['rs'], go: ['go'], java: ['java'], c: ['c', 'h'], cpp: ['cpp', 'cc', 'hpp'],
  sh: ['sh', 'bash', 'zsh'], yaml: ['yml', 'yaml'], toml: ['toml'], xml: ['xml'],
  sql: ['sql'], txt: ['txt'], svg: ['svg'],
});
const CONTEXT = {
  A: { short: 'A', long: 'after-context', value: true },
  B: { short: 'B', long: 'before-context', value: true },
  C: { short: 'C', long: 'context', value: true },
};
const GREP_OPTIONS = {
  ...switches('rRnlLovwicEFhHqsx'), ...CONTEXT,
  e: { short: 'e', long: 'regexp', value: true, multiple: true },
  f: { short: 'f', long: 'file', value: true, multiple: true },
  m: { short: 'm', long: 'max-count', value: true },
  include: { long: 'include', value: true, multiple: true },
  exclude: { long: 'exclude', value: true, multiple: true },
};
const RG_OPTIONS = {
  ...switches('ilncwoFv'), ...CONTEXT,
  type: { short: 't', long: 'type', value: true, multiple: true },
  glob: { short: 'g', long: 'glob', value: true, multiple: true },
  files: { long: 'files' }, help: { short: 'h', long: 'help' },
};

function matcher(patterns, options, occurrences) {
  const mode = occurrences.filter((entry) => entry.key === 'F' || entry.key === 'E').at(-1)?.key;
  const sources = patterns.map((pattern) => {
    let source = mode === 'F' ? literal(pattern) : pattern;
    if (options.w) source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`;
    if (options.x) source = `^(?:${source})$`;
    return source;
  });
  const flags = options.i ? 'i' : '';
  const regexes = sources.map((source) => new RegExp(source, flags));
  const test = (line) => regexes.some((re) => re.test(line));
  // The index sees a union for the usual case. Separate patterns with numeric
  // backreferences cannot share capture numbering, so use a broad candidate query.
  let indexSource = sources.length ? sources.map((s) => `(?:${s})`).join('|') : '(?!)';
  const broad = sources.length > 1 && sources.some((s) => /\\[1-9]/.test(s));
  if (broad) indexSource = '[\\s\\S]*';
  else if (options.v) indexSource = '^(?!(?:.*(?:' + indexSource + ')))[\\s\\S]*$';
  const parts = (line) => {
    const global = sources.map((source) => new RegExp(source, flags + 'g'));
    const found = [];
    let offset = 0;
    while (offset <= line.length) {
      let best = null;
      for (const re of global) {
        re.lastIndex = offset;
        let match = re.exec(line);
        // Empty matches select lines, but -o must print only nonempty matches.
        while (match && match[0] === '' && re.lastIndex < line.length) {
          re.lastIndex++; match = re.exec(line);
        }
        if (!match || !match[0]) continue;
        if (!best || match.index < best.index || (match.index === best.index && match[0].length > best[0].length)) best = match;
      }
      if (!best) break;
      found.push(best[0]); offset = best.index + best[0].length;
    }
    return found;
  };
  return { test, parts, source: indexSource, flags };
}

export function createSearchCommands(io) {
  async function search(name, argv, stdin = '') {
    const rg = name === 'rg';
    const parsed = parseArgs(argv, rg ? RG_OPTIONS : GREP_OPTIONS, { command: name });
    const { options: o, occurrences } = parsed;
    const operands = [...parsed.operands];
    if (o.help) return result([
      'rg PATTERN [paths...] — recursive content search over the workspace.',
      '  -i -l -n -c -w -o -F -v   -A NUM -B NUM -C NUM',
      '  -t, --type TYPE           types: ' + Object.keys(TYPES).sort().join(' '),
      '  -g, --glob GLOB           include a glob; !GLOB excludes it',
      '  --files                  list selected files without searching',
      'Any other flag is refused rather than ignored.',
    ]);
    let before = 0, after = 0;
    for (const entry of occurrences) {
      if (!['A', 'B', 'C'].includes(entry.key)) continue;
      const count = numberOption(name, entry.value, 0);
      if (entry.key !== 'A') before = count;
      if (entry.key !== 'B') after = count;
    }
    const maximum = numberOption(name, o.m, Number.MAX_SAFE_INTEGER);
    const patterns = [];
    let patternStdin = false;
    for (const entry of occurrences) {
      if (entry.key === 'e') patterns.push(...String(entry.value).split('\n'));
      if (entry.key === 'f') {
        try {
          const source = entry.value === '-' ? toText(stdin) : await io.readText(entry.value);
          patterns.push(...linesOf(source));
          if (entry.value === '-') patternStdin = true;
        } catch (error) {
          propagateControl(error);
          return result(o.s ? [] : [`${name}: ${entry.value}: ${error.code || error.message}`], 2);
        }
      }
    }
    if (!o.files && !occurrences.some((entry) => entry.key === 'e' || entry.key === 'f')) {
      if (!operands.length) return result([`${name}: missing search pattern`], 2);
      patterns.push(...operands.shift().split('\n'));
    }
    let match;
    try { match = matcher(patterns, o, occurrences); }
    catch (error) { return result([`${name}: invalid pattern: ${error.message}`], 2); }
    const recursive = rg || o.r || o.R;
    const implicit = operands.length === 0;
    const requested = operands.length ? operands : recursive ? ['.'] : ['-'];
    const cwd = io.resolve('.');
    const cwdPrefix = cwd ? cwd + '/' : '';
    const relative = (path) => path.startsWith(cwdPrefix) ? path.slice(cwdPrefix.length) : path;
    const types = o.type || [];
    for (const type of types) {
      if (!TYPES[type]) return result([`rg: unknown type ${type} — known types: ${Object.keys(TYPES).sort().join(' ')}`], 2);
    }
    const extensions = types.length ? new Set(types.flatMap((type) => TYPES[type])) : null;
    let filters;
    try {
      filters = occurrences.filter((entry) => ['include', 'exclude', 'glob'].includes(entry.key)).map((entry) => {
        const exclude = entry.key === 'exclude' || (entry.key === 'glob' && entry.value.startsWith('!'));
        const glob = entry.key === 'glob' && exclude ? entry.value.slice(1) : entry.value;
        return { exclude, regex: globRegex(glob), basename: !glob.includes('/') };
      });
    } catch (error) { return result([`${name}: invalid glob: ${error.message}`], 2); }
    const keep = (path) => {
      if (extensions && !extensions.has(path.slice(path.lastIndexOf('.') + 1))) return false;
      let selected = rg ? !filters.some((filter) => !filter.exclude) : filters[0]?.exclude !== false;
      for (const filter of filters) {
        if (filter.regex.test(filter.basename ? baseName(path) : relative(path))) selected = !filter.exclude;
      }
      return selected;
    };

    const targets = [], seen = new Set();
    const add = (target) => {
      if (rg && seen.has(target.path)) return;
      if (!keep(target.path)) return;
      seen.add(target.path); targets.push(target);
    };
    for (const raw of requested) {
      if (raw === '-') { targets.push({ path: null, label: '(standard input)', text: patternStdin ? '' : toText(stdin) }); continue; }
      const path = io.resolve(raw);
      try {
        const stat = await io.stat(raw);
        if (stat.type !== 'dir') {
          // Exact paths still use indexed search. Glob metacharacters require a
          // broader candidate query; returned rows remain bounded to this file.
          const root = recursive ? { cwd: dirName(path), glob: /[*?[]/.test(baseName(path)) ? '*' : baseName(path),
            loaded: false, rows: new Map(), direct: true } : null;
          add({ path, label: rg ? relative(path) : raw, root }); continue;
        }
        if (!recursive) { targets.push({ error: 'EISDIR', label: raw }); continue; }
        const root = { cwd: path, glob: '**', loaded: false, rows: new Map() };
        const entries = await io.list(raw, { recursive: true });
        for (const entry of entries) {
          if (entry.type === 'dir') continue;
          const suffix = path ? entry.path.slice(path.length + 1) : entry.path;
          const label = rg || implicit ? relative(entry.path) : join(raw, suffix);
          const target = { path: entry.path, label, root };
          add(target);
        }
      } catch (error) {
        propagateControl(error); targets.push({ error: error.code || error.message, label: raw });
      }
    }
    const filePrefix = occurrences.filter((entry) => entry.key === 'H' || entry.key === 'h').at(-1)?.key;
    const prefix = rg || filePrefix === 'H' || (filePrefix !== 'h' && (requested.length > 1 || targets.some((target) => target.root && !target.root.direct)));
    const output = [];
    let selectedAny = false, errored = false, contextStarted = false;
    const fail = (label, error) => {
      errored = true;
      if (!o.s) output.push(`${name}: ${label}: ${rg ? errorText(error) : error}`);
    };
    const loadRoot = async (root) => {
      if (root.loaded) return;
      root.loaded = true;
      try {
        const found = await io.invoke('fs.grep', {
          pattern: match.source, flags: match.flags, cwd: root.cwd,
          glob: root.glob, maxResults: Number.MAX_SAFE_INTEGER,
        });
        if (found.truncated) { root.error = 'search result truncated'; return; }
        root.errors = new Map((found.errors || []).map((error) => [error.path, error.code || error.message]));
        for (const row of found.matches) {
          if (!root.rows.has(row.path)) root.rows.set(row.path, []);
          root.rows.get(row.path).push(row);
        }
      } catch (error) {
        propagateControl(error);
        // A file-specific grant can allow the file while refusing its parent.
        // The direct read still passes the same face's file-specific grant check.
        if (root.direct && error.code === 'EGRANT') root.fallback = true;
        else root.error = error.code || error.message;
      }
    };
    for (const target of targets) {
      if (target.error) { fail(target.label, target.error); continue; }
      if (o.files) { output.push(target.label); selectedAny = true; continue; }
      if (maximum === 0) {
        if (o.L && !o.q) output.push(target.label);
        else if (o.c && !o.q && !o.l) output.push((prefix ? target.label + ':' : '') + '0');
        continue;
      }
      let text = target.text, lines = null, rows = [];
      try {
        if (target.root) await loadRoot(target.root);
        if (target.root && !target.root.fallback) {
          if (target.root.error) {
            if (!target.root.reported) fail(target.label, target.root.error);
            target.root.reported = true; continue;
          }
          if (target.root.errors?.has(target.path)) { fail(target.label, target.root.errors.get(target.path)); continue; }
          rows = (target.root.rows.get(target.path) || []).filter((row) => match.test(row.text) !== !!o.v);
          // fileops' historical scan includes the empty cell after a final LF.
          // Only empty-line hits need a read to distinguish it from a real line.
          if (before || after || rows.some((row) => row.text === '')) {
            text = await io.readText('/' + target.path); lines = linesOf(text);
            rows = rows.filter((row) => row.line <= lines.length);
          }
        } else {
          if (text === undefined) text = await io.readText('/' + target.path);
          if (text.includes('\0')) {
            // Recursive fileops deliberately skips NUL binaries; keep rg consistent.
            if (rg) continue;
            const count = Math.min(maximum, linesOf(text).filter((line) => match.test(line) !== !!o.v).length);
            const any = count > 0;
            selectedAny ||= any;
            if (o.q && any) return result(output, 0);
            if (o.q) continue;
            if (o.l || o.L) {
              const fileMode = occurrences.filter((entry) => entry.key === 'l' || entry.key === 'L').at(-1)?.key;
              if (fileMode === 'L' ? !any : any) output.push(target.label);
            } else if (o.c) output.push((prefix ? target.label + ':' : '') + count);
            else if (any) output.push(`Binary file ${target.label} matches`);
            continue;
          }
          lines = linesOf(text);
          rows = lines.flatMap((line, index) => match.test(line) !== !!o.v ? [{ line: index + 1, text: line }] : []);
        }
      } catch (error) { propagateControl(error); fail(target.label, error.code || error.message); continue; }
      rows = rows.slice(0, maximum);
      const selected = rows.length > 0;
      selectedAny ||= selected;
      if (o.q && selected) return result(output, 0);
      if (o.q) continue;
      if (o.l || o.L) {
        const fileMode = occurrences.filter((entry) => entry.key === 'l' || entry.key === 'L').at(-1)?.key;
        if (fileMode === 'L' ? !selected : selected) output.push(target.label);
        continue;
      }
      if (o.c) {
        // Retain rg's existing omission of files without matching lines.
        if (!rg || selected) output.push((prefix ? target.label + ':' : '') + rows.length);
        continue;
      }
      const format = (line, value, selectedLine = true) => {
        const delimiter = selectedLine ? ':' : '-';
        return (prefix ? target.label + delimiter : '') + (rg || o.n ? line + delimiter : '') + value;
      };
      if (o.o) {
        if (!o.v) for (const row of rows) for (const part of match.parts(row.text)) output.push(format(row.line, part));
      } else if ((before || after) && selected) {
        // Indexed targets loaded their lines when context was requested. Direct
        // targets already carry their input, including standard input.
        const chosen = new Set(rows.map((row) => row.line));
        const intervals = [];
        for (const row of rows) {
          const start = Math.max(1, row.line - before), end = Math.min(lines.length, row.line + after);
          const last = intervals.at(-1);
          if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
          else intervals.push([start, end]);
        }
        for (const [start, end] of intervals) {
          if (contextStarted) output.push('--');
          contextStarted = true;
          for (let line = start; line <= end; line++) output.push(format(line, lines[line - 1], chosen.has(line)));
        }
      } else for (const row of rows) output.push(format(row.line, row.text));
    }
    if (rg) {
      try {
        await io.invoke('fs.recordSearch', { via: 'shell.rg', pattern: patterns.join('\n'), cwd,
          glob: '**', filesWalked: 0, filesRead: 0, bytesRead: 0, matches: output.length, truncated: false, ms: 0 });
      } catch (error) { propagateControl(error); }
    }
    return result(output, errored ? 2 : selectedAny ? 0 : 1);
  }

  async function diff(argv) {
    const { options: o, operands } = parseArgs(argv, {
      u: { short: 'u', long: 'unified' }, q: { short: 'q', long: 'brief' },
      r: { short: 'r', long: 'recursive' }, N: { short: 'N', long: 'new-file' },
      w: { short: 'w', long: 'ignore-all-space' }, b: { short: 'b', long: 'ignore-space-change' },
      i: { short: 'i', long: 'ignore-case' },
    }, { command: 'diff' });
    if (operands.length !== 2) return result([`usage: diff [-u|-q] [-rNwbi] <a> <b>${operands.length > 2 ? ` — extra operand '${operands[2]}'` : ''}`], 2);
    const output = [];
    let code = 0;
    const stat = async (path) => {
      try { return await io.stat(path); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const normalize = (text) => {
      let value = text;
      if (o.w) value = value.replace(/[^\S\n]+/g, '');
      else if (o.b) value = value.split('\n').map((line) => line.replace(/[^\S\n]+/g, ' ').replace(/ +$/, '')).join('\n');
      if (o.i) value = value.toLowerCase();
      return value;
    };
    const printablePatch = (a, b, from, to) => {
      const patch = createPatch(normalize(a), normalize(b), { from, to });
      if (!patch || !(o.w || o.b || o.i)) return patch;
      const A = linesOf(a), B = linesOf(b);
      let ai = 0, bi = 0, inHunk = false;
      return patch.split('\n').map((line) => {
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (header) {
          ai = Math.max(0, Number(header[1]) - (header[2] === '0' ? 0 : 1));
          bi = Math.max(0, Number(header[3]) - (header[4] === '0' ? 0 : 1));
          inHunk = true; return line;
        }
        if (!inHunk) return line;
        if (line[0] === '-') return '-' + A[ai++];
        if (line[0] === '+') return '+' + B[bi++];
        if (line[0] === ' ') { bi++; return ' ' + A[ai++]; }
        return line;
      }).join('\n');
    };
    const compare = async (left, right, ls, rs, inside = false) => {
      try {
        if (!ls && !rs) {
          if (!o.N) throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
          return;
        }
        if ((!ls || !rs) && !o.N) {
          const existing = ls ? left : right;
          if (!inside) { output.push(`diff: ${ls ? right : left}: ENOENT`); code = 2; return; }
          output.push(`Only in ${existing.slice(0, existing.lastIndexOf('/')) || '.'}: ${baseName(existing)}`);
          code = Math.max(code, 1); return;
        }
        if (ls?.type === 'dir' || rs?.type === 'dir') {
          if (ls && rs && ls.type !== rs.type) {
            output.push(`File ${left} is a ${ls.type} while file ${right} is a ${rs.type}`); code = Math.max(code, 1); return;
          }
          if (inside && !o.r) {
            if (ls && rs) output.push(`Common subdirectories: ${left} and ${right}`);
            else {
              const existing = ls ? left : right;
              output.push(`Only in ${dirName(existing) || '.'}: ${baseName(existing)}`); code = Math.max(code, 1);
            }
            return;
          }
          const L = ls ? await io.list(left) : [], R = rs ? await io.list(right) : [];
          const names = [...new Set([...L, ...R].map((entry) => entry.name))].sort();
          for (const name of names) {
            const a = L.find((entry) => entry.name === name), b = R.find((entry) => entry.name === name);
            await compare(join(left, name), join(right, name), a ? { type: a.type } : null, b ? { type: b.type } : null, true);
          }
          return;
        }
        const a = ls ? await io.readBytes(left) : new Uint8Array(), b = rs ? await io.readBytes(right) : new Uint8Array();
        if (a.length === b.length && a.every((value, index) => value === b[index])) return;
        const A = autoData(a), B = autoData(b);
        const binary = A instanceof Uint8Array || B instanceof Uint8Array;
        const patch = binary ? null : printablePatch(A, B, left, right);
        if (!binary && !patch) return;
        code = Math.max(code, 1);
        if (o.q || binary) { output.push(`${binary && !o.q ? 'Binary files' : 'Files'} ${left} and ${right} differ`); return; }
        if (inside) output.push(`diff${o.r ? ' -r' : ''}${o.u ? ' -u' : ''} ${left} ${right}`);
        if (o.u) output.push(patch.replace(/\n$/, ''));
        else output.push(...patch.split('\n').slice(2).filter((line) => line[0] === '-' || line[0] === '+').map((line) => line[0] + ' ' + line.slice(1)));
      } catch (error) { propagateControl(error); output.push(`diff: ${left} / ${right}: ${error.code || error.message}`); code = 2; }
    };
    let [left, right] = operands;
    try {
      let ls = await stat(left), rs = await stat(right);
      if (ls?.type === 'dir' && rs && rs.type !== 'dir') { left = join(left, baseName(right)); ls = await stat(left); }
      else if (rs?.type === 'dir' && ls && ls.type !== 'dir') { right = join(right, baseName(left)); rs = await stat(right); }
      await compare(left, right, ls, rs);
    } catch (error) { propagateControl(error); output.push(`diff: ${error.code || error.message}`); code = 2; }
    return result(output, code);
  }

  return {
    grep: (argv, stdin) => search('grep', argv, stdin),
    rg: (argv, stdin) => search('rg', argv, stdin),
    diff,
  };
}

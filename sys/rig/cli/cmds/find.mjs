// Find keeps displayed pathname spelling separate from normalized virtual I/O
// paths. Every metadata request, traversal, removal, and execution is governed.
import { ArgError } from '../args.mjs';
import { IOFailure, autoData, concatData, toBytes } from '../io.mjs';
import { ShellInterrupted } from '../execution.mjs';
import { parseRegex, findRegex, parseGlob, matchesGlob } from './find-match.mjs';

const fail = (message) => { throw new ArgError(`find: ${message}`); };
const utf8Length = (text, ceiling = Infinity) => {
  if (text.length > ceiling) return ceiling + 1;
  let size = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code < 128) size++;
    else if (code < 2048) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(at + 1) >= 0xdc00 && text.charCodeAt(at + 1) <= 0xdfff) { size += 4; at++; }
    else size += 3;
    if (size > ceiling) return size;
  }
  return size;
};
const binary = (text) => {
  const raw = toBytes(text), chunks = [];
  for (let at = 0; at < raw.length; at += 8192) chunks.push(String.fromCharCode(...raw.subarray(at, at + 8192)));
  return chunks.join('');
};
const basename = (path) => path.replace(/\/+$/, '').split('/').at(-1) || '/';
const absolute = (io, path) => '/' + io.resolve(path);
const childDisplay = (parent, name) => parent.endsWith('/') ? parent + name : parent + '/' + name;
class FindMetadataError extends Error {
  constructor(message) { super(message); this.code = 'ENODATA'; }
}
class FindCommandStop extends Error {
  constructor(result) { super('nested command stopped'); this.result = result; }
}

function parseFind(argv, cap) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) fail('arguments must be strings');
  if (argv.length > cap.maxTokens) fail(`expression exceeds the ${cap.maxTokens}-token limit`);
  let argumentBytes = 0;
  for (const arg of argv) {
    argumentBytes += utf8Length(arg, cap.maxArgumentBytes - argumentBytes) + 1;
    if (argumentBytes > cap.maxArgumentBytes) fail(`arguments exceed the ${cap.maxArgumentBytes}-byte limit`);
    if (arg.includes('\0')) fail('argument contains a NUL byte');
  }
  let at = argv[0] === '--' ? 1 : 0, nesting = 0, minDepth = 0, maxDepth = Infinity;
  let deletes = false, prunes = false, hasAction = false, hasPrint0 = false;
  const paths = [], executions = [], references = [];
  const depths = new WeakMap();
  const node = (kind, properties = {}) => {
    const result = { kind, ...properties };
    const depth = 1 + Math.max(0, ...Object.values(properties).filter((v) => v && typeof v === 'object').map((v) => depths.get(v) || 0));
    if (depth > cap.maxExpressionDepth) fail(`expression exceeds the ${cap.maxExpressionDepth}-level limit`);
    depths.set(result, depth); return result;
  };
  const isExpression = (arg) => arg.startsWith('-') || ['!', '(', ')'].includes(arg);
  while (at < argv.length && !isExpression(argv[at])) {
    const path = argv[at++]; if (!path) fail('starting path must not be empty'); paths.push(path);
  }
  const need = (name) => { if (at >= argv.length) fail(`${name} requires an argument`); return argv[at++]; };
  const unsigned = (text, name) => {
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) fail(`${name}: expected a non-negative integer, got ${text}`);
    return Number(text);
  };
  const numeric = (text, name, sizes = false) => {
    const match = (sizes ? /^([+-]?)(\d+)([cbwkMG]?)$/ : /^([+-]?)(\d+)$/).exec(text);
    if (!match) fail(`${name}: invalid numeric test ${text}`);
    const value = unsigned(match[2], name), suffix = match[3] || '';
    const unit = sizes ? ({ '': 512, b: 512, c: 1, w: 2, k: 1024, M: 1048576, G: 1073741824 })[suffix] : 1;
    return { relation: match[1] || '=', value, unit };
  };
  const pattern = (text, regex = false) => {
    if (utf8Length(text, cap.maxPatternBytes) > cap.maxPatternBytes) fail(`pattern exceeds the ${cap.maxPatternBytes}-byte limit`);
    return regex ? parseRegex(binary(text)) : parseGlob(binary(text));
  };
  function primary() {
    if (++nesting > cap.maxExpressionDepth) fail(`expression exceeds the ${cap.maxExpressionDepth}-level limit`);
    try {
      const token = need('expression');
      if (token === '!') return node('not', { argument: primary() });
      if (token === '(') {
        if (argv[at] === ')') fail('empty parenthesized expression');
        const value = or();
        if (argv[at++] !== ')') fail('unmatched opening parenthesis');
        return value;
      }
      if (token === ')') fail('unmatched closing parenthesis');
      if (token === '-a' || token === '-o') fail(`${token} lacks a left operand`);
      if (['-name', '-iname', '-path', '-regex'].includes(token)) return node(token.slice(1), { pattern: pattern(need(token), token === '-regex') });
      if (token === '-type') {
        const type = need(token); if (!['f', 'd', 'l'].includes(type)) fail(`-type ${type}: supported backend types are f, d, and l`);
        return node('type', { type });
      }
      if (token === '-mindepth' || token === '-maxdepth') {
        const value = unsigned(need(token), token);
        if (token === '-mindepth') minDepth = value; else maxDepth = value;
        return node('true');
      }
      if (['-size', '-mtime', '-mmin'].includes(token)) return node(token.slice(1), numeric(need(token), token, token === '-size'));
      if (token === '-newer') {
        const result = node('newer', { reference: need(token), time: null }); references.push(result); return result;
      }
      if (token === '-empty') return node('empty');
      if (token === '-prune') { prunes = true; return node('prune'); }
      if (token === '-delete') { deletes = hasAction = true; return node('delete'); }
      if (token === '-print' || token === '-print0') {
        hasAction = true; if (token === '-print0') hasPrint0 = true; return node(token.slice(1));
      }
      if (token === '-exec' || token === '-execdir') {
        const template = []; let terminator = null;
        while (at < argv.length) {
          const word = argv[at++];
          if (word === ';' || word === '+' && template.at(-1) === '{}') { terminator = word; break; }
          template.push(word);
        }
        if (!terminator) fail(`${token}: missing ; or {} + terminator`);
        if (!template.length || !template[0]) fail(`${token}: missing command`);
        if (template.length > cap.maxExecArgs) fail(`execution exceeds the ${cap.maxExecArgs}-argument limit`);
        let size = 0, replacements = 0;
        for (const word of template) {
          size += utf8Length(word) + 1;
          for (let offset = word.indexOf('{}'); offset >= 0; offset = word.indexOf('{}', offset + 2)) replacements++;
        }
        if (size > cap.maxExecBytes) fail(`execution arguments exceed the ${cap.maxExecBytes}-byte limit`);
        if (terminator === '+' && (template.length < 2 || template.at(-1) !== '{}' || replacements !== 1)) fail(`${token}: + requires exactly one standalone {} immediately before +`);
        const result = node('exec', { directory: token === '-execdir', template, terminator,
          baseBytes: terminator === '+' ? size - 3 : size, batch: null });
        executions.push(result); hasAction = true; return result;
      }
      if (!token.startsWith('-')) fail(`paths must precede the expression: ${token}`);
      fail(`unsupported predicate ${token}`);
    } finally { nesting--; }
  }
  function and() {
    let result = primary();
    while (at < argv.length && argv[at] !== ')' && argv[at] !== '-o') {
      if (argv[at] === '-a') at++;
      result = node('and', { left: result, right: primary() });
    }
    return result;
  }
  function or() {
    let result = and();
    while (argv[at] === '-o') { at++; result = node('or', { left: result, right: and() }); }
    return result;
  }
  let expression = at < argv.length ? or() : node('true');
  if (at !== argv.length) fail(`unexpected expression token ${argv[at]}`);
  if (deletes && prunes) fail('-delete implies postorder traversal and cannot be combined with -prune');
  if (!hasAction) expression = node('and', { left: expression, right: node('print') });
  return { paths: paths.length ? paths : ['.'], expression, minDepth, maxDepth, deletes, executions, references, hasPrint0 };
}

export function createFindCommands(io, { signal = () => null, runAt, limits = {}, now = () => Date.now() } = {}) {
  return {
    async find(argv) {
      const cap = { maxEntries: 100000, maxDepth: 1024, maxSteps: 1000000, maxOutputBytes: 16777216,
        maxRetainedBytes: 16777216, maxPatternBytes: 16384, maxExecBytes: 65536, maxExecArgs: 4096,
        maxExecutions: 10000, maxTokens: 10000, maxExpressionDepth: 128, maxArgumentBytes: 262144, ...limits };
      for (const [name, value] of Object.entries(cap)) if (!Number.isSafeInteger(value) || value < 1) fail(`invalid ${name} limit`);
      const program = parseFind(argv, cap);
      if (program.executions.length && typeof runAt !== 'function') fail('nested execution requires the shell cwd-restoration hook');
      const started = now(); if (!Number.isFinite(started)) fail('clock returned an invalid timestamp');
      const invocationDirectory = absolute(io, '.');
      let steps = 0, yieldedAt = 0, visited = 0, outputBytes = 0, retainedBytes = 0, invocations = 0;
      let code = 0, printed = 0, plainListing = !program.hasPrint0 && !program.executions.length;
      const output = [];
      const check = () => { if (signal()?.aborted) throw new ShellInterrupted(); };
      const tick = () => { check(); if (++steps > cap.maxSteps) fail(`execution exceeds the ${cap.maxSteps}-step limit`); };
      const checkpoint = async () => {
        tick();
        if (steps - yieldedAt >= 256) { yieldedAt = steps; await new Promise((resolve) => setTimeout(resolve, 0)); check(); }
      };
      const retain = (count) => { if (retainedBytes + count > cap.maxRetainedBytes) fail(`retained paths exceed the ${cap.maxRetainedBytes}-byte limit`); retainedBytes += count; };
      const release = (count) => { retainedBytes -= count; };
      const append = (data) => {
        if (data == null || data === '') return;
        const size = typeof data === 'string' ? utf8Length(data, cap.maxOutputBytes - outputBytes) : toBytes(data).byteLength;
        if (outputBytes + size > cap.maxOutputBytes) fail(`output exceeds the ${cap.maxOutputBytes}-byte limit`);
        outputBytes += size; output.push(data);
      };
      const diagnostic = (path, error) => {
        code = Math.max(code, 1); plainListing = false;
        append(`find: '${path}': ${error.code || 'EIO'}: ${error.message}\n`);
      };
      const timeOf = (stat) => {
        if (!Number.isFinite(stat.mtimeMs) || stat.mtimeMs === 0) throw new FindMetadataError('modification time metadata is unavailable');
        return stat.mtimeMs;
      };
      const sizeOf = (stat) => {
        if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new FindMetadataError('file size metadata is unavailable');
        return stat.size;
      };
      const compare = (actual, predicate) => predicate.relation === '+' ? actual > predicate.value : predicate.relation === '-' ? actual < predicate.value : actual === predicate.value;
      const invoke = async (directory, args) => {
        await checkpoint();
        if (++invocations > cap.maxExecutions) fail(`execution exceeds the ${cap.maxExecutions}-invocation limit`);
        const result = await runAt(directory, args, ''); check();
        // raw owns exact stdout framing. Legacy non-raw results omit their
        // display newline, so use the same framing as shell.runPipeline.
        if (result.text != null && result.text !== '') append(result.raw || typeof result.text !== 'string' ? result.text : result.text.replace(/\n?$/, '\n'));
        if (result.cancelled || result.interrupted) throw new FindCommandStop(result);
        return result.code === 0;
      };
      const flush = async (action) => {
        const batch = action.batch; if (!batch) return;
        action.batch = null;
        try { if (!(await invoke(batch.directory, [...action.template.slice(0, -1), ...batch.paths]))) code = Math.max(code, 1); }
        finally { release(batch.retained); }
      };
      const execute = async (action, item) => {
        const directory = action.directory ? item.execDirectory : invocationDirectory;
        const path = action.directory ? item.execPath : item.display;
        const pathBytes = utf8Length(path), directoryBytes = utf8Length(directory);
        if (action.terminator === '+') {
          if (action.baseBytes + pathBytes + 1 > cap.maxExecBytes) fail(`one execution argument exceeds the ${cap.maxExecBytes}-byte limit`);
          if (action.template.length > cap.maxExecArgs) fail(`execution exceeds the ${cap.maxExecArgs}-argument limit`);
          if (action.batch && (action.batch.directory !== directory || action.batch.paths.length + action.template.length > cap.maxExecArgs
            || action.batch.bytes + pathBytes + 1 > cap.maxExecBytes)) await flush(action);
          if (!action.batch) { retain(directoryBytes); action.batch = { directory, paths: [], bytes: action.baseBytes, retained: directoryBytes }; }
          retain(pathBytes + 1); action.batch.paths.push(path); action.batch.bytes += pathBytes + 1; action.batch.retained += pathBytes + 1;
          return true;
        }
        let bytes = 0;
        for (const word of action.template) {
          let count = 0;
          for (let at = word.indexOf('{}'); at >= 0; at = word.indexOf('{}', at + 2)) { tick(); count++; }
          bytes += utf8Length(word) + count * (pathBytes - 2) + 1;
          if (bytes > cap.maxExecBytes) fail(`execution arguments exceed the ${cap.maxExecBytes}-byte limit`);
        }
        return invoke(directory, action.template.map((word) => word.split('{}').join(path)));
      };
      const loadChildren = async (item) => {
        if (item.children) return item.children;
        check(); const entries = await io.list(item.absolute, { recursive: false, metadataOnly: true }); check();
        if (!Array.isArray(entries)) throw new FindMetadataError('directory listing is invalid');
        if (entries.length > cap.maxEntries) fail(`directory listing exceeds the ${cap.maxEntries}-entry limit`);
        let size = 0;
        for (const entry of entries) {
          tick();
          if (typeof entry.name !== 'string' || !entry.name || entry.name === '.' || entry.name === '..' || /[\0/]/.test(entry.name)
            || typeof entry.path !== 'string' || entry.path.includes('\0')) throw new FindMetadataError('directory listing contains an invalid child path');
          size += utf8Length(entry.path, cap.maxRetainedBytes - size) + utf8Length(entry.name, cap.maxRetainedBytes - size) + 2;
          if (size > cap.maxRetainedBytes) fail(`directory listing exceeds the ${cap.maxRetainedBytes}-byte limit`);
        }
        retain(size); item.children = entries; item.childrenBytes = size; return entries;
      };
      const dropChildren = (item) => { if (item.children) { release(item.childrenBytes); item.children = null; item.childrenBytes = 0; } };
      const evaluate = async (node, item) => {
        await checkpoint();
        switch (node.kind) {
          case 'and': return await evaluate(node.left, item) && await evaluate(node.right, item);
          case 'or': return await evaluate(node.left, item) || await evaluate(node.right, item);
          case 'not': return !(await evaluate(node.argument, item));
          case 'true': return true;
          case 'name': case 'iname': return matchesGlob(node.pattern, binary(item.name), { insensitive: node.kind === 'iname', tick });
          case 'path': return matchesGlob(node.pattern, binary(item.display), { tick });
          case 'regex': return !!findRegex(node.pattern, binary(item.display), 0, { tick });
          case 'type': return item.stat.type === ({ f: 'file', d: 'dir', l: 'symlink' })[node.type];
          case 'size': {
            const size = sizeOf(item.stat), quantity = Math.floor(size / node.unit) + (size % node.unit ? 1 : 0);
            return compare(quantity, node);
          }
          case 'mtime': case 'mmin': return compare(Math.floor((started - timeOf(item.stat)) / (node.kind === 'mtime' ? 86400000 : 60000)), node);
          case 'newer': return timeOf(item.stat) > node.time;
          case 'empty': return item.stat.type === 'file' ? sizeOf(item.stat) === 0 : item.stat.type === 'dir' ? (await loadChildren(item)).length === 0 : false;
          case 'prune': item.pruned = true; return true;
          case 'print': case 'print0':
            append(item.display + (node.kind === 'print0' ? '\0' : '\n')); printed++;
            if (/[\r\n]/.test(item.display) || item.display.endsWith(':')) plainListing = false;
            return true;
          case 'delete':
            try { check(); await io.remove(item.absolute, { recursive: false, follow: false, metadataOnly: true }); check(); return true; }
            catch (error) { if (!(error instanceof IOFailure)) throw error; diagnostic(item.display, error); return false; }
          case 'exec': return execute(node, item);
          default: fail(`unsupported expression ${node.kind}`);
        }
      };
      const action = async (item) => {
        if (item.depth < program.minDepth) return;
        try { await evaluate(program.expression, item); }
        catch (error) {
          if (!(error instanceof IOFailure) && !(error instanceof FindMetadataError)) throw error;
          diagnostic(item.display, error);
        }
      };
      const stack = [];
      const push = (path, display, depth, parent = null, childName = null) => {
        if (depth > cap.maxDepth) fail(`traversal exceeds the ${cap.maxDepth}-level limit`);
        // Root execdir arguments preserve lexical dot components. Descendants
        // execute in the directory that supplied their listing.
        const lexical = display.replace(/\/+$/, ''), slash = lexical.lastIndexOf('/');
        const execDirectory = parent ?? (lexical ? absolute(io, slash < 0 ? '.' : lexical.slice(0, slash) || '/') : '/');
        const execPath = parent != null ? './' + childName : lexical ? './' + lexical.slice(slash + 1) : '.';
        const size = utf8Length(path) + utf8Length(display) + utf8Length(execDirectory) + utf8Length(execPath);
        retain(size); stack.push({ absolute: path, display, depth, name: basename(display), execDirectory, execPath, retained: size, stage: 0,
          stat: null, children: null, childrenBytes: 0, child: 0, pruned: false, failedListing: false });
      };
      const pop = () => { const item = stack.pop(); dropChildren(item); release(item.retained); };
      try {
        for (const reference of program.references) {
          check();
          try { reference.time = timeOf(await io.stat(reference.reference, { follow: false, metadataOnly: true })); check(); }
          catch (error) {
            if (!(error instanceof IOFailure) && !(error instanceof FindMetadataError)) throw error;
            diagnostic(reference.reference, error);
            return { text: autoData(concatData(output)), code: 1, raw: true };
          }
        }
        for (const path of program.paths) {
          push(absolute(io, path), path, 0);
          while (stack.length) {
            await checkpoint(); const item = stack.at(-1);
            if (item.stage === 0) {
              if (++visited > cap.maxEntries) fail(`traversal exceeds the ${cap.maxEntries}-entry limit`);
              try {
                check(); item.stat = await io.stat(item.absolute, { follow: false, metadataOnly: true }); check();
                if (item.depth === 0 && item.display.endsWith('/') && item.stat.type !== 'dir') {
                  throw new IOFailure('fs.stat', item.stat.type === 'symlink'
                    ? { code: 'ENOTSUP', message: 'trailing-slash symlink dereferencing is unsupported' }
                    : { code: 'ENOTDIR', message: 'a trailing slash requires a directory' });
                }
              }
              catch (error) { if (!(error instanceof IOFailure)) throw error; diagnostic(item.display, error); pop(); continue; }
              if (!program.deletes) await action(item);
              item.stage = 1;
              if (item.stat.type !== 'dir' || item.pruned || item.depth >= program.maxDepth) dropChildren(item);
              if (item.stat.type === 'dir' && !item.pruned && item.depth < program.maxDepth) {
                try { await loadChildren(item); }
                catch (error) {
                  if (!(error instanceof IOFailure) && !(error instanceof FindMetadataError)) throw error;
                  diagnostic(item.display, error); item.failedListing = true;
                }
              }
            }
            if (item.stage === 1 && item.children && item.child < item.children.length) {
              const child = item.children[item.child++];
              push(absolute(io, '/' + child.path), childDisplay(item.display, child.name), item.depth + 1, item.absolute, child.name); continue;
            }
            dropChildren(item); item.stage = 2;
            if (program.deletes && !item.failedListing) await action(item);
            pop();
          }
        }
        for (const execution of program.executions) await flush(execution);
      } catch (error) {
        if (error instanceof ShellInterrupted) throw error;
        if (error instanceof FindCommandStop) return { ...error.result, text: autoData(concatData(output)), raw: true };
        if (error instanceof ArgError) { code = 2; plainListing = false;
          // A full output buffer still needs a visible diagnostic. Keep its
          // already-bounded payload and provide separate terminal text.
          const diagnostic = error.message + '\n';
          if (outputBytes + utf8Length(diagnostic) <= cap.maxOutputBytes) append(diagnostic);
          else return { text: autoData(concatData(output)), displayText: error.message, code, raw: true };
        } else if (error instanceof IOFailure || error instanceof FindMetadataError) diagnostic('', error);
        else throw error;
      }
      return { text: autoData(concatData(output)), code, raw: true,
        ...(plainListing ? { listing: { tool: 'find', entries: printed } } : {}) };
    },
  };
}

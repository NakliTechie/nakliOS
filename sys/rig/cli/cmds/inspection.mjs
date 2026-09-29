// Governed inspection of virtual files. Sizes are apparent bytes; no host
// allocation, permission, identity, or device metadata is synthesized.
import { ArgError, parseArgs } from '../args.mjs';
import { IOFailure } from '../io.mjs';
import { createU2Context, utf8Length, parseCount } from './u2-common.mjs';
import { resolveVirtualPath } from './path-resolution.mjs';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const flag = (short, long, value = false) => ({ ...(short ? { short } : {}), ...(long ? { long } : {}), ...(value ? { value } : {}) });
const fail = (ctx, text) => { throw new ArgError(`${ctx.command}: ${text}`); };
const count = (ctx, text, label, min = 0, max = Number.MAX_SAFE_INTEGER) => parseCount(String(text), { command: ctx.command, label, min, max });
const metaError = (message, code = 'ENODATA') => new IOFailure('inspection.metadata', { code, message });
const appendPath = (base, name) => base.endsWith('/') ? base + name : base + '/' + name;
const outcome = (ctx, code = ctx.code) => ({ text: ctx.output.finish(), stdout: ctx.output.finish(), stderr: ctx.diagnostics.finish(), code, raw: true });

function invocation(command, io, signal, limits, argv, stdin) {
  let ctx;
  const contentIO = { ...io, readBytes: async (path, options) => {
    const resolved = await resolveVirtualPath(io, path, { context: ctx, mode: 'existing', followFinal: true });
    return io.readBytes('/' + resolved.path, { ...options, rejectSymlinks: true });
  } };
  ctx = createU2Context({ command, io: contentIO, signal, limits: { maxEntries: 100000, maxDepth: 1024, ...limits }, stdin });
  ctx.io = io; ctx.diagnostics = ctx.output.fork(); ctx.code = 0; ctx.entries = 0; ctx.canonicalPaths = new WeakMap();
  for (const arg of argv) ctx.budget.spend('argumentBytes', utf8Length(arg) + 1);
  return ctx;
}
function ordinaryError(ctx, path, error, code = 1, silent = false) {
  if (!(error instanceof IOFailure)) throw error;
  ctx.code = Math.max(ctx.code, code);
  if (!silent) ctx.diagnostics.argument(`${ctx.command}: ${path}: ${error.code}: ${error.message}\n`);
}
function paths(ctx, operands, fallback = ['.']) {
  const values = operands.length ? operands : fallback;
  ctx.budget.spend('inputFiles', values.length); ctx.budget.reserveRetained(values.length * 64);
  for (const path of values) {
    if (!path) fail(ctx, 'empty pathname');
    ctx.budget.spend('pathBytes', utf8Length(path));
  }
  return values;
}
function sizeOf(stat) {
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw metaError('apparent byte size is unavailable');
  return BigInt(stat.size);
}
async function metadata(ctx, path, follow = false) {
  await ctx.budget.checkpoint();
  // Inspect a final trailing-slash link before the resolver applies directory
  // dereferencing. The traversal commands deliberately do not follow it.
  const spelling = !follow && path.endsWith('/') ? path.replace(/\/+$/, '') || '/' : path;
  const resolved = await resolveVirtualPath(ctx.io, spelling, { context: ctx, mode: 'existing', followFinal: follow });
  const stat = resolved.stat; ctx.budget.check();
  if (!stat || !['file', 'dir', 'symlink'].includes(stat.type)) throw metaError('unsupported or unavailable file type', 'ENOTSUP');
  if (path.length > 1 && path.endsWith('/')) {
    if (stat.type === 'symlink') throw metaError('trailing-slash symlink dereferencing is unsupported', 'ENOTSUP');
    if (stat.type !== 'dir') throw metaError('trailing slash requires a directory', 'ENOTDIR');
  }
  ctx.canonicalPaths.set(stat, '/' + resolved.path);
  return stat;
}
async function children(ctx, path, display, { hidden = true } = {}) {
  const entries = await ctx.io.list(path, { recursive: false, metadataOnly: true, rejectSymlinks: true }); ctx.budget.check();
  if (!Array.isArray(entries)) throw metaError('directory listing is invalid');
  if (entries.length > ctx.limits.maxEntries - ctx.entries) fail(ctx, 'directory traversal exceeds the entry limit');
  ctx.entries += entries.length; ctx.budget.spend('records', entries.length);
  const releases = [], result = [];
  try {
    for (const entry of entries) {
      await ctx.budget.checkpoint();
      if (typeof entry?.name !== 'string' || !entry.name) throw metaError('directory listing contains an invalid child name');
      if (entry.name.length > ctx.limits.maxPathBytes) fail(ctx, 'directory child exceeds the path byte limit');
      if (['.', '..'].includes(entry.name) || /[\0/]/.test(entry.name)) throw metaError('directory listing contains an invalid child name');
      if (!hidden && entry.name.startsWith('.')) continue;
      const bytes = utf8Length(entry.name), pathBytes = utf8Length(path) + (path.endsWith('/') ? 0 : 1) + bytes;
      const shownBytes = utf8Length(display) + (display.endsWith('/') ? 0 : 1) + bytes;
      ctx.budget.spend('pathBytes', pathBytes); releases.push(ctx.budget.reserveRetained(pathBytes * 2 + shownBytes * 2 + bytes + 192));
      const childPath = appendPath(path, entry.name), shown = appendPath(display, entry.name);
      result.push({ path: childPath, display: shown, name: entry.name, key: encoder.encode(entry.name) });
    }
    // A bounded merge sort yields while comparing long UTF-8 pathname keys.
    const scratchRelease = ctx.budget.reserveRetained(result.length * 16);
    try {
      let source = result, target = new Array(result.length);
      const compare = async (a, b) => {
        const end = Math.min(a.length, b.length);
        for (let at = 0; at < end; at++) {
          if ((at & 255) === 0) await ctx.budget.checkpoint();
          if (a[at] !== b[at]) return a[at] - b[at];
        }
        return a.length - b.length;
      };
      for (let width = 1; width < result.length; width *= 2) for (let start = 0; start < result.length; start += width * 2) {
        const middle = Math.min(result.length, start + width), end = Math.min(result.length, start + 2 * width); let a = start, b = middle;
        for (let out = start; out < end; out++) {
          await ctx.budget.checkpoint();
          target[out] = b === end || a < middle && await compare(source[a].key, source[b].key) <= 0 ? source[a++] : source[b++];
        }
        if (end === result.length) [source, target] = [target, source];
      }
      if (source !== result) for (let at = 0; at < result.length; at++) { await ctx.budget.checkpoint(); result[at] = source[at]; }
    } finally { scratchRelease(); }
    return { entries: result, release: () => { for (const release of releases) release(); } };
  } catch (error) { for (const release of releases) release(); throw error; }
}
function human(size) {
  if (size < 1024n) return size.toString();
  let unit = 1024n, power = 1;
  while (power < 8 && size >= unit * 1024n) { unit *= 1024n; power++; }
  const suffix = 'KMGTPEZY'[power - 1];
  if (size < 10n * unit) { const tenths = (size * 10n + unit - 1n) / unit; return `${tenths / 10n}.${tenths % 10n}${suffix}`; }
  return ((size + unit - 1n) / unit).toString() + suffix;
}
function linkTarget(ctx, stat) {
  if (typeof stat.target !== 'string') throw metaError('symbolic-link target metadata is unavailable');
  if (stat.target.length > ctx.limits.maxPathBytes || utf8Length(stat.target) > ctx.limits.maxPathBytes) fail(ctx, 'symbolic-link target exceeds the path byte limit');
  return stat.target;
}

// Signatures identify content formats only. They do not infer host capabilities.
const signatures = [
  [[137, 80, 78, 71, 13, 10, 26, 10], 'PNG image data', 'image/png'],
  [[255, 216, 255], 'JPEG image data', 'image/jpeg'],
  ['GIF87a', 'GIF image data', 'image/gif'], ['GIF89a', 'GIF image data', 'image/gif'],
  ['%PDF-', 'PDF document', 'application/pdf'],
  [[80, 75, 3, 4], 'Zip archive data', 'application/zip'], [[80, 75, 5, 6], 'Zip archive data', 'application/zip'], [[80, 75, 7, 8], 'Zip archive data', 'application/zip'],
  [[31, 139], 'gzip compressed data', 'application/gzip'], ['BZh', 'bzip2 compressed data', 'application/x-bzip2'],
  [[253, 55, 122, 88, 90, 0], 'XZ compressed data', 'application/x-xz'], [[40, 181, 47, 253], 'Zstandard compressed data', 'application/zstd'],
  [[127, 69, 76, 70], 'ELF data', 'application/x-elf'], [[0, 97, 115, 109], 'WebAssembly binary module', 'application/wasm'],
  ['SQLite format 3\0', 'SQLite 3.x database', 'application/vnd.sqlite3'], ['OggS', 'Ogg data', 'application/ogg'], ['ID3', 'Audio file with ID3 metadata', 'audio/mpeg'],
].map(([magic, description, mime]) => ({ magic: typeof magic === 'string' ? encoder.encode(magic) : Uint8Array.from(magic), description, mime }));
const hasBytes = (bytes, offset, magic) => offset >= 0 && offset + magic.length <= bytes.length && magic.every((byte, at) => bytes[offset + at] === byte);
async function classify(ctx, bytes) {
  if (!bytes.length) return { description: 'empty', mime: 'application/x-empty', encoding: 'binary' };
  for (const signature of signatures) if (hasBytes(bytes, 0, signature.magic)) return { ...signature, encoding: 'binary' };
  if (hasBytes(bytes, 0, [82, 73, 70, 70])) {
    if (hasBytes(bytes, 8, [87, 65, 86, 69])) return { description: 'RIFF WAVE audio', mime: 'audio/x-wav', encoding: 'binary' };
    if (hasBytes(bytes, 8, [87, 69, 66, 80])) return { description: 'WebP image data', mime: 'image/webp', encoding: 'binary' };
  }
  if (hasBytes(bytes, 257, [117, 115, 116, 97, 114])) return { description: 'POSIX tar archive', mime: 'application/x-tar', encoding: 'binary' };
  if (hasBytes(bytes, 0, [77, 90]) && bytes.length >= 64) {
    const at = bytes[60] + bytes[61] * 256 + bytes[62] * 65536 + bytes[63] * 16777216;
    if (hasBytes(bytes, at, [80, 69, 0, 0])) return { description: 'PE executable data', mime: 'application/vnd.microsoft.portable-executable', encoding: 'binary' };
  }
  const binary = { description: 'data', mime: 'application/octet-stream', encoding: 'binary' };
  let high = false;
  for (let at = 0; at < bytes.length; at++) {
    if ((at & 4095) === 0) await ctx.budget.checkpoint();
    const byte = bytes[at];
    if (byte < 128) { if (byte < 32 && ![9, 10, 11, 12, 13].includes(byte) || byte === 127) return binary; continue; }
    high = true; let length, minimum;
    if (byte >= 194 && byte <= 223) { length = 2; minimum = 128; }
    else if (byte >= 224 && byte <= 239) { length = 3; minimum = 2048; }
    else if (byte >= 240 && byte <= 244) { length = 4; minimum = 65536; }
    else return binary;
    if (at + length > bytes.length) return binary;
    let point = byte & (127 >> length);
    for (let n = 1; n < length; n++) { const part = bytes[at + n]; if (part < 128 || part > 191) return binary; point = point * 64 + (part & 63); }
    if (point < minimum || point > 1114111 || point >= 55296 && point <= 57343 || point >= 128 && point < 160) return binary;
    at += length - 1;
  }
  return { description: high ? 'Unicode text, UTF-8 text' : 'ASCII text', mime: 'text/plain', encoding: high ? 'utf-8' : 'us-ascii' };
}

export function createInspectionCommands(io, { signal = () => null, limits = {} } = {}) {
  return {
    async du(argv, stdin = '') {
      const ctx = invocation('du', io, signal, limits, argv, stdin);
      const { options: o, operands, occurrences } = parseArgs(argv, {
        all: flag('a', 'all'), summary: flag('s', 'summarize'), total: flag('c', 'total'), bytes: flag('b', 'bytes'), kilo: flag('k'), mega: flag('m'), human: flag('h', 'human-readable'),
        depth: flag('d', 'max-depth', true), zero: flag('0', 'null'), apparent: flag(null, 'apparent-size'),
      }, { command: 'du' });
      const depth = o.summary ? 0 : o.depth == null ? Infinity : count(ctx, o.depth, 'maximum depth');
      if (o.summary && o.depth != null && count(ctx, o.depth, 'maximum depth') !== 0) fail(ctx, '-s conflicts with a nonzero maximum depth');
      const units = occurrences.filter((item) => ['bytes', 'kilo', 'mega', 'human'].includes(item.key)).at(-1)?.key;
      const unit = units === 'bytes' ? 1n : units === 'mega' ? 1048576n : 1024n;
      const shown = (size) => units === 'human' ? human(size) : ((size + unit - 1n) / unit).toString();
      const emit = (path, size) => { ctx.output.argument(shown(size) + '\t' + path); ctx.output.byte(o.zero ? 0 : 10); };
      let total = 0n, complete = true;
      for (const display of paths(ctx, operands)) {
        const stack = [{ path: '/' + io.resolve(display), display, depth: 0, entered: false, sum: 0n, valid: true }];
        try {
          while (stack.length) {
            await ctx.budget.checkpoint(); const frame = stack.at(-1);
            if (!frame.entered) {
              frame.entered = true;
              try {
                frame.stat = await metadata(ctx, frame.depth ? frame.path : display);
                if (frame.stat.type === 'dir') frame.children = await children(ctx, ctx.canonicalPaths.get(frame.stat), frame.display);
                else frame.sum = sizeOf(frame.stat);
              } catch (error) { ordinaryError(ctx, frame.display, error); frame.valid = false; }
              frame.index = 0;
            }
            if (frame.valid && frame.children && frame.index < frame.children.entries.length) {
              if (frame.depth >= ctx.limits.maxDepth) fail(ctx, 'directory traversal exceeds the depth limit');
              const child = frame.children.entries[frame.index++];
              stack.push({ ...child, depth: frame.depth + 1, entered: false, sum: 0n, valid: true }); continue;
            }
            frame.children?.release(); stack.pop();
            if (frame.valid && frame.depth <= depth && (frame.stat.type === 'dir' || o.all || frame.depth === 0)) emit(frame.display, frame.sum);
            if (stack.length) { stack.at(-1).sum += frame.sum; stack.at(-1).valid &&= frame.valid; }
            else if (frame.valid) total += frame.sum; else complete = false;
          }
        } finally { for (const frame of stack) frame.children?.release(); }
      }
      if (o.total && complete) emit('total', total);
      return outcome(ctx);
    },

    async tree(argv, stdin = '') {
      const ctx = invocation('tree', io, signal, limits, argv, stdin);
      const { options: o, operands } = parseArgs(argv, {
        all: flag('a'), directories: flag('d'), full: flag('f'), depth: flag('L', null, true), classify: flag('F'), noIndent: flag('i'), size: flag('s'), human: flag('h'), noReport: flag(null, 'noreport'), charset: flag(null, 'charset', true),
      }, { command: 'tree' });
      if (o.charset != null && o.charset !== 'ascii') fail(ctx, 'only --charset=ascii is supported');
      const depth = o.depth == null ? Infinity : count(ctx, o.depth, 'maximum depth', 1);
      let directoryCount = 0, fileCount = 0;
      const print = (item, stat, ancestors, last, root = false) => {
        if (!o.noIndent && !root) { for (const closed of ancestors) ctx.output.argument(closed ? '    ' : '|   '); ctx.output.argument(last ? '`-- ' : '|-- '); }
        if (o.size || o.human) { const size = stat.type === 'dir' ? 0n : sizeOf(stat); ctx.output.argument('[' + (o.human ? human(size) : size.toString()).padStart(11, ' ') + ']  '); }
        ctx.output.argument(root || o.full ? item.display : item.name);
        if (o.classify) ctx.output.argument(stat.type === 'dir' ? '/' : stat.type === 'symlink' ? '@' : '');
        if (stat.type === 'symlink') ctx.output.argument(' -> ' + linkTarget(ctx, stat));
        ctx.output.byte(10);
      };
      for (const display of paths(ctx, operands)) {
        const root = { path: '/' + io.resolve(display), display, depth: 0, ancestors: [] };
        let stat;
        try { stat = await metadata(ctx, display); print(root, stat, [], true, true); }
        catch (error) { ordinaryError(ctx, display, error); continue; }
        if (stat.type !== 'dir') continue;
        const stack = [{ ...root, stat, entered: false }];
        try {
          while (stack.length) {
            await ctx.budget.checkpoint(); const frame = stack.at(-1);
            if (!frame.entered) {
              frame.entered = true; frame.index = 0;
              try {
                frame.children = await children(ctx, ctx.canonicalPaths.get(frame.stat), frame.display, { hidden: !!o.all });
                if (!o.directories) frame.kept = frame.children.entries;
                else {
                  frame.kept = [];
                  for (const child of frame.children.entries) {
                    try { const stat = await metadata(ctx, child.path); if (stat.type === 'dir') { child.stat = stat; frame.kept.push(child); } }
                    catch (error) { ordinaryError(ctx, child.display, error); }
                  }
                }
              } catch (error) { ordinaryError(ctx, frame.display, error); frame.kept = []; }
            }
            if (frame.index >= frame.kept.length) { frame.children?.release(); stack.pop(); continue; }
            const item = frame.kept[frame.index++], last = frame.index === frame.kept.length;
            const childDepth = frame.depth + 1;
            let stat;
            try { stat = item.stat ?? await metadata(ctx, item.path); print(item, stat, frame.ancestors, last); }
            catch (error) { ordinaryError(ctx, item.display, error); continue; }
            if (stat.type === 'dir') directoryCount++; else fileCount++;
            if (stat.type === 'dir' && childDepth < depth) {
              if (childDepth >= ctx.limits.maxDepth) fail(ctx, 'directory traversal exceeds the depth limit');
              stack.push({ ...item, stat, depth: childDepth, ancestors: [...frame.ancestors, last], entered: false });
            }
          }
        } finally { for (const frame of stack) frame.children?.release(); }
      }
      if (!o.noReport) ctx.output.argument(`\n${directoryCount} director${directoryCount === 1 ? 'y' : 'ies'}${o.directories ? '' : `, ${fileCount} file${fileCount === 1 ? '' : 's'}`}\n`);
      return outcome(ctx);
    },

    async file(argv, stdin = '') {
      const ctx = invocation('file', io, signal, limits, argv, stdin);
      const { options: o, operands, occurrences } = parseArgs(argv, {
        brief: flag('b', 'brief'), mime: flag('i', 'mime'), mimeType: flag(null, 'mime-type'), mimeEncoding: flag(null, 'mime-encoding'),
        follow: flag('L', 'dereference'), noFollow: flag('h', 'no-dereference'), from: { ...flag('f', 'files-from', true), multiple: true }, noPad: flag('N', 'no-pad'),
      }, { command: 'file' });
      const follow = occurrences.filter((item) => ['follow', 'noFollow'].includes(item.key)).at(-1)?.key === 'follow';
      const names = [], releases = [];
      const add = (name) => { if (!name) return; ctx.budget.spend('pathBytes', utf8Length(name)); releases.push(ctx.budget.reserveRetained(utf8Length(name) * 2 + 64)); names.push(name); };
      try {
        for (const source of ctx.inputs.operands(o.from || [], { defaultStdin: false })) {
          const cursor = await source.open();
          for (;;) {
            const row = await cursor.nextRecord(); if (!row) break;
            if (row.bytes.length > ctx.budget.remaining('pathBytes')) fail(ctx, 'file-list pathname exceeds the path byte limit');
            const release = ctx.budget.reserveRetained(row.bytes.length * 2 + 64);
            try { let name; try { name = decoder.decode(row.bytes); } catch { fail(ctx, 'file-list pathname is not valid UTF-8'); } add(name); }
            finally { release(); }
          }
        }
        for (const name of operands) { if (!name) fail(ctx, 'empty pathname'); add(name); }
        if (!names.length && !o.from?.length) fail(ctx, 'expected at least one file operand');
        const descriptors = ctx.inputs.operands(names, { defaultStdin: false });
        let longest = 0; for (const name of names) longest = Math.max(longest, utf8Length(name === '-' ? 'standard input' : name));
        for (const source of descriptors) {
          await ctx.budget.checkpoint(); const display = source.operand === '-' ? 'standard input' : source.operand;
          try {
            let found;
            if (source.operand !== '-') {
              const stat = await metadata(ctx, source.operand, follow);
              if (stat.type === 'dir') found = { description: 'directory', mime: 'inode/directory', encoding: 'binary' };
              else if (stat.type === 'symlink') found = { description: 'symbolic link to ' + linkTarget(ctx, stat), mime: 'inode/symlink', encoding: 'binary' };
            }
            if (!found) found = await classify(ctx, await (await source.open()).rest());
            if (!o.brief) { ctx.output.argument(display + ':'); ctx.output.repeat(32, 1 + (o.noPad ? 0 : longest - utf8Length(display))); }
            ctx.output.argument(o.mime || o.mimeType && o.mimeEncoding ? `${found.mime}; charset=${found.encoding}` : o.mimeType ? found.mime : o.mimeEncoding ? found.encoding : found.description);
            ctx.output.byte(10);
          } catch (error) { ordinaryError(ctx, display, error); }
        }
      } finally { for (const release of releases) release(); }
      return outcome(ctx);
    },

    async strings(argv, stdin = '') {
      const ctx = invocation('strings', io, signal, limits, argv, stdin);
      // GNU's lone '-' requests a full-file scan, already the default here.
      const normalized = []; let optionValue = false, operandsOnly = false;
      for (const arg of argv) {
        if (optionValue) { normalized.push(arg); optionValue = false; continue; }
        if (operandsOnly) { normalized.push(arg); continue; }
        if (arg === '--') { normalized.push(arg); operandsOnly = true; continue; }
        if (arg === '-') continue;
        if (/^-\d+$/.test(arg)) { normalized.push('-n' + arg.slice(1)); continue; }
        normalized.push(arg);
        if (['--bytes', '--radix', '--output-separator', '--encoding'].includes(arg)) optionValue = true;
        else if (/^-[^-]/.test(arg)) for (let at = 1; at < arg.length; at++) if ('ntse'.includes(arg[at])) { optionValue = at === arg.length - 1; break; }
      }
      const { options: o, operands, occurrences } = parseArgs(normalized, {
        all: flag('a', 'all'), length: flag('n', 'bytes', true), radix: flag('t', 'radix', true), octal: flag('o'), filename: flag('f', 'print-file-name'), separator: flag('s', 'output-separator', true), encoding: flag('e', 'encoding', true), whitespace: flag('w', 'include-all-whitespace'),
      }, { command: 'strings' });
      const minimum = count(ctx, o.length ?? '4', 'minimum string length', 1), encoding = o.encoding ?? 's';
      if (!['s', 'S'].includes(encoding)) fail(ctx, 'supported encodings are single-byte s and S');
      const radixOption = occurrences.filter((item) => ['radix', 'octal'].includes(item.key)).at(-1), radix = radixOption?.key === 'octal' ? 'o' : radixOption?.value;
      if (radix != null && !['o', 'd', 'x'].includes(radix)) fail(ctx, 'offset radix must be o, d, or x');
      const delimiter = encoder.encode(o.separator ?? '\n');
      const printable = (byte) => byte >= 32 && byte <= 126 || byte === 9 || encoding === 'S' && byte >= 128 || o.whitespace && byte >= 9 && byte <= 13;
      for (const source of ctx.inputs.operands(operands)) {
        try {
          const bytes = await (await source.open()).rest(); let start = 0;
          for (let at = 0; at <= bytes.length; at++) {
            if ((at & 4095) === 0) await ctx.budget.checkpoint();
            if (at < bytes.length && printable(bytes[at])) continue;
            if (at - start >= minimum) {
              ctx.budget.spend('records');
              if (o.filename) ctx.output.argument((source.operand === '-' ? '{standard input}' : source.operand) + ': ');
              if (radix) ctx.output.argument(start.toString({ o: 8, d: 10, x: 16 }[radix]).padStart(7, ' ') + ' ');
              ctx.output.append(bytes.subarray(start, at)); ctx.output.append(delimiter);
            }
            start = at + 1;
          }
        } catch (error) { ordinaryError(ctx, source.display, error); }
      }
      return outcome(ctx);
    },

    async cmp(argv, stdin = '') {
      const ctx = invocation('cmp', io, signal, limits, argv, stdin);
      const { options: o, operands } = parseArgs(argv, {
        silent: flag('s', ['silent', 'quiet']), list: flag('l', 'verbose'), bytes: flag('b', 'print-bytes'), ignore: flag('i', 'ignore-initial', true), limit: flag('n', 'bytes', true),
      }, { command: 'cmp' });
      if (o.silent && o.list) fail(ctx, '-s and -l are mutually exclusive');
      if (operands.length < 1 || operands.length > 4) fail(ctx, 'expected FILE1 [FILE2 [SKIP1 [SKIP2]]]');
      if (o.ignore != null && operands.length > 2) fail(ctx, 'positional skips conflict with -i');
      const names = [operands[0], operands[1] ?? '-'];
      if (names.every((name) => name === '-')) fail(ctx, 'both comparison operands cannot share standard input');
      const skip = o.ignore == null ? [operands[2] ?? '0', operands[3] ?? '0'] : String(o.ignore).split(':');
      if (skip.length > 2) fail(ctx, 'invalid initial skip pair'); if (skip.length === 1) skip.push(skip[0]);
      const offsets = skip.map((value) => count(ctx, value, 'initial skip')), limit = o.limit == null ? Infinity : count(ctx, o.limit, 'comparison limit');
      const sources = ctx.inputs.operands(names, { defaultStdin: false }), data = [];
      for (let side = 0; side < 2; side++) {
        try { data.push(await (await sources[side].open()).rest()); }
        catch (error) { ordinaryError(ctx, names[side], error, 2, !!o.silent); return outcome(ctx, 2); }
      }
      let line = 1, different = false;
      const printable = (byte) => (byte >= 128 ? 'M-' : '') + ((byte & 127) < 32 ? '^' + String.fromCharCode((byte & 127) + 64) : (byte & 127) === 127 ? '^?' : String.fromCharCode(byte & 127));
      const length = Math.min(limit, Math.max(0, data[0].length - offsets[0]), Math.max(0, data[1].length - offsets[1]));
      const offsetWidth = String(length).length;
      for (let at = 0; at < length; at++) {
        if ((at & 4095) === 0) await ctx.budget.checkpoint();
        const left = data[0][offsets[0] + at], right = data[1][offsets[1] + at];
        if (left !== right) {
          different = true; if (o.silent) return outcome(ctx, 1);
          if (o.list) ctx.output.argument(`${String(at + 1).padStart(offsetWidth, ' ')} ${left.toString(8).padStart(3, ' ')} ${o.bytes ? printable(left).padEnd(4, ' ') + ' ' : ''}${right.toString(8).padStart(3, ' ')}${o.bytes ? ' ' + printable(right) : ''}\n`);
          else { ctx.output.argument(`${names[0]} ${names[1]} differ: ${o.bytes ? 'byte' : 'char'} ${at + 1}, line ${line}${o.bytes ? ` is ${left.toString(8).padStart(3, ' ')} ${printable(left)} ${right.toString(8).padStart(3, ' ')} ${printable(right)}` : ''}\n`); return outcome(ctx, 1); }
        }
        if (left === 10) line++;
      }
      if (length < limit && Math.max(0, data[0].length - offsets[0]) !== Math.max(0, data[1].length - offsets[1])) {
        different = true;
        if (!o.silent) ctx.diagnostics.argument(`cmp: EOF on ${names[Math.max(0, data[0].length - offsets[0]) < Math.max(0, data[1].length - offsets[1]) ? 0 : 1]} after byte ${length}, in line ${line}\n`);
      }
      return outcome(ctx, different ? 1 : 0);
    },
  };
}

// naklios-env.mjs — pi-durable's ExecutionEnv over NakliOS rig fileops and the rig shell.
//
// Pi's tools (read, write, edit, bash) reach files and processes only through this object.
// Paths are POSIX and absolute from the env's root ("/workspace/x.txt"); rig fileops paths are
// mount-relative ("workspace/x.txt"), so the leading slash is the only translation. `exec` runs the
// rig shell (pipelines, grep, sed, jq …), not a real bash; Pi is told so in its instructions.
//
// The spike implements the methods Pi's built-in tools call plus the obvious file operations.
// Watchers, temp files and line readers answer `not_supported`, which pi-durable treats as absent.

import { ok, err, FileError, ExecutionError } from '@earendil-works/pi-durable/env';

const enc = new TextEncoder();
const dec = new TextDecoder();

const CODE_MAP = { ENOENT: 'not_found', EISDIR: 'is_directory', ENOTDIR: 'not_directory',
  EACCES: 'permission_denied', EPERM: 'permission_denied', EINVAL: 'invalid', ENOTSUP: 'not_supported' };

const isAborted = (context) => !!context?.abortSignal?.aborted;
const abortedErr = (path) => err(new FileError('aborted', 'the operation was cancelled', path));
const invalidErr = (path, why) => err(new FileError('invalid', why, path));

function fileErr(r, path) {
  return err(new FileError(CODE_MAP[r?.code] || 'unknown', r?.message || String(r?.code || 'error'), path));
}

// "/a/./b/../c" → "/a/c"; never climbs above "/".
export function normalizePosix(path) {
  const out = [];
  for (const seg of String(path).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return '/' + out.join('/');
}

export function createNakliosEnv({ fs, shell, cwd = '/workspace', id = 'naklios' }) {
  const abs = (path) => normalizePosix(String(path).startsWith('/') ? path : `${env.cwd}/${path}`);
  const rel = (absPath) => absPath.replace(/^\/+/, '');
  const notSupported = (what, path) => err(new FileError('not_supported', `${what} is not supported in NakliOS`, path));

  async function info(path) {
    const p = abs(path);
    if (p === '/') return ok({ name: '', path: p, kind: 'directory', size: 0, mtimeMs: 0 });
    const r = await fs.stat(rel(p));
    if (!r.ok) return fileErr(r, p);
    const kind = r.stat.type === 'dir' ? 'directory' : r.stat.type === 'symlink' ? 'symlink' : 'file';
    return ok({ name: p.split('/').pop(), path: p, kind, size: r.stat.size ?? 0, mtimeMs: r.stat.mtimeMs ?? 0 });
  }

  async function readBytes(path) {
    const p = abs(path);
    const r = await fs.read(rel(p));
    if (!r.ok) return fileErr(r, p);
    return ok(r.data instanceof Uint8Array ? r.data : enc.encode(String(r.data)));
  }

  const env = {
    id,
    cwd,
    async absolutePath(path) { return ok(abs(path)); },
    async joinPath(parts) { return ok(normalizePosix(parts.join('/'))); },
    async canonicalPath(path) { return ok(abs(path)); },
    async exists(path) {
      const r = await info(path);
      if (r.ok) return ok(true);
      return r.error.code === 'not_found' ? ok(false) : r;
    },
    fileInfo: info,
    async readTextFile(path) {
      const r = await readBytes(path);
      return r.ok ? ok(dec.decode(r.value)) : r;
    },
    readBinaryFile: readBytes,
    async readTextLines(path, options) {
      const r = await env.readTextFile(path);
      if (!r.ok) return r;
      const lines = r.value.split('\n');
      return ok(options?.maxLines ? lines.slice(0, options.maxLines) : lines);
    },
    async openTextLineReader(path) { return notSupported('line readers', abs(path)); },
    // Whole-file reader: rig reads are whole-file today, so the bytes are read once at open (which also
    // keeps the opened file after a rename) and ranges slice that copy. pi-durable 1.5's contract:
    // 0-based lines, decoded sizes, `invalid` for bad arguments or use after close, `aborted` on a
    // cancelled context.
    async openBinaryReader(path, _options, context) {
      if (isAborted(context)) return abortedErr(path);
      const p = abs(path);
      const st = await info(p);
      if (!st.ok) return st;
      if (st.value.kind === 'directory') return err(new FileError('is_directory', `${p} is a directory`, p));
      const r = await readBytes(p);
      if (!r.ok) return r;
      const bytes = r.value;
      const opened = st.value;
      // Byte offsets of every newline; line k runs from lineStart(k) to lineEnd(k).
      const nl = [];
      for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) nl.push(i);
      const lineStart = (k) => (k === 0 ? 0 : k <= nl.length ? nl[k - 1] + 1 : bytes.length);
      const lineEnd = (k) => (k < nl.length ? nl[k] : bytes.length);
      const decodedBytes = (from, to) => enc.encode(new TextDecoder('utf-8', { ignoreBOM: from > 0 }).decode(bytes.subarray(from, to))).length;
      let closed = false;
      const guard = (ctx) => (closed ? invalidErr(p, 'the reader is closed') : isAborted(ctx) ? abortedErr(p) : null);
      return ok({
        async info(ctx) { return guard(ctx) || ok({ ...opened, size: bytes.length }); },
        async read(offset, length, ctx) {
          const g = guard(ctx); if (g) return g;
          if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) return invalidErr(p, 'offset and length must be whole numbers, 0 or more');
          return ok(bytes.slice(Math.min(offset, bytes.length), Math.min(bytes.length, offset + length)));
        },
        async scanLines({ startLine, endLine } = {}, ctx) {
          const g = guard(ctx); if (g) return g;
          if (!Number.isInteger(startLine) || startLine < 0 || (endLine !== undefined && (!Number.isInteger(endLine) || endLine <= startLine))) {
            return invalidErr(p, 'startLine must be 0 or more and endLine greater than startLine');
          }
          const lines = nl.length + 1;
          if (startLine >= lines) {
            const n = bytes.length;
            return ok({ newlines: nl.length, start: n, end: n, firstLineEnd: n, lastLineStart: n, selectedBytes: 0, firstLineBytes: 0 });
          }
          const last = Math.min(endLine ?? lines, lines) - 1;
          const start = lineStart(startLine), end = lineEnd(last), firstLineEnd = lineEnd(startLine);
          return ok({ newlines: nl.length, start, end, firstLineEnd, lastLineStart: lineStart(last),
            selectedBytes: decodedBytes(start, end), firstLineBytes: decodedBytes(start, firstLineEnd) });
        },
        async close() { closed = true; },
      });
    },
    async writeFile(path, content) {
      const p = abs(path);
      const r = await fs.write(rel(p), content);
      return r.ok ? ok(undefined) : fileErr(r, p);
    },
    async appendFile(path, content) {
      const p = abs(path);
      const prev = await readBytes(p);
      if (!prev.ok && prev.error.code !== 'not_found') return prev;
      const add = typeof content === 'string' ? enc.encode(content) : content;
      const base = prev.ok ? prev.value : new Uint8Array(0);
      const next = new Uint8Array(base.length + add.length);
      next.set(base); next.set(add, base.length);
      return env.writeFile(p, next);
    },
    async truncateFile(path, size) {
      const r = await readBytes(path);
      if (!r.ok) return r;
      const next = new Uint8Array(size); next.set(r.value.subarray(0, size));
      return env.writeFile(path, next);
    },
    async flushFile() { return ok(undefined); },
    async renameFile(from, to) {
      const a = abs(from), b = abs(to);
      const r = await fs.move(rel(a), rel(b));
      return r.ok ? ok(undefined) : fileErr(r, a);
    },
    async listDir(path) {
      const p = abs(path);
      const r = await fs.list(rel(p));
      if (!r.ok) return fileErr(r, p);
      const out = [];
      for (const e of r.entries) {
        const child = normalizePosix(`${p}/${e.name}`);
        const st = await info(child);
        out.push(st.ok ? st.value : { name: e.name, path: child, kind: e.type === 'dir' ? 'directory' : 'file', size: 0, mtimeMs: 0 });
      }
      return ok(out);
    },
    // Names are listed at open; each page reads their metadata and skips entries removed since.
    async openDirReader(path, context) {
      if (isAborted(context)) return abortedErr(path);
      const p = abs(path);
      const st = await info(p);
      if (!st.ok) return st;
      if (st.value.kind !== 'directory') return err(new FileError('not_directory', `${p} is not a directory`, p));
      const r = await fs.list(rel(p));
      if (!r.ok) return fileErr(r, p);
      const names = r.entries.map((e) => e.name);
      let i = 0, closed = false;
      return ok({
        async next(max, ctx) {
          if (closed) return invalidErr(p, 'the reader is closed');
          if (isAborted(ctx)) return abortedErr(p);
          if (!Number.isInteger(max) || max < 1) return invalidErr(p, 'maxEntries must be 1 or more');
          const entries = [];
          while (i < names.length && entries.length < max) {
            const child = await info(normalizePosix(`${p}/${names[i++]}`));
            if (child.ok && (child.value.kind === 'file' || child.value.kind === 'directory')) entries.push(child.value);
          }
          return ok({ entries, done: i >= names.length });
        },
        async close() { closed = true; },
      });
    },
    async watch(_targets, _onChange) { return notSupported('watching files'); },
    async createDir(path, options) {
      const p = abs(path);
      const r = await fs.mkdir(rel(p), { recursive: options?.recursive !== false });
      return r.ok ? ok(undefined) : fileErr(r, p);
    },
    async remove(path, options) {
      const p = abs(path);
      const r = await fs.remove(rel(p), { recursive: !!options?.recursive });
      if (!r.ok && options?.force && r.code === 'ENOENT') return ok(undefined);
      return r.ok ? ok(undefined) : fileErr(r, p);
    },
    async createTempDir() { return notSupported('temporary directories'); },
    async createTempFile() { return notSupported('temporary files'); },
    // The rig shell, as `bash -c`. Its cwd is mount-relative; every call starts in the asked cwd.
    async exec(command, options, context) {
      const line = Array.isArray(command) ? command.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ') : String(command);
      const dir = abs(options?.cwd || env.cwd);
      try {
        const cd = await shell.feed(`cd '${dir.replace(/'/g, `'\\''`)}'`);
        if (shell.lastCode !== 0) {
          const text = (cd && (cd.text ?? cd.output)) || `cd: ${dir}: no such directory\n`;
          options?.onOutput?.(String(text), context, { stream: 'stderr' });
          return ok({ exitCode: 1 });
        }
        const r = await shell.feed(line);
        const text = r && typeof r === 'object' ? (r.text ?? r.output ?? '') : String(r ?? '');
        if (text) options?.onOutput?.(text.endsWith('\n') ? text : text + '\n', context, { stream: 'stdout' });
        return ok({ exitCode: Number.isInteger(shell.lastCode) ? shell.lastCode : 0 });
      } catch (e) {
        return err(new ExecutionError('unknown', String(e?.message || e), e instanceof Error ? e : undefined));
      }
    },
    async cleanup() {},
  };
  return env;
}

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
    // Whole-file reader: rig reads are whole-file today, so ranges slice a buffered copy.
    async openBinaryReader(path) {
      const r = await readBytes(path);
      if (!r.ok) return r;
      const bytes = r.value;
      const p = abs(path);
      return ok({
        async info() { return info(p); },
        async read(offset, length) { return ok(bytes.subarray(offset, Math.min(bytes.length, offset + length))); },
        async scanLines({ startLine, endLine }) {
          // Line indexes are 1-based; offsets cover [start, end) of the selected lines.
          const starts = [0];
          for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) starts.push(i + 1);
          const newlines = starts.length - 1;
          const lineStart = (n) => starts[Math.min(Math.max(n, 1), starts.length) - 1] ?? bytes.length;
          const start = lineStart(startLine);
          const end = endLine ? lineStart(endLine + 1) : bytes.length;
          const firstLineEnd = (starts.find((s) => s > start) ?? bytes.length + 1) - 1;
          return ok({ newlines, start, end: Math.max(start, end), firstLineEnd: Math.min(firstLineEnd, bytes.length),
            lastLineStart: starts[starts.length - 1], selectedBytes: Math.max(0, end - start),
            firstLineBytes: Math.max(0, Math.min(firstLineEnd, bytes.length) - start) });
        },
        async close() {},
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
    async openDirReader(path) {
      const r = await env.listDir(path);
      if (!r.ok) return r;
      let i = 0;
      return ok({
        async next(max) { const entries = r.value.slice(i, i + max); i += entries.length; return ok({ entries, done: i >= r.value.length }); },
        async close() {},
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

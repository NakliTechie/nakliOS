import { createDataContext } from './data-common.mjs';
import { utf8Length } from './u2-common.mjs';
import { resolveVirtualPath } from './path-resolution.mjs';
import { IOFailure, toBytes } from '../io.mjs';
import { SQLITE_PROGRAM } from './sqlite-python.mjs';

let nextCell = 0;
async function encode64(ctx, bytes) {
  const length = Math.ceil(bytes.length / 3) * 4;
  const releaseParts = ctx.budget.reserveRetained(length * 2 + Math.ceil(bytes.length / 16383) * 16);
  const releaseChunk = ctx.budget.reserveRetained(Math.min(bytes.length, 16383) * 2);
  try {
    const parts = [];
    for (let at = 0; at < bytes.length; at += 16383) {
      await ctx.budget.checkpoint();
      parts.push(btoa(String.fromCharCode(...bytes.subarray(at, at + 16383))));
    }
    const release = ctx.budget.reserveRetained(length * 2);
    return { text: parts.join(''), release };
  } finally { releaseParts(); releaseChunk(); }
}
async function requestCode(ctx, request, database) {
  // Encode metadata and database separately: wrapping a base64 database in
  // another base64 request needlessly holds several full-size copies.
  let metadata, data, releaseJson;
  try {
    let json = JSON.stringify(request); releaseJson = ctx.budget.reserveRetained(json.length * 5);
    metadata = await encode64(ctx, toBytes(json)); json = null; releaseJson(); releaseJson = null;
    data = await encode64(ctx, database);
    const length = SQLITE_PROGRAM.length + metadata.text.length + data.text.length + 64;
    const release = ctx.budget.reserveRetained(length * 2);
    return { code: SQLITE_PROGRAM + '\n_naklios_sqlite_run("' + metadata.text + '", "' + data.text + '")\n', release };
  } finally { releaseJson?.(); metadata?.release(); data?.release(); }
}
async function decode64(ctx, text) {
  if (typeof text !== 'string' || text.length % 4 || text.length > Math.ceil(ctx.limits.maxDatabaseBytes / 3) * 4) ctx.fail('invalid database response encoding');
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0, end = text.length - padding;
  const digit = (code) => code >= 65 && code <= 90 ? code - 65 : code >= 97 && code <= 122 ? code - 71 : code >= 48 && code <= 57 ? code + 4 : code === 43 ? 62 : code === 47 ? 63 : -1;
  for (let at = 0; at < end; at++) {
    if (at % 4096 === 0) await ctx.budget.checkpoint();
    if (digit(text.charCodeAt(at)) < 0) ctx.fail('invalid database response encoding');
  }
  if (padding && (end < 2 || (digit(text.charCodeAt(end - 1)) & (padding === 2 ? 15 : 3)))) ctx.fail('invalid database response padding');
  const size = text.length / 4 * 3 - padding;
  if (size > ctx.limits.maxDatabaseBytes) ctx.fail('database response exceeds its byte limit');
  const releaseBinary = ctx.budget.reserveRetained(size * 2);
  try {
    let decoded; try { decoded = atob(text); } catch { ctx.fail('invalid database response encoding'); }
    ctx.budget.reserveRetained(size);
    return Uint8Array.from(decoded, (value) => value.charCodeAt(0));
  } finally { releaseBinary(); }
}
function validateDatabase(ctx, data) {
  if (!data.length) return;
  const magic = 'SQLite format 3\0';
  if (data.length < 100 || [...magic].some((value, at) => data[at] !== value.charCodeAt(0))) ctx.fail('invalid SQLite database header');
  const pageSize = data[16] * 256 + data[17], size = pageSize === 1 ? 65536 : pageSize;
  if (size < 512 || size > 65536 || (size & size - 1) !== 0 || data.length % size !== 0) ctx.fail('invalid SQLite database page boundaries');
}
export function createSqliteCommand(io, { signal = () => null, limits = {}, kiln = null, kilnIsolate = false,
  cwd = () => '', hasDeadline = () => false, authorize } = {}) {
  return async (argv, stdin = '') => {
    const ctx = createDataContext('sqlite3', io, stdin, signal, limits); ctx.arguments(argv);
    const options = { mode: 'list', header: false, readonly: false, separator: '|', nullvalue: '' }, operands = [];
    let positional = false;
    for (let at = 0; at < argv.length; at++) {
      const word = argv[at];
      if (!positional && word === '--') { positional = true; continue; }
      if (!positional && word.startsWith('-')) {
        if (['-list', '-csv', '-json'].includes(word)) options.mode = word.slice(1);
        else if (word === '-header') options.header = true;
        else if (word === '-noheader') options.header = false;
        else if (word === '-readonly') options.readonly = true;
        else if (word === '-separator' || word === '-nullvalue') { if (++at >= argv.length) ctx.fail(`${word} requires a value`, 2); options[word.slice(1)] = argv[at]; }
        else ctx.fail(`unsupported option ${word}`, 2);
      } else operands.push(word);
    }
    if (operands.length < 1 || operands.length > 2) ctx.fail('expected DATABASE [SQL]; use :memory: for a transient database', 2);
    const [database, argument] = operands;
    let sql;
    if (argument === undefined) { const [input] = ctx.inputs.operands([]); sql = ctx.decode(await (await input.open()).rest()); }
    else { ctx.budget.spend('inputBytes', utf8Length(argument)); sql = argument; }
    if (sql.includes('\0')) ctx.fail('SQL must not contain NUL bytes', 2);
    if (utf8Length(sql) > ctx.limits.maxSqlBytes) ctx.fail('SQL exceeds the byte limit');
    if (/^\s*\./.test(sql)) ctx.fail('SQLite shell dot commands and host-file operations are unavailable', 2);
    if (!kiln || typeof kiln.exec !== 'function') ctx.fail('Kiln Python runtime is unavailable; enable download consent (Worker hosts also require cross-origin isolation)', 1);
    if (hasDeadline()) ctx.fail('scoped timeout is unavailable for the Kiln Python runtime', 2);
    const memory = database === ':memory:'; let path = null, original = null;
    if (!memory) {
      const resolved = await resolveVirtualPath(io, database, { context: ctx, mode: 'all-but-last', followFinal: false }); path = resolved.path;
      if (resolved.stat && resolved.stat.type !== 'file') ctx.fail('database must be a regular file');
      if (!resolved.stat && options.readonly) ctx.fail('readonly database does not exist');
      if (resolved.stat) {
        original = await io.readBytes('/' + path, { maxBytes: Math.min(ctx.limits.maxDatabaseBytes, ctx.budget.remaining('inputBytes')), rejectSymlinks: true });
        ctx.budget.spend('inputBytes', original.length); ctx.budget.reserveRetained(original.length); validateDatabase(ctx, original);
      }
    }
    let encodedRequest = await requestCode(ctx, { ...options, sql, limits: ctx.limits, exists: original !== null }, original ?? new Uint8Array());
    const cellId = 'shell-sqlite-' + ++nextCell, activeSignal = signal(), interrupt = () => { try { kiln.interrupt?.(cellId); } catch {} };
    const maxResponse = Math.ceil(ctx.limits.maxDatabaseBytes / 3) * 4 + ctx.limits.maxOutputBytes * 6 + 4096;
    let result;
    ctx.budget.check(); activeSignal?.addEventListener('abort', interrupt, { once: true });
    try { result = await kiln.exec(cellId, encodedRequest.code, { interpreter: 'sqlite', signal: activeSignal, isolate: kilnIsolate, cwd: cwd(), argv: ['sqlite3'], stdin: '', outputCapBytes: maxResponse, timeoutMs: 30000 }); }
    finally { activeSignal?.removeEventListener('abort', interrupt); encodedRequest.release(); encodedRequest = null; }
    ctx.budget.check();
    if (result?.status !== 'ok' || result.truncated) ctx.fail(result?.truncated ? 'Kiln response exceeds its output limit' : (result?.message || result?.stderr || result?.traceback || 'Kiln execution failed'), 1);
    if (typeof result.stdout !== 'string' || result.stdout.length > maxResponse) ctx.fail('invalid or oversized Kiln response');
    const releaseResponse = ctx.budget.reserveRetained(result.stdout.length * 2);
    const releaseEnvelope = ctx.budget.reserveRetained(result.stdout.length * 2);
    let envelope; try { envelope = JSON.parse(result.stdout); } catch { ctx.fail('invalid or truncated Kiln response'); }
    result = null; releaseResponse();
    if (!envelope || typeof envelope.ok !== 'boolean' || typeof envelope.changed !== 'boolean' || typeof envelope.output !== 'string'
      || (envelope.changed ? typeof envelope.database !== 'string' : envelope.database !== null)) ctx.fail('invalid Kiln SQLite response fields');
    if (!envelope.ok) ctx.fail(typeof envelope.error === 'string' ? envelope.error : 'SQLite execution failed', 1);
    if (options.readonly && envelope.changed) ctx.fail('readonly runtime returned database changes');
    // Reserve every output byte before publishing a valid returned database.
    ctx.output.argument(envelope.output);
    if (envelope.changed) {
      const bytes = await decode64(ctx, envelope.database); validateDatabase(ctx, bytes);
      envelope = null; releaseEnvelope();
      if (!memory) {
        const input = { path, data: bytes, expectedData: original, rejectSymlinks: true, createParents: false };
        const permission = authorize ? await authorize('fs.write', input) : null;
        if (permission && !permission.ok) throw new IOFailure('fs.write', permission);
        ctx.budget.check(); await io.write('/' + path, bytes, { expectedData: original, rejectSymlinks: true }); ctx.budget.check();
      }
    }
    return ctx.finish();
  };
}

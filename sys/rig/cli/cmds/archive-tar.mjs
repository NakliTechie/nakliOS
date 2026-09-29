import { ArgError } from '../args.mjs';
import { normalizePath } from '../io.mjs';
import { utf8Length } from './u2-common.mjs';
import { checkRange, joinBytes, archiveCount } from './archive-common.mjs';
import { encoder, decodeName, memberName } from './archive-files.mjs';

export function tarArguments(ctx, io, argv) {
  const result = { mode: null, gzip: false, archive: '-', verbose: false, strip: 0, exclude: [], sources: [], directories: [], directory: io.resolve('.') };
  const fail = (message) => { throw new ArgError(`tar: ${message}`); };
  const set = (flag, value) => {
    if ('cxt'.includes(flag)) { if (result.mode && result.mode !== flag) fail('choose exactly one of -c, -x, -t'); result.mode = flag; }
    else if (flag === 'z') result.gzip = true;
    else if (flag === 'v') result.verbose = true;
    else if (flag === 'f') result.archive = value;
    else if (flag === 'C') { result.directory = normalizePath(result.directory, value); result.directories.push(result.directory); }
    else if (flag === 'strip-components') result.strip = archiveCount(value, 'tar', flag);
    else if (flag === 'exclude') result.exclude.push(value);
    else fail(`unsupported option ${flag}`);
  };
  const long = { create: 'c', extract: 'x', get: 'x', list: 't', gzip: 'z', verbose: 'v', file: 'f', directory: 'C', 'strip-components': 'strip-components', exclude: 'exclude' };
  const valued = (flag) => ['f', 'C', 'strip-components', 'exclude'].includes(flag);
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]; ctx.budget.spend('steps');
    const take = () => { if (++i >= argv.length) fail(`option ${word} requires a value`); return argv[i]; };
    if (!positional && word === '--') { positional = true; continue; }
    if (!positional && word.startsWith('--')) {
      const equal = word.indexOf('='), name = word.slice(2, equal < 0 ? undefined : equal), flag = long[name];
      if (!flag) fail(`unsupported option --${name}`);
      if (equal >= 0 && !valued(flag)) fail(`option --${name} takes no value`);
      set(flag, valued(flag) ? equal >= 0 ? word.slice(equal + 1) : take() : true); continue;
    }
    const traditional = i === 0 && /^[cxtzvfC]+$/.test(word);
    if (!positional && (word.startsWith('-') && word !== '-' || traditional)) {
      const flags = traditional ? word : word.slice(1);
      for (let j = 0; j < flags.length; j++) {
        const flag = flags[j]; let value = true;
        if (valued(flag)) {
          value = !traditional && j + 1 < flags.length ? flags.slice(j + 1) : take();
          if (!traditional) j = flags.length;
        }
        set(flag, value);
      }
    } else result.sources.push({ operand: word, directory: result.directory });
  }
  if (!result.mode) fail('choose one of -c, -x, -t');
  if (result.mode === 'c' && !result.sources.length) fail('refusing to create an archive without operands');
  if (result.mode === 'c' && result.strip) fail('--strip-components requires extraction or listing');
  return result;
}
function field(ctx, bytes, offset, width) {
  const view = bytes.subarray(offset, offset + width), nul = view.indexOf(0);
  return decodeName(ctx, nul < 0 ? view : view.subarray(0, nul));
}
function number(ctx, bytes, offset, width) {
  if (bytes[offset] & 128) ctx.fail('base-256 tar numeric fields are unsupported');
  const text = field(ctx, bytes, offset, width).trim();
  if (text && !/^[0-7]+$/.test(text)) ctx.fail('invalid tar octal numeric field');
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value)) ctx.fail('tar numeric field exceeds the resource limit'); return value;
}
async function pax(ctx, bytes) {
  if (bytes.length > ctx.limits.maxHeaderBytes) ctx.fail('PAX metadata exceeds the header limit');
  const result = Object.create(null); let at = 0;
  while (at < bytes.length) {
    await ctx.budget.checkpoint(); const start = at; let digits = '';
    while (at < bytes.length && bytes[at] >= 48 && bytes[at] <= 57 && digits.length < 16) digits += String.fromCharCode(bytes[at++]);
    if (!digits || bytes[at++] !== 32) ctx.fail('invalid PAX record length');
    const length = Number(digits), end = start + length;
    if (!Number.isSafeInteger(length) || end > bytes.length || end <= at + 2 || bytes[end - 1] !== 10) ctx.fail('invalid PAX record boundary');
    const record = bytes.subarray(at, end - 1), equal = record.indexOf(61);
    if (equal <= 0) ctx.fail('invalid PAX key/value record');
    const key = decodeName(ctx, record.subarray(0, equal));
    if (/sparse/i.test(key) || key === 'linkpath') ctx.fail('sparse and link PAX metadata are unsupported');
    // SCHILY xattrs may contain binary values. Only fields that control our
    // extraction need text decoding; host ownership/xattrs are never restored.
    if (key === 'path' || key === 'size') {
      const value = decodeName(ctx, record.subarray(equal + 1));
      if (key === 'size' && (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)))) ctx.fail('invalid PAX size');
      result[key] = value;
    }
    at = end;
  }
  return result;
}
export async function parseTar(ctx, bytes, { expanded = false } = {}) {
  if (!expanded) ctx.expand(bytes.length);
  const entries = []; let at = 0, local = null, global = Object.create(null), longName = null, ended = false;
  while (at < bytes.length) {
    await ctx.budget.checkpoint(); checkRange(ctx, bytes, at, 512);
    const header = bytes.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) {
      checkRange(ctx, bytes, at, 1024);
      for (let i = at; i < bytes.length; i++) { if ((i & 4095) === 0) await ctx.budget.checkpoint(); if (bytes[i]) ctx.fail('nonzero bytes after tar end marker'); }
      ended = true; break;
    }
    ctx.budget.spend('files');
    const expected = number(ctx, header, 148, 8); let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== expected) ctx.fail('tar header checksum mismatch');
    const magic = field(ctx, header, 257, 6);
    if (magic && magic !== 'ustar' && magic !== 'ustar ') ctx.fail('unsupported tar format');
    const type = header[156] ? String.fromCharCode(header[156]) : '0';
    let name = field(ctx, header, 0, 100), size = number(ctx, header, 124, 12);
    if (magic === 'ustar') { const prefix = field(ctx, header, 345, 155); if (prefix) name = prefix + '/' + name; }
    at += 512;
    if (['x', 'g', 'L'].includes(type)) {
      if (size > ctx.limits.maxHeaderBytes) ctx.fail('tar extended header exceeds the resource limit');
      checkRange(ctx, bytes, at, Math.ceil(size / 512) * 512); const data = bytes.subarray(at, at + size);
      if (type === 'L') {
        const nul = data.indexOf(0);
        if (nul >= 0 && data.subarray(nul).some((byte) => byte !== 0)) ctx.fail('invalid GNU long-name terminator');
        longName = decodeName(ctx, nul < 0 ? data : data.subarray(0, nul)); memberName(ctx, longName, true);
      } else {
        const metadata = await pax(ctx, data);
        if (type === 'g') { if (metadata.path !== undefined || metadata.size !== undefined) ctx.fail('global PAX path/size is unsupported'); global = { ...global, ...metadata }; }
        else local = { ...(local ?? {}), ...metadata };
      }
      at += Math.ceil(size / 512) * 512; continue;
    }
    if (!['0', '5'].includes(type)) ctx.fail(`unsupported tar entry type ${type}`);
    const metadata = { ...global, ...(local ?? {}) }; name = metadata.path ?? longName ?? name;
    if (metadata.size !== undefined) size = Number(metadata.size);
    if (type === '5' && size) ctx.fail('tar directory contains file data');
    const directory = type === '5'; name = memberName(ctx, name, directory);
    checkRange(ctx, bytes, at, Math.ceil(size / 512) * 512);
    entries.push({ name, directory, data: bytes.subarray(at, at + size) });
    at += Math.ceil(size / 512) * 512; local = null; longName = null;
  }
  if (!ended || local || longName !== null) ctx.fail('missing tar end marker or dangling extended header');
  return entries;
}
function writeText(ctx, output, offset, width, text) {
  const bytes = encoder.encode(text); if (bytes.length > width) ctx.fail('tar header field exceeds its limit'); output.set(bytes, offset);
}
function writeNumber(ctx, output, offset, width, number) {
  writeText(ctx, output, offset, width, Math.max(0, Math.floor(number)).toString(8).padStart(width - 1, '0') + '\0');
}
function header(ctx, name, size, directory, type = directory ? '5' : '0', mtime = 0) {
  const bytes = new Uint8Array(512); let prefix = '', leaf = name;
  if (utf8Length(leaf) > 100) {
    for (let i = name.length - 1; i >= 0; i--) if (name[i] === '/' && utf8Length(name.slice(0, i)) <= 155 && utf8Length(name.slice(i + 1)) <= 100) {
      prefix = name.slice(0, i); leaf = name.slice(i + 1); break;
    }
  }
  if (utf8Length(leaf) > 100) return null;
  writeText(ctx, bytes, 0, 100, leaf); writeNumber(ctx, bytes, 100, 8, directory ? 0o755 : 0o644);
  writeNumber(ctx, bytes, 108, 8, 0); writeNumber(ctx, bytes, 116, 8, 0); writeNumber(ctx, bytes, 124, 12, size);
  writeNumber(ctx, bytes, 136, 12, mtime / 1000); bytes.fill(32, 148, 156); bytes[156] = type.charCodeAt(0);
  writeText(ctx, bytes, 257, 6, 'ustar\0'); writeText(ctx, bytes, 263, 2, '00'); writeText(ctx, bytes, 345, 155, prefix);
  const sum = bytes.reduce((value, byte) => value + byte, 0); writeText(ctx, bytes, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return bytes;
}
function paxPath(name) {
  const body = ' path=' + name + '\n'; let size = utf8Length(body) + 1;
  while (utf8Length(String(size) + body) !== size) size = utf8Length(String(size) + body);
  return encoder.encode(String(size) + body);
}
export async function createTar(ctx, entries) {
  const parts = [];
  for (const entry of entries) {
    await ctx.budget.checkpoint(); const name = (entry.name || '.') + (entry.directory ? '/' : '');
    let block = header(ctx, name, entry.data.length, entry.directory, undefined, entry.mtime);
    if (!block) {
      const extra = paxPath(name); if (extra.length > ctx.limits.maxHeaderBytes) ctx.fail('tar extended name exceeds the header limit');
      parts.push(header(ctx, 'PaxHeader', extra.length, false, 'x'), extra, new Uint8Array((512 - extra.length % 512) % 512));
      block = header(ctx, 'PaxEntry', entry.data.length, entry.directory, undefined, entry.mtime);
    }
    parts.push(block, entry.data, new Uint8Array((512 - entry.data.length % 512) % 512));
  }
  parts.push(new Uint8Array(1024)); return joinBytes(ctx, parts, Math.min(ctx.limits.maxOutputBytes, ctx.limits.maxExpandedBytes));
}

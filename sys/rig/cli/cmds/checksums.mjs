import { ArgError, parseArgs } from '../args.mjs';
import { IOFailure, autoData, renderData } from '../io.mjs';
import { createCanonicalContext } from './canonical-input.mjs';
import { parseCount, utf8Length } from './u2-common.mjs';
import { digestBytes, checksumNumber } from './digest-algorithms.mjs';
import { encodeDigestBase64 } from './encoding-codecs.mjs';
import { DIGEST_LENGTHS, DIGEST_TAGS, digestHex, escapeChecksumName, parseChecksumRecord } from './checksum-manifest.mjs';

const commands = { md5sum: 'md5', sha1sum: 'sha1', sha224sum: 'sha224', sha256sum: 'sha256', sha384sum: 'sha384', sha512sum: 'sha512', b2sum: 'blake2b', cksum: 'crc', sum: 'bsd' };
const legacy = ['crc', 'crc32b', 'bsd', 'sysv'];
const flag = (short, long, value = false) => ({ ...(short ? { short } : {}), ...(long ? { long } : {}), ...(value ? { value } : {}) });
const common = { binary: flag('b', 'binary'), text: flag('t', 'text'), check: flag('c', 'check'), zero: flag('z', 'zero'),
  warn: flag('w', 'warn'), tag: flag(null, 'tag'), quiet: flag(null, 'quiet'), status: flag(null, 'status'), strict: flag(null, 'strict'), ignoreMissing: flag(null, 'ignore-missing') };
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fail = (ctx, text) => { throw new ArgError(`${ctx.command}: ${text}`); };
function finish(ctx, diagnostics, code) {
  const text = ctx.output.finish();
  return { text, code, raw: true, ...(diagnostics.length ? { displayText: new TextDecoder().decode(diagnostics.finish()) + renderData(autoData(text)) } : {}) };
}
function named(name) {
  const escaped = escapeChecksumName(name); return (escaped.escaped ? '\\' : '') + escaped.name;
}

async function verify(ctx, operands, algorithm, options, subtle, diagnostics) {
  let code = 0;
  for (const manifest of ctx.inputs.operands(operands)) {
    let valid = 0, checked = 0, malformed = 0, failed = 0, missing = 0, number = 0;
    try {
      const cursor = await manifest.open();
      for (let line; (line = await cursor.nextRecord());) {
        number++; await ctx.budget.checkpoint();
        const release = ctx.budget.reserveRetained(line.bytes.length * 6 + 512);
        try {
          let record;
          try { record = parseChecksumRecord(decoder.decode(line.bytes), { algorithm, allowBase64: ctx.command === 'cksum' }); }
          catch { record = null; }
          if (record?.skip) continue;
          if (!record) {
            malformed++;
            if (options.warn && !options.status) diagnostics.argument(`${ctx.command}: ${manifest.operand}: ${number}: improperly formatted checksum line\n`);
            continue;
          }
          valid++;
          if (manifest.operand === '-' && record.name === '-') {
            failed++; code = 1;
            if (!options.status) diagnostics.argument(`${ctx.command}: a stdin manifest cannot also checksum stdin\n`);
            continue;
          }
          try {
            const [target] = ctx.inputs.operands([record.name]), bytes = await (await target.open()).rest();
            const digest = await digestBytes(record.algorithm, bytes, { context: ctx, bits: record.bits, subtle });
            const actual = record.encoding === 'base64' ? encodeDigestBase64(digest) : digestHex(digest);
            checked++;
            if (actual !== record.token) {
              code = 1; failed++;
              if (!options.status) ctx.output.argument(`${named(record.name)}: FAILED\n`);
            } else if (!options.quiet && !options.status) ctx.output.argument(`${named(record.name)}: OK\n`);
          } catch (error) {
            if (!(error instanceof IOFailure)) throw error;
            if (options.ignoreMissing && error.code === 'ENOENT') { missing++; continue; }
            code = 1; failed++;
            if (!options.status) {
              diagnostics.argument(`${ctx.command}: ${record.name}: ${error.code}: ${error.message}\n`);
              ctx.output.argument(`${named(record.name)}: FAILED open or read\n`);
            }
          }
        } finally { release(); }
      }
      if (!valid || !checked && !failed) {
        code = 1;
        if (!options.status) diagnostics.argument(`${ctx.command}: ${manifest.operand}: ${missing ? 'no file was verified' : 'no properly formatted checksum lines found'}\n`);
      }
      if (malformed && options.strict) code = 1;
      if (malformed && !options.status) diagnostics.argument(`${ctx.command}: WARNING: ${malformed} improperly formatted checksum line(s)\n`);
      if (failed && !options.status) diagnostics.argument(`${ctx.command}: WARNING: ${failed} computed checksum(s) did NOT match or could not be read\n`);
    } catch (error) {
      if (!(error instanceof IOFailure)) throw error;
      code = 1;
      if (!options.status) diagnostics.argument(`${ctx.command}: ${manifest.operand}: ${error.code}: ${error.message}\n`);
    }
  }
  return finish(ctx, diagnostics, code);
}

export function createChecksumCommands(io, { signal = () => null, limits = {}, subtle } = {}) {
  return Object.fromEntries(Object.entries(commands).map(([command, initial]) => [command, async (argv, stdin = '') => {
    const ctx = createCanonicalContext({ command, io, stdin, signal, limits });
    for (const arg of argv) ctx.budget.spend('argumentBytes', utf8Length(arg) + 1);
    const spec = command === 'sum' ? { bsd: flag('r'), sysv: flag('s', 'sysv') } : { ...common };
    if (command === 'b2sum' || command === 'cksum') spec.length = flag('l', 'length', true);
    if (command === 'cksum') Object.assign(spec, { algorithm: flag('a', 'algorithm', true), untagged: flag(null, 'untagged'), base64: flag(null, 'base64'), raw: flag(null, 'raw') });
    const { options, operands, occurrences } = parseArgs(argv, spec, { command });
    let algorithm = options.algorithm ?? initial, binary = false, bits = 512;
    for (const item of occurrences) {
      if (item.key === 'binary') binary = true; else if (item.key === 'text') binary = false;
      if (item.key === 'bsd' || item.key === 'sysv') algorithm = item.key;
    }
    if (!legacy.includes(algorithm) && !Object.hasOwn(DIGEST_LENGTHS, algorithm)) fail(ctx, `unsupported algorithm ${algorithm}`);
    if (options.length !== undefined) {
      if (algorithm !== 'blake2b') fail(ctx, '--length requires the blake2b algorithm');
      bits = parseCount(options.length, { command, label: 'digest length', max: 512 });
      if (bits % 8) fail(ctx, 'digest length must be a multiple of 8');
      if (bits === 0) bits = 512;
    }
    const tagged = !!options.tag || command === 'cksum' && !options.untagged;
    if (options.tag && options.untagged) fail(ctx, '--tag and --untagged conflict');
    if (options.tag && options.text) fail(ctx, '--tag and --text conflict');
    if (options.raw && (operands.length > 1 || options.check || options.zero || options.base64 || options.tag || options.untagged)) fail(ctx, '--raw requires one input and no output-format/check options');
    if (options.check) {
      if (options.zero || options.tag || options.binary || options.text) fail(ctx, 'check mode conflicts with zero, tag, binary or text options');
      if (command === 'cksum' && options.algorithm === undefined) algorithm = null; // Tagged records identify their own digest family.
      if (legacy.includes(algorithm)) fail(ctx, 'legacy CRC and sum formats do not support checking');
      return verify(ctx, operands, algorithm, options, subtle, ctx.output.fork());
    }
    if (options.warn || options.quiet || options.status || options.strict || options.ignoreMissing) fail(ctx, 'verification options require --check');
    if (legacy.includes(algorithm) && (options.base64 || options.tag || options.binary || options.text || options.untagged)) fail(ctx, 'legacy checksums do not support digest formatting options');
    const diagnostics = ctx.output.fork(); let code = 0;
    for (const input of ctx.inputs.operands(operands)) {
      await ctx.budget.checkpoint();
      try {
        const bytes = await (await input.open()).rest();
        if (legacy.includes(algorithm)) {
          const value = await checksumNumber(algorithm, bytes, { context: ctx });
          if (options.raw) {
            const raw = new Uint8Array(algorithm === 'bsd' || algorithm === 'sysv' ? 2 : 4);
            const view = new DataView(raw.buffer);
            if (raw.length === 2) view.setUint16(0, value); else view.setUint32(0, value);
            ctx.output.append(raw); continue;
          }
          const count = algorithm === 'bsd' ? Math.ceil(bytes.length / 1024) : algorithm === 'sysv' ? Math.ceil(bytes.length / 512) : bytes.length;
          const prefix = algorithm === 'bsd' ? `${String(value).padStart(5, '0')} ${String(count).padStart(5)}` : `${value} ${count}`;
          ctx.output.argument(prefix + (operands.length ? ' ' + input.operand : '')); ctx.output.byte(options.zero ? 0 : 10);
        } else {
          const digest = await digestBytes(algorithm, bytes, { context: ctx, bits, subtle });
          if (options.raw) { ctx.output.append(digest); continue; }
          const token = options.base64 ? encodeDigestBase64(digest) : digestHex(digest);
          const name = options.zero ? { name: input.operand, escaped: false } : escapeChecksumName(input.operand);
          const indicator = name.escaped ? '\\' : '';
          if (tagged) {
            const tag = DIGEST_TAGS[algorithm] + (algorithm === 'blake2b' && bits !== 512 ? '-' + bits : '');
            ctx.output.argument(`${indicator}${tag} (${name.name}) = ${token}`);
          } else ctx.output.argument(`${indicator}${token} ${binary ? '*' : ' '}${name.name}`);
          ctx.output.byte(options.zero ? 0 : 10);
        }
      } catch (error) {
        if (!(error instanceof IOFailure)) throw error;
        code = 1; diagnostics.argument(`${command}: ${input.operand}: ${error.code}: ${error.message}\n`);
      }
    }
    return finish(ctx, diagnostics, code);
  }]));
}

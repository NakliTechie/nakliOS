import { ArgError, parseArgs } from '../args.mjs';
import { IOFailure } from '../io.mjs';
import { createU2Context, utf8Length } from './u2-common.mjs';
import { truncateSize } from '../../fileops/mutation-limit.mjs';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const modes = { '+': 'add', '-': 'subtract', '<': 'min', '>': 'max', '/': 'roundDown', '%': 'roundUp' };
const fail = (command, message) => { throw new ArgError(`${command}: ${message}`); };
const ioError = (code, message) => new IOFailure('shell', { code, message });
const trimSlash = (path) => path.replace(/\/+$/, '') || '/';
const tail = (path) => trimSlash(path).split('/').at(-1);

export function createMutationCommands(io, { signal = () => null, randomBytes, environment = () => new Map(), limits = {} } = {}) {
  function invocation(command, argv) {
    const ctx = createU2Context({ command, io, signal, limits });
    if (!Array.isArray(argv) || argv.length > ctx.limits.maxFiles + 32) fail(command, 'argument count exceeds the resource limit');
    for (const arg of argv) {
      if (typeof arg !== 'string') throw new TypeError('command arguments must be strings');
      try { ctx.budget.spend('argumentBytes', utf8Length(arg, ctx.budget.remaining('argumentBytes'))); }
      catch (error) { if (error instanceof ArgError) fail(command, 'argument bytes exceed the resource limit'); throw error; }
    }
    ctx.diagnostics = ctx.output.fork();
    return ctx;
  }
  const diagnostic = (ctx, error, path) => {
    ctx.diagnostics.argument(`${ctx.command}: ${path ? path + ': ' : ''}${error.code}: ${error.message}\n`);
  };
  const result = (ctx, failed = false) => ({ text: ctx.output.finish(), stdout: ctx.output.finish(), stderr: ctx.diagnostics.finish(), code: failed ? 1 : 0, raw: true });
  const nonemptyOperands = (command, operands) => { if (!operands.length) fail(command, 'missing operand'); };
  const reservePath = (ctx, path) => {
    ctx.budget.spend('pathBytes', utf8Length(path, ctx.budget.remaining('pathBytes')));
    ctx.budget.reserveRetained(path.length * 2 + 64);
  };
  function parseSize(text) {
    const match = /^([+\-<>/%]?)([0-9]*)([kKMGTPEZYRQ](?:iB|B)?|b|B)?$/.exec(text);
    if (!match || !match[2] && !match[3]) fail('truncate', `invalid size: ${text}`);
    const significant = (match[2] || '1').replace(/^0+/, '') || '0';
    if (significant.length > 16) fail('truncate', 'size exceeds the exact integer limit');
    let amount = BigInt(significant);
    if (match[3]) {
      const suffix = match[3];
      if (suffix === 'b') amount *= 512n;
      else if (suffix !== 'B') {
        const power = 'KMGTPEZYRQ'.indexOf(suffix[0].toUpperCase()) + 1;
        amount *= (suffix.endsWith('B') && !suffix.endsWith('iB') ? 1000n : 1024n) ** BigInt(power);
      }
    }
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) fail('truncate', 'size exceeds the exact integer limit');
    const mode = modes[match[1]] || 'set', size = Number(amount);
    if ((mode === 'roundDown' || mode === 'roundUp') && !size) fail('truncate', 'rounding multiple must be positive');
    return { size, mode };
  }
  async function randomSuffix(count, ctx) {
    let value = '';
    while (value.length < count) {
      await ctx.budget.checkpoint();
      const wanted = Math.min(256, count - value.length);
      let bytes;
      if (randomBytes) bytes = await randomBytes(wanted);
      else {
        if (typeof globalThis.crypto?.getRandomValues !== 'function') fail('mktemp', 'cryptographic randomness is unavailable');
        bytes = globalThis.crypto.getRandomValues(new Uint8Array(wanted));
      }
      ctx.budget.check();
      if (!(bytes instanceof Uint8Array) || bytes.length !== wanted) fail('mktemp', 'random provider returned invalid bytes');
      for (const byte of bytes) {
        ctx.budget.spend('steps');
        // 248 is divisible by62, so rejection avoids modulo bias.
        if (byte < 248) value += ALPHABET[byte % 62];
      }
    }
    return value;
  }
  return {
    async rmdir(argv) {
      const ctx = invocation('rmdir', argv);
      const { options, operands } = parseArgs(argv, {
        parents: { short: 'p', long: 'parents' }, verbose: { short: 'v', long: 'verbose' },
        ignore: { long: 'ignore-fail-on-non-empty' },
      }, { command: 'rmdir' });
      nonemptyOperands('rmdir', operands);
      const groups = [];
      for (const operand of operands) {
        const paths = []; let path = trimSlash(operand);
        for (;;) {
          ctx.budget.spend('files'); reservePath(ctx, path); paths.push(path);
          if (!options.parents || path === '/' || ['.', '..'].includes(tail(path))) break;
          const slash = path.lastIndexOf('/');
          if (slash < 0) break;
          path = trimSlash(path.slice(0, slash));
          if (path === '/' || path === '.') break;
        }
        groups.push(paths);
      }
      let failed = false;
      for (const paths of groups) for (const path of paths) {
        await ctx.budget.checkpoint();
        try {
          if (!path || ['.', '..'].includes(tail(path))) throw ioError('EINVAL', 'cannot remove a dot directory');
          await io.remove(path, { kind: 'dir', follow: false, metadataOnly: true });
          ctx.budget.check();
          if (options.verbose) ctx.output.argument(`rmdir: removing directory, '${path}'\n`);
        } catch (error) {
          if (!(error instanceof IOFailure)) throw error;
          if (!(options.ignore && error.code === 'ENOTEMPTY')) { diagnostic(ctx, error, path); failed = true; }
          break;
        }
      }
      return result(ctx, failed);
    },
    async unlink(argv) {
      const ctx = invocation('unlink', argv), { operands } = parseArgs(argv, {}, { command: 'unlink' });
      if (operands.length !== 1) fail('unlink', 'exactly one file operand is required');
      const path = operands[0]; reservePath(ctx, path); ctx.budget.spend('files');
      try {
        if (path.endsWith('/')) throw ioError('EISDIR', 'a trailing slash cannot identify a non-directory');
        await ctx.budget.checkpoint();
        await io.remove(path, { kind: 'non-dir', follow: false, metadataOnly: true }); ctx.budget.check();
      } catch (error) { if (!(error instanceof IOFailure)) throw error; diagnostic(ctx, error, path); return result(ctx, true); }
      return result(ctx);
    },
    async mktemp(argv) {
      const ctx = invocation('mktemp', argv);
      const { options, operands, occurrences } = parseArgs(argv, {
        directory: { short: 'd', long: 'directory' }, quiet: { short: 'q', long: 'quiet' }, dry: { short: 'u', long: 'dry-run' },
        parent: { short: 'p', value: true }, tmpdir: { long: 'tmpdir', value: 'optional' }, suffix: { long: 'suffix', value: true },
        legacy: { short: 't' },
      }, { command: 'mktemp' });
      if (operands.length > 1) fail('mktemp', 'at most one template is permitted');
      const template = operands[0] ?? 'tmp.XXXXXXXXXX', env = environment();
      const defaultParent = env instanceof Map && env.get('TMPDIR') ? String(env.get('TMPDIR')) : '.';
      const parentOccurrence = occurrences.filter(({ key }) => key === 'parent' || key === 'tmpdir').at(-1);
      const parentOption = parentOccurrence?.value === true ? '' : parentOccurrence?.value;
      let parent = null;
      if (options.legacy) {
        if (template.includes('/')) fail('mktemp', '-t requires a template without slashes');
        parent = env instanceof Map && env.get('TMPDIR') ? String(env.get('TMPDIR')) : parentOption || '.';
      } else if (!operands.length || parentOption !== undefined) {
        if (template.startsWith('/')) fail('mktemp', 'template must be relative when a temporary directory is selected');
        parent = parentOption || defaultParent;
      }
      if (parent !== null) utf8Length(parent, ctx.budget.remaining('pathBytes'));
      if (options.suffix?.includes('/')) fail('mktemp', 'suffix must not contain a slash');
      if (options.suffix !== undefined && !template.endsWith('X')) fail('mktemp', 'template must end in X when --suffix is used');
      const final = template.slice(template.lastIndexOf('/') + 1), lastX = final.lastIndexOf('X');
      let firstX = lastX;
      while (firstX > 0 && final[firstX - 1] === 'X') firstX--;
      const width = lastX < 0 ? 0 : lastX - firstX + 1;
      if (width < 3) fail('mktemp', 'template needs at least three consecutive X characters in its final component');
      const directoryPart = template.slice(0, template.length - final.length);
      const prefix = (parent === null ? '' : parent.replace(/\/+$/, '') + '/') + directoryPart + final.slice(0, firstX);
      const suffix = options.suffix ?? final.slice(lastX + 1);
      const pathBytes = utf8Length(prefix, ctx.budget.remaining('pathBytes')) + width + utf8Length(suffix, ctx.budget.remaining('pathBytes'));
      const outputBytes = pathBytes + 1;
      if (outputBytes > ctx.budget.remaining('outputBytes') || !ctx.budget.remaining('fragments')) fail('mktemp', 'output exceeds its resource limit');
      ctx.budget.spend('pathBytes', pathBytes);
      ctx.budget.spend('files');
      // Keep one candidate plus the growing random suffix alive at a time.
      ctx.budget.reserveRetained((prefix.length + suffix.length + width * 2) * 2 + 128);
      const attempts = limits.maxTempAttempts ?? 128;
      if (!Number.isSafeInteger(attempts) || attempts < 1) fail('mktemp', 'invalid temporary-name attempt limit');
      let last;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const name = prefix + await randomSuffix(width, ctx) + suffix;
        await ctx.budget.checkpoint();
        try {
          if (options.dry) {
            try { await io.stat(name, { follow: false, metadataOnly: true, rejectSymlinks: true }); last = ioError('EEXIST', 'temporary name already exists'); continue; }
            catch (error) { if (!(error instanceof IOFailure) || error.code !== 'ENOENT') throw error; }
          } else await io.create(name, { directory: !!options.directory });
          ctx.budget.check(); ctx.output.argument(name + '\n'); return result(ctx);
        } catch (error) {
          if (!(error instanceof IOFailure)) throw error;
          last = error;
          if (error.code === 'EEXIST') continue;
          if (!options.quiet) diagnostic(ctx, error, name);
          return result(ctx, true);
        }
      }
      if (!options.quiet) diagnostic(ctx, last || ioError('EEXIST', 'temporary-name attempts exhausted'), '');
      return result(ctx, true);
    },
    async truncate(argv) {
      const ctx = invocation('truncate', argv);
      const { options, operands } = parseArgs(argv, {
        size: { short: 's', long: 'size', value: true }, reference: { short: 'r', long: 'reference', value: true },
        noCreate: { short: 'c', long: 'no-create' }, blocks: { short: 'o', long: 'io-blocks' },
      }, { command: 'truncate' });
      nonemptyOperands('truncate', operands);
      if (options.blocks) fail('truncate', 'I/O-block units require unavailable backend block-size metadata');
      if (options.size === undefined && options.reference === undefined) fail('truncate', 'specify --size or --reference');
      let size = options.size === undefined ? null : parseSize(options.size);
      const maxBytes = limits.maxMutationBytes ?? ctx.limits.maxOutputBytes;
      for (const path of operands) { reservePath(ctx, path); ctx.budget.spend('files'); }
      if (options.reference !== undefined) {
        try {
          const stat = await io.stat(options.reference, { metadataOnly: true, rejectSymlinks: true }); ctx.budget.check();
          if (stat.type !== 'file') throw ioError('EISDIR', 'reference is not a regular file');
          if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw ioError('EIO', 'reference size is unavailable');
          const target = size ? truncateSize(stat.size, { ...size, maxBytes }) : stat.size;
          if (target > maxBytes) fail('truncate', 'reference size exceeds the mutation byte limit');
          size = { size: target, mode: 'set' };
        } catch (error) {
          if (!(error instanceof IOFailure)) {
            if (error?.code === 'EFBIG') fail('truncate', error.message);
            throw error;
          }
          diagnostic(ctx, error, options.reference); return result(ctx, true);
        }
      }
      if (size.mode === 'set' && size.size > maxBytes) fail('truncate', 'size exceeds the mutation byte limit');
      let failed = false, usedBytes = 0;
      for (const path of operands) {
        await ctx.budget.checkpoint();
        try {
          if (path.endsWith('/')) throw ioError('EISDIR', 'a trailing slash cannot identify a regular file');
          const changed = await io.truncate(path, { ...size, create: !options.noCreate, maxBytes: maxBytes - usedBytes });
          ctx.budget.check();
          if (changed.changed) {
            if (!Number.isSafeInteger(changed.size) || changed.size < 0 || changed.size > maxBytes - usedBytes) fail('truncate', 'backend violated the mutation byte limit');
            usedBytes += changed.size;
          }
        } catch (error) { if (!(error instanceof IOFailure)) throw error; diagnostic(ctx, error, path); failed = true; }
      }
      return result(ctx, failed);
    },
  };
}

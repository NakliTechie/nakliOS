// File-management commands: touch, mkdir, stat, mv, cp. Every operand is handled.
// `touch a b c` used to create only `a` and exit 0, and `mkdir`/`stat` ran as registry aliases
// that read their first operand and dropped the rest (found recording the Forge promo,
// 2026-09-29). Here each command takes every operand or refuses the form with exit 2.
// Flags are the documented subset; parseArgs refuses the rest.
import { parseArgs } from '../args.mjs';
import { IOFailure } from '../io.mjs';

const usage = (text) => ({ text, code: 2 });
const baseName = (path) => String(path).replace(/\/+$/, '').split('/').pop();
// A failure of one operand, reported the way coreutils words it.
const fail = (code, message) => new IOFailure('shell', { code, message });

export function createFileCommands(io) {
  // One result line per operand, in order. A failed operand prints its error and the rest still
  // run, as coreutils does; the exit is 1 when any failed.
  async function each(command, operands, fn) {
    const lines = []; let failed = false;
    for (const path of operands) {
      try { const line = await fn(path); if (line != null) lines.push(line); }
      catch (error) {
        if (!(error instanceof IOFailure)) throw error; // Stop and refusals stay control flow
        lines.push(`${command}: ${error.code}: ${error.message}`); failed = true;
      }
    }
    return { text: lines.join('\n'), code: failed ? 1 : 0 };
  }
  async function statOrNull(path) {
    try { return await io.stat(path); }
    catch (error) { if (error instanceof IOFailure && error.code === 'ENOENT') return null; throw error; }
  }
  // touch and mkdir (without -p) need the parent to exist, as coreutils does. They used to create
  // it, so a mistyped directory became a new tree with exit 0.
  async function requireParent(path) {
    const abs = io.resolve(path);
    const cut = abs.lastIndexOf('/');
    if (cut < 0) return;
    const parent = await statOrNull('/' + abs.slice(0, cut));
    if (!parent) throw fail('ENOENT', `no such directory: ${abs.slice(0, cut)}`);
    if (parent.type !== 'dir') throw fail('ENOTDIR', `not a directory: ${abs.slice(0, cut)}`);
  }

  // Recursive cp merges directories, but every leaf still passes through the governed
  // I/O face. In particular, -n skips an existing file without skipping new siblings.
  async function copyTree(from, to, noClobber) {
    const source = await io.stat(from);
    const destination = await statOrNull(to);
    if (source.type !== 'dir') {
      if (noClobber && destination) return;
      await io.copy(from, to, { overwrite: !noClobber });
      return;
    }
    if (destination && destination.type !== 'dir') throw fail('ENOTDIR', `cannot overwrite non-directory '${to}' with directory '${from}'`);
    if (!destination) await io.mkdir(to);
    const errors = [];
    for (const entry of await io.list(from)) {
      try { await copyTree('/' + entry.path, `${to.replace(/\/+$/, '')}/${entry.name}`, noClobber); }
      catch (error) {
        if (!(error instanceof IOFailure)) throw error;
        errors.push(`${entry.path}: ${error.code}: ${error.message}`);
      }
    }
    if (errors.length) throw fail('EIO', errors.join('\n'));
  }

  // mv/cp SOURCE DEST, or SOURCE... DIRECTORY (POSIX). A destination that is an existing
  // directory receives each source under its own name; with several sources it must be one.
  // An existing destination FILE is replaced, as coreutils does (it used to fail EEXIST).
  async function transfer(command, argv, spec, op) {
    const { options, operands } = parseArgs(argv, { ...spec,
      noClobber: { short: 'n', long: 'no-clobber' }, target: { short: 't', long: 'target-directory', value: true },
    }, { command });
    if (operands.length < (options.target !== undefined ? 1 : 2)) return usage(`${command}: missing ${operands.length ? 'destination' : 'file'} operand — ${command} SOURCE DEST, or ${command} SOURCE... DIRECTORY`);
    const sources = options.target !== undefined ? operands : operands.slice(0, -1);
    const dest = options.target ?? operands[operands.length - 1];
    const destination = await statOrNull(dest);
    const intoDir = destination?.type === 'dir';
    // Path resolution removes trailing slashes. Check their directory requirement
    // first so `cp source existing-file/` cannot replace an unintended file.
    if (dest.endsWith('/') && !intoDir) return { text: `${command}: target '${dest}' is not a directory`, code: 1 };
    if ((sources.length > 1 || options.target !== undefined) && !intoDir) return { text: `${command}: target '${dest}' is not a directory`, code: 1 };
    return each(command, sources, async (src) => {
      const source = await io.stat(src);
      if (src.endsWith('/') && source.type !== 'dir') throw fail('ENOTDIR', `not a directory: ${src}`);
      if (command === 'cp' && source.type === 'dir' && !options.recursive) throw fail('EISDIR', `omitting directory '${src}'; use cp -r`);
      const to = intoDir ? `${dest.replace(/\/+$/, '')}/${baseName(src)}` : dest;
      if (command === 'cp' && source.type === 'dir') {
        const fromPath = io.resolve(src), toPath = io.resolve(to);
        if (fromPath === toPath) throw fail('EINVAL', `source and destination are the same: ${fromPath}`);
        if (fromPath === '' || toPath.startsWith(fromPath + '/')) throw fail('EINVAL', `cannot copy ${fromPath || '/'} into itself: ${toPath}`);
        await requireParent(to);
        await copyTree(src, to, !!options.noClobber);
        return null;
      }
      if (options.noClobber && await statOrNull(to)) return null;
      await requireParent(to);
      await op(src, to, { overwrite: !options.noClobber });
      return null;
    });
  }

  return {
    // No mtime to update, so an existing path is left as it is.
    async touch(argv) {
      const { options, operands } = parseArgs(argv, { noCreate: { short: 'c', long: 'no-create' } }, { command: 'touch' });
      if (!operands.length) return usage('touch: missing file operand');
      return each('touch', operands, async (path) => {
        if (await statOrNull(path)) return null;
        if (options.noCreate) return null;
        await requireParent(path);
        await io.write(path, '');
        return null;
      });
    },
    // Without -p an existing path is an error, as in coreutils; `mkdir d || …` used to never
    // take its fallback. With -p an existing directory is fine and parents are made.
    async mkdir(argv) {
      const { options, operands } = parseArgs(argv, { parents: { short: 'p', long: 'parents' }, verbose: { short: 'v', long: 'verbose' } }, { command: 'mkdir' });
      if (!operands.length) return usage('mkdir: missing operand');
      return each('mkdir', operands, async (path) => {
        const created = [];
        if (options.verbose) {
          const parts = io.resolve(path).split('/');
          const candidates = options.parents ? parts.map((_, i) => '/' + parts.slice(0, i + 1).join('/')) : [path];
          for (const candidate of candidates) if (!(await statOrNull(candidate))) created.push(candidate.replace(/^\//, ''));
        }
        if (!options.parents) {
          if (await statOrNull(path)) throw fail('EEXIST', `already exists: ${io.resolve(path)}`);
          await requireParent(path);
        }
        await io.mkdir(path, { createParents: !!options.parents });
        return options.verbose ? created.map((p) => `mkdir: created directory '${p}'`).join('\n') : null;
      });
    },
    // `TYPE SIZE`; with several operands each line leads with its path.
    async stat(argv) {
      const { options, operands } = parseArgs(argv, { format: { short: 'c', long: 'format', value: true } }, { command: 'stat' });
      if (!operands.length) return usage('stat: missing operand');
      if (options.format !== undefined && options.format.replace(/%[nsFYy%]/g, '').includes('%')) return usage('stat: unsupported format; stat -c supports %n %s %F %Y %y %%');
      return each('stat', operands, async (path) => {
        const st = await io.stat(path);
        if (options.format !== undefined) return options.format.replace(/%[nsFYy%]/g, (f) => ({
          '%n': path, '%s': st.size, '%F': st.type === 'dir' ? 'directory' : st.type === 'file' ? 'regular file' : st.type,
          '%Y': Math.floor((st.mtimeMs || 0) / 1000), '%y': new Date(st.mtimeMs || 0).toISOString(), '%%': '%',
        })[f]);
        return `${operands.length > 1 ? path + ': ' : ''}${st.type} ${st.size}`;
      });
    },
    mv: (argv) => transfer('mv', argv, {}, io.move),
    // Directory copies require an explicit recursive flag.
    cp: (argv) => transfer('cp', argv, { recursive: { short: ['r', 'R'], long: 'recursive' } }, io.copy),
  };
}

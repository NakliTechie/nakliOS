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

  // mv/cp SOURCE DEST, or SOURCE... DIRECTORY (POSIX). A destination that is an existing
  // directory receives each source under its own name; with several sources it must be one.
  // An existing destination FILE is replaced, as coreutils does (it used to fail EEXIST).
  async function transfer(command, argv, spec, op) {
    const { operands } = parseArgs(argv, spec, { command });
    if (operands.length < 2) return usage(`${command}: missing ${operands.length ? 'destination' : 'file'} operand — ${command} SOURCE DEST, or ${command} SOURCE... DIRECTORY`);
    const sources = operands.slice(0, -1), dest = operands[operands.length - 1];
    const intoDir = (await statOrNull(dest))?.type === 'dir';
    if (sources.length > 1 && !intoDir) return { text: `${command}: target '${dest}' is not a directory`, code: 1 };
    return each(command, sources, (src) => op(src, intoDir ? `${dest.replace(/\/+$/, '')}/${baseName(src)}` : dest, { overwrite: true }).then(() => null));
  }

  return {
    // No mtime to update, so an existing path is left as it is.
    async touch(argv) {
      const { operands } = parseArgs(argv, {}, { command: 'touch' });
      if (!operands.length) return usage('touch: missing file operand');
      return each('touch', operands, async (path) => {
        if (await statOrNull(path)) return null;
        await requireParent(path);
        await io.write(path, '');
        return null;
      });
    },
    // Without -p an existing path is an error, as in coreutils; `mkdir d || …` used to never
    // take its fallback. With -p an existing directory is fine and parents are made.
    async mkdir(argv) {
      const { options, operands } = parseArgs(argv, { parents: { short: 'p', long: 'parents' } }, { command: 'mkdir' });
      if (!operands.length) return usage('mkdir: missing operand');
      return each('mkdir', operands, async (path) => {
        if (!options.parents) {
          if (await statOrNull(path)) throw fail('EEXIST', `already exists: ${io.resolve(path)}`);
          await requireParent(path);
        }
        await io.mkdir(path, { createParents: !!options.parents });
        return null;
      });
    },
    // `TYPE SIZE`; with several operands each line leads with its path.
    async stat(argv) {
      const { operands } = parseArgs(argv, {}, { command: 'stat' });
      if (!operands.length) return usage('stat: missing operand');
      return each('stat', operands, async (path) => {
        const st = await io.stat(path);
        return `${operands.length > 1 ? path + ': ' : ''}${st.type} ${st.size}`;
      });
    },
    mv: (argv) => transfer('mv', argv, {}, io.move),
    // The workspace copies a directory whole; -r/-R are accepted and change nothing.
    cp: (argv) => transfer('cp', argv, { recursive: { short: ['r', 'R'], long: 'recursive' } }, io.copy),
  };
}

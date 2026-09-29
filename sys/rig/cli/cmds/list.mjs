// Directory presentation stays separate from storage. The terminal alone applies
// LISTING_MAX_ENTRIES; a pipe or redirect receives the entire listing.
import { parseArgs } from '../args.mjs';
import { IOFailure } from '../io.mjs';

export function createListCommands(io) {
  return {
    async ls(argv) {
      const { options, operands, occurrences } = parseArgs(argv, Object.fromEntries([...'Ral1AdhStrF'].map((short) => [short, { short }])), { command: 'ls' });
      const targets = operands.length ? operands : ['.'];
      const errors = [], files = [], directories = [];
      let count = 0;
      const order = occurrences.filter(({ key }) => key === 'S' || key === 't').at(-1)?.key;
      const human = (size) => {
        let n = size, unit = 0; while (n >= 1024 && unit < 6) { n /= 1024; unit++; }
        return unit ? (n < 10 ? n.toFixed(1) : Math.ceil(n)) + 'KMGTPE'[unit - 1] : String(n);
      };
      const display = (entry) => {
        const name = entry.name + (options.F && entry.type === 'dir' ? '/' : '');
        return options.l ? `${entry.type === 'dir' ? 'd' : '-'} ${options.h ? human(entry.size || 0) + ' ' : ''}${name}` : name;
      };
      const compare = (a, b) => {
        const difference = order === 'S' ? b.size - a.size : order === 't' ? b.mtimeMs - a.mtimeMs : 0;
        const alphabetical = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        return (difference || alphabetical) * (options.r ? -1 : 1);
      };
      const enrich = async (entry) => {
        if (options.h || order) {
          const metadata = await io.stat('/' + entry.path);
          // stat dereferences links. Metadata flags must never turn a link into
          // a directory for recursive traversal (a link may point to its parent).
          return { ...entry, size: metadata.size, mtimeMs: metadata.mtimeMs };
        }
        return entry;
      };
      const listing = async (path, label, withHeader) => {
        let entries = await io.list(path);
        entries = entries.filter((entry) => options.a || options.A || !entry.name.startsWith('.'));
        entries = await Promise.all(entries.map(enrich));
        entries.sort(compare); count += entries.length;
        const body = entries.map(display).join(options.l || options['1'] || options.R ? '\n' : '  ');
        directories.push(withHeader ? `${label}:${body ? '\n' + body : ''}` : body);
        if (options.R) {
          for (const entry of entries) if (entry.type === 'dir') await listing('/' + entry.path, entry.path || '.', true);
        }
      };
      for (const target of targets) {
        try {
          const st = await io.stat(target);
          if (st.type !== 'dir' || options.d) { files.push({ ...st, name: target, path: io.resolve(target) }); count++; }
          else await listing(target, io.resolve(target) || '.', options.R || targets.length > 1);
        } catch (error) {
          if (!(error instanceof IOFailure)) throw error;
          errors.push(`ls: ${target}: ${error.code}`);
        }
      }
      files.sort(compare);
      const blocks = [...errors, files.map(display).join('\n'), ...directories].filter((s) => s !== '');
      return { text: blocks.join(options.R || targets.length > 1 ? '\n\n' : '\n'), code: errors.length ? 1 : 0, listing: { tool: 'ls', entries: count } };
    },
  };
}

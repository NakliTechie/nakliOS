// Public archive commands. Containers validate completely before extraction or
// replacement. File operations retain the shell's grants, staging and Stop owner.
import { ArgError, parseArgs } from '../args.mjs';
import { createArchiveContext } from './archive-common.mjs';
import { archiveInput, gatherEntries, selectors, prepareExtraction, applyExtraction, saveArchive, existingArchive } from './archive-files.mjs';
import { gzipBytes, gunzipBytes } from './archive-compression.mjs';
import { tarArguments, parseTar, createTar } from './archive-tar.mjs';
import { parseZip, createZip } from './archive-zip.mjs';

const flag = (short, long, value = false) => ({ ...(short ? { short } : {}), ...(long ? { long } : {}), ...(value ? { value } : {}) });
const failArgs = (ctx, message) => { throw new ArgError(`${ctx.command}: ${message}`); };
function selected(ctx, entries, operands, exclude = [], { descendants = false, firstMatch = false } = {}) {
  const omit = selectors(ctx, exclude, { basename: true, descendants: true });
  const predicates = operands.map((operand) => selectors(ctx, [operand], { descendants }));
  const found = new Set(), chosen = [];
  for (const entry of entries) {
    let matched = !predicates.length;
    for (let i = 0; i < predicates.length; i++) if (predicates[i](entry.name)) {
      found.add(i); matched = true;
      if (firstMatch) break;
    }
    // Tar assigns an entry to its first matching operand, before exclusions.
    // A later operand shadowed completely by earlier ones remains unmatched.
    if (matched && !omit(entry.name)) chosen.push(entry);
  }
  for (let i = 0; i < predicates.length; i++) if (!found.has(i)) ctx.fail(`member not found: ${operands[i]}`);
  return chosen;
}
async function tar(ctx, io, authorize, argv, diagnostics) {
  const options = tarArguments(ctx, io, argv);
  for (const path of options.directories) {
    const current = await existingArchive(ctx, io, '/' + path);
    if (!current || current.type !== 'dir') ctx.fail(`-C requires an existing directory: ${path || '/'}`);
  }
  if (options.mode === 'c') {
    const entries = await gatherEntries(ctx, io, options.sources, { exclude: options.exclude,
      omitPath: options.archive === '-' ? undefined : io.resolve(options.archive) });
    let bytes = await createTar(ctx, entries); if (options.gzip) bytes = await gzipBytes(ctx, bytes);
    await saveArchive(ctx, io, authorize, options.archive, bytes);
    if (options.verbose) for (const entry of entries) diagnostics.argument((entry.name || '.') + (entry.directory ? '/' : '') + '\n');
    return;
  }
  let bytes = await archiveInput(ctx, io, options.archive);
  if (options.gzip) bytes = await gunzipBytes(ctx, bytes);
  const entries = await parseTar(ctx, bytes, { expanded: options.gzip });
  const chosen = selected(ctx, entries, options.sources.map((source) => source.operand), options.exclude, { descendants: true, firstMatch: true });
  if (options.mode === 't') {
    for (const entry of chosen) {
      await ctx.budget.checkpoint(); const name = (entry.name || '.') + (entry.directory ? '/' : '');
      ctx.output.argument(options.verbose ? `${entry.directory ? 'd' : '-'} ${entry.data.length} ${name}\n` : name + '\n');
    }
    return;
  }
  const destinations = options.sources.map((source) => ({ match: selectors(ctx, [source.operand], { descendants: true }), directory: source.directory }));
  const stripped = chosen.map((entry) => ({ ...entry, extractionDirectory: destinations.find((item) => item.match(entry.name))?.directory ?? options.directory })).flatMap((entry) => {
    if (!options.strip) return [entry];
    const parts = entry.name.split('/'); return parts.length <= options.strip ? [] : [{ ...entry, name: parts.slice(options.strip).join('/') }];
  });
  const actions = await prepareExtraction(ctx, io, authorize, stripped, { directory: '/' + options.directory });
  await applyExtraction(ctx, io, actions);
  if (options.verbose) for (const entry of stripped) diagnostics.argument((entry.name || '.') + (entry.directory ? '/' : '') + '\n');
}
async function gzip(ctx, io, authorize, argv, diagnostics) {
  const { options, operands, occurrences } = parseArgs(argv, { stdout: flag('c', 'stdout'), decompress: flag('d', 'decompress'), keep: flag('k', 'keep'),
    force: flag('f', 'force'), quiet: flag('q', 'quiet'), verbose: flag('v', 'verbose'), test: flag('t', 'test'), noName: flag('n', 'no-name') }, { command: ctx.command });
  const decompress = ctx.command !== 'gzip' || options.decompress || options.test;
  const stdout = ctx.command === 'zcat' || options.stdout || !operands.length;
  let verbose = false; for (const item of occurrences) { if (item.key === 'quiet') verbose = false; if (item.key === 'verbose') verbose = true; }
  const conversions = [];
  for (const path of operands.length ? operands : ['-']) {
    await ctx.budget.checkpoint(); let destination = '-';
    if (!stdout && path !== '-' && !options.test) {
      const metadata = await existingArchive(ctx, io, path);
      if (!metadata || metadata.type !== 'file') ctx.fail(`expected a regular input file: ${path}`);
      if (decompress) {
        if (path.endsWith('.tgz')) destination = path.slice(0, -4) + '.tar';
        else if (path.endsWith('.gz') && path.length > 3) destination = path.slice(0, -3);
        else ctx.fail(`unknown compressed suffix: ${path}; use -c for stdout`);
      } else {
        if (path.endsWith('.gz') && !options.force) ctx.fail(`input already has .gz suffix: ${path}`);
        destination = path + '.gz';
      }
    }
    const bytes = await archiveInput(ctx, io, path), data = await (decompress ? gunzipBytes(ctx, bytes) : gzipBytes(ctx, bytes));
    conversions.push({ path, destination, data, original: bytes, inputSize: bytes.length });
  }
  // Stage no writes until every transform and destination has passed validation.
  for (const conversion of conversions) if (!options.test && conversion.destination !== '-') {
    const target = io.resolve(conversion.destination), parts = target.split('/'), name = parts.pop();
    conversion.actions = await prepareExtraction(ctx, io, authorize, [{ name, directory: false, data: conversion.data }],
      { directory: '/' + parts.join('/'), overwrite: options.force ? 'yes' : 'no' });
  }
  for (const conversion of conversions) {
    await ctx.budget.checkpoint();
    if (!options.test) {
      if (conversion.destination === '-') ctx.output.append(conversion.data);
      else {
        await applyExtraction(ctx, io, conversion.actions);
        if (!options.keep) { await io.remove(conversion.path, { follow: false, metadataOnly: true, kind: 'non-dir', expectedData: conversion.original }); ctx.budget.check(); }
      }
    }
    if (verbose) diagnostics.argument(`${conversion.path}: ${options.test ? 'OK' : conversion.inputSize + ' -> ' + conversion.data.length + ' bytes'}\n`);
  }
}
async function zip(ctx, io, authorize, argv, diagnostics) {
  const { options, operands } = parseArgs(argv, { recursive: flag('r', 'recurse-paths'), quiet: flag('q', 'quiet'), stored: flag('0'), delete: flag('d', 'delete') }, { command: 'zip' });
  if (operands.length < 2) failArgs(ctx, 'expected ARCHIVE and input paths or deletion patterns');
  let [archive, ...paths] = operands;
  if (archive !== '-' && !archive.split('/').at(-1).includes('.')) archive += '.zip';
  if (options.delete && options.recursive) failArgs(ctx, '-r conflicts with archive entry deletion');
  const current = archive === '-' ? null : await existingArchive(ctx, io, archive);
  const original = current ? await archiveInput(ctx, io, archive) : undefined;
  let entries = original ? await parseZip(ctx, original) : [];
  if (options.delete) {
    if (!current) ctx.fail('archive does not exist');
    const match = selectors(ctx, paths);
    if (!entries.some((entry) => match(entry.name))) ctx.fail('no archive entries match the deletion patterns');
    entries = entries.filter((entry) => !match(entry.name));
  } else {
    const additions = await gatherEntries(ctx, io, paths.map((operand) => ({ operand })), { recursive: !!options.recursive,
      omitPath: archive === '-' ? undefined : io.resolve(archive) });
    for (const entry of additions) ctx.expand(entry.data.length);
    const positions = new Map(entries.map((entry, index) => [entry.name, index]));
    for (const entry of additions) {
      if (positions.has(entry.name)) entries[positions.get(entry.name)] = entry;
      else { positions.set(entry.name, entries.length); entries.push(entry); }
    }
  }
  const bytes = await createZip(ctx, entries, { stored: !!options.stored });
  await saveArchive(ctx, io, authorize, archive, bytes, { expectedData: original });
  if (!options.quiet) diagnostics.argument(`${archive}: ${entries.length} entries\n`);
}
async function unzip(ctx, io, authorize, argv, diagnostics) {
  const { options, operands, occurrences } = parseArgs(argv, { list: flag('l'), directory: flag('d', null, true), overwrite: flag('o'), skip: flag('n'), stdout: flag('p'), quiet: flag('q') }, { command: 'unzip' });
  if (!operands.length) failArgs(ctx, 'expected ARCHIVE [MEMBER...]');
  if (options.list && options.stdout) failArgs(ctx, '-l conflicts with -p');
  const [archive, ...patterns] = operands, entries = await parseZip(ctx, await archiveInput(ctx, io, archive));
  const chosen = selected(ctx, entries, patterns);
  if (options.list) {
    ctx.output.argument('   Length  Name\n');
    for (const entry of chosen) { await ctx.budget.checkpoint(); ctx.output.argument(`${String(entry.data.length).padStart(9)}  ${entry.name}${entry.directory ? '/' : ''}\n`); }
  } else if (options.stdout) {
    for (const entry of chosen) { await ctx.budget.checkpoint(); if (!entry.directory) ctx.output.append(entry.data); }
  } else {
    let overwrite = 'no';
    for (const item of occurrences) { if (item.key === 'overwrite') overwrite = 'yes'; if (item.key === 'skip') overwrite = 'skip'; }
    const actions = await prepareExtraction(ctx, io, authorize, chosen, { directory: options.directory ?? '.', overwrite });
    await applyExtraction(ctx, io, actions);
    if (!options.quiet) for (const action of actions) if (action.operation === 'write') diagnostics.argument(`extracting: ${action.path}\n`);
  }
}
export function createArchiveCommands(io, { signal = () => null, authorize, limits = {} } = {}) {
  const operations = { tar, gzip, gunzip: gzip, zcat: gzip, zip, unzip };
  return Object.fromEntries(Object.entries(operations).map(([command, operation]) => [command, async (argv, stdin = '') => {
    const ctx = createArchiveContext({ command, io, stdin, signal, limits }), diagnostics = ctx.output.fork();
    ctx.arguments(argv); await operation(ctx, io, authorize, argv, diagnostics);
    const stdout = ctx.output.finish(), stderr = diagnostics.finish();
    return { text: stdout, stdout, stderr, code: 0, raw: true };
  }]));
}

import { ArgError, parseArgs } from '../args.mjs';
import { IOFailure, autoData, renderData } from '../io.mjs';
import { createCanonicalContext } from './canonical-input.mjs';
import { parseCount, utf8Length } from './u2-common.mjs';
import { ALPHABETS, InvalidEncoding, transformEncoding } from './encoding-codecs.mjs';

export function createEncodingCommands(io, { signal = () => null, limits = {} } = {}) {
  return Object.fromEntries(['base64', 'base32', 'basenc'].map((command) => [command, async (argv, stdin = '') => {
    const ctx = createCanonicalContext({ command, io, stdin, signal, limits });
    for (const arg of argv) ctx.budget.spend('argumentBytes', utf8Length(arg) + 1);
    const spec = { decode: { short: 'd', long: 'decode' }, ignore: { short: 'i', long: 'ignore-garbage' }, wrap: { short: 'w', long: 'wrap', value: true } };
    if (command === 'basenc') for (const name of Object.keys(ALPHABETS)) spec[name] = { long: name };
    const { options, operands, occurrences } = parseArgs(argv, spec, { command });
    if (operands.length > 1) throw new ArgError(`${command}: expected at most one input file`);
    let format = command;
    if (command === 'basenc') {
      const selected = occurrences.filter((item) => Object.hasOwn(ALPHABETS, item.key));
      if (!selected.length) throw new ArgError('basenc: an encoding selector is required');
      if (new Set(selected.map((item) => item.key)).size > 1) throw new ArgError('basenc: encoding selectors conflict');
      format = selected.at(-1).key;
    }
    const wrap = options.wrap === undefined ? 76 : parseCount(options.wrap, { command, label: 'wrap width' });
    let code = 0, diagnostic = '';
    try {
      const [input] = ctx.inputs.operands(operands), bytes = await (await input.open()).rest();
      await transformEncoding(ctx, bytes, { format, decode: !!options.decode, ignore: !!options.ignore, wrap });
    } catch (error) {
      if (!(error instanceof IOFailure) && !(error instanceof InvalidEncoding)) throw error;
      code = 1; diagnostic = `${command}: ${error instanceof IOFailure ? error.code + ': ' : ''}${error.message}\n`;
    }
    const text = ctx.output.finish();
    return { text, stdout: text, stderr: diagnostic, code, raw: true, ...(diagnostic ? { displayText: diagnostic + renderData(autoData(text)) } : {}) };
  }]));
}

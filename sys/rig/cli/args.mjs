// Shared getopt-style parsing for shell command modules. This module does not
// expand words or interpret values: the shell supplies argv; commands validate
// their own numbers, regular expressions, paths, and other argument values.

export class ArgError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgError';
    this.code = 2;
    this.text = message;
  }
}

function aliases(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function compileSpec(spec) {
  const flags = new Map();
  for (const [key, definition] of Object.entries(spec)) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new TypeError(`invalid option definition: ${key}`);
    }
    const { value = false, multiple = false } = definition;
    if (![false, true, 'optional'].includes(value) || typeof multiple !== 'boolean') {
      throw new TypeError(`invalid option definition: ${key}`);
    }
    const shorts = aliases(definition.short);
    const longs = aliases(definition.long);
    if (!shorts.length && !longs.length) throw new TypeError(`option has no flags: ${key}`);
    const add = (flag) => {
      if (flags.has(flag)) throw new TypeError(`duplicate option flag: ${flag}`);
      flags.set(flag, { key, value, multiple });
    };
    for (const short of shorts) {
      if (typeof short !== 'string' || !/^[^\s=-]$/.test(short)) {
        throw new TypeError(`invalid short flag for: ${key}`);
      }
      add(`-${short}`);
    }
    for (const long of longs) {
      if (typeof long !== 'string' || !/^[^\s=-][^\s=]*$/.test(long)) {
        throw new TypeError(`invalid long flag for: ${key}`);
      }
      add(`--${long}`);
    }
  }
  return flags;
}

/** Return supported spellings in definition order, suitable for help/errors. */
export function formatSupportedFlags(spec) {
  return [...compileSpec(spec).keys()].join(' ');
}

/**
 * Parse already-tokenized command arguments.
 *
 *   parseArgs(argv, {
 *     number: { short: 'n', long: 'number' },
 *     expression: { short: 'e', long: 'expression', value: true, multiple: true },
 *     inPlace: { short: 'i', long: 'in-place', value: 'optional' },
 *   }, { command: 'example' });
 *
 * Each result key has one or more short/long aliases (a string or array).
 * Boolean flags yield true. Required values accept attached or separate words.
 * Optional values must attach: -iSUFFIX / --in-place=SUFFIX; a bare flag yields
 * true without consuming the next operand. Repeated flags replace their value,
 * unless multiple:true collects every occurrence in an array.
 *
 * Returns { options, operands, occurrences }. options has no prototype; absent
 * flags have no property. occurrences preserves cross-option ordering, useful
 * for commands that combine -e and -f. Each entry is { key, flag, value }.
 * Options may follow operands unless stopAtOperand:true is set (for wrappers
 * such as env). A lone '-' is an operand; '--' ends option parsing.
 * User argument errors throw ArgError with code:2 and text for shell results.
 */
export function parseArgs(argv, spec, { command = 'command', stopAtOperand = false } = {}) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('argv must be an array of strings');
  }
  const flags = compileSpec(spec);
  const supported = [...flags.keys()].join(' ') || 'no flags';
  const options = Object.create(null);
  const operands = [];
  const occurrences = [];
  const fail = (reason) => {
    throw new ArgError(`${command}: ${reason}; ${command} supports ${supported}`);
  };
  const record = (flag, option, value) => {
    if (option.multiple) {
      (options[option.key] ??= []).push(value);
    } else {
      options[option.key] = value;
    }
    occurrences.push({ key: option.key, flag, value });
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      operands.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      if (stopAtOperand) {
        operands.push(...argv.slice(i));
        break;
      }
      operands.push(arg);
      continue;
    }

    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const flag = equals === -1 ? arg : arg.slice(0, equals);
      const option = flags.get(flag);
      if (!option) fail(`unsupported flag ${flag}`);
      let value = true;
      if (equals !== -1) {
        if (!option.value) fail(`flag ${flag} does not take a value`);
        value = arg.slice(equals + 1);
      } else if (option.value === true) {
        if (i + 1 === argv.length) fail(`flag ${flag} requires a value`);
        value = argv[++i];
      }
      record(flag, option, value);
      continue;
    }

    for (let offset = 1; offset < arg.length; offset++) {
      const flag = `-${arg[offset]}`;
      const option = flags.get(flag);
      if (!option) fail(`unsupported flag ${flag}`);
      if (!option.value) {
        record(flag, option, true);
        continue;
      }
      let value = true;
      if (offset + 1 < arg.length) {
        value = arg.slice(offset + 1);
      } else if (option.value === true) {
        if (i + 1 === argv.length) fail(`flag ${flag} requires a value`);
        value = argv[++i];
      }
      record(flag, option, value);
      break; // A value-taking short flag consumes the rest of the bundle.
    }
  }
  return { options, operands, occurrences };
}

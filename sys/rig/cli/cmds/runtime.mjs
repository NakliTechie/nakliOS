import { ArgError, parseArgs } from '../args.mjs';
import { createU2Context, parseCount, utf8Length } from './u2-common.mjs';
import { resolveVirtualPath } from './path-resolution.mjs';
import { compileDateFormat, parseDateInput, writeDate } from './date-format.mjs';

const flag = (short, long, value = false) => ({ ...(short ? { short } : {}), ...(long ? { long } : {}), ...(value ? { value } : {}) });
const fail = (ctx, text) => { throw new ArgError(`${ctx.command}: ${text}`); };
const finish = (ctx, code = 0) => ({ text: ctx.output.finish(), code, raw: true });
const facts = { kernel: 'nakliOS', node: 'workspace', release: 'virtual', version: 'JavaScript', machine: 'javascript', processor: 'unknown', hardware: 'unknown', os: 'nakliOS' };

async function durationMilliseconds(ctx, value) {
  const parsed = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(value);
  if (!parsed) fail(ctx, 'invalid nonnegative duration');
  const multiplier = { '': 1000, s: 1000, m: 60000, h: 3600000, d: 86400000 }[parsed[2]];
  const [wholeText, fraction = ''] = parsed[1].split('.');
  const whole = wholeText.replace(/^0+/, '') || '0';
  if (whole.length > 6) fail(ctx, 'duration exceeds the 300-second limit');
  const integral = Number(whole) * multiplier;
  if (integral > 300000) fail(ctx, 'duration exceeds the 300-second limit');
  // Multiply decimal fractional digits from right to left. Carry is the exact
  // whole-millisecond contribution; discarded nonzero digits require rounding up.
  let carry = 0, remainder = false;
  for (let at = fraction.length - 1; at >= 0; at--) {
    if (at % 256 === 0) await ctx.budget.checkpoint();
    const product = Number(fraction[at]) * multiplier + carry;
    remainder ||= product % 10 !== 0;
    carry = Math.floor(product / 10);
  }
  const milliseconds = integral + carry;
  if (milliseconds > 300000 || milliseconds === 300000 && remainder) fail(ctx, 'duration exceeds the 300-second limit');
  return milliseconds + (remainder ? 1 : 0);
}

export function createRuntimeCommands(io, { signal = () => null, limits = {}, now = Date.now, environment = () => new Map(), runWithTimeout } = {}) {
  const context = (command, argv) => {
    const ctx = createU2Context({ command, io, signal, limits });
    for (const arg of argv) ctx.budget.spend('argumentBytes', utf8Length(arg) + 1);
    return ctx;
  };
  const noOperands = (ctx, operands) => { if (operands.length) fail(ctx, 'unexpected operand'); };
  return {
    async date(argv) {
      const ctx = context('date', argv);
      const { options, operands } = parseArgs(argv, { utc: flag('u', ['utc', 'universal']), date: flag('d', 'date', true),
        reference: flag('r', 'reference', true), iso: flag('I', 'iso-8601', 'optional'), email: flag('R', 'rfc-email'), rfc3339: flag(null, 'rfc-3339', true) }, { command: 'date' });
      if (operands.length > 1 || operands.some((operand) => !operand.startsWith('+'))) fail(ctx, 'expected one +FORMAT; setting the clock is unsupported');
      if (options.date !== undefined && options.reference !== undefined) fail(ctx, '--date and --reference conflict');
      if ([options.iso !== undefined, !!options.email, options.rfc3339 !== undefined, operands.length > 0].filter(Boolean).length > 1) fail(ctx, 'output format options conflict');
      const tz = environment().get('TZ');
      if (!options.utc && tz !== undefined && !['UTC', 'UTC0', 'GMT', 'GMT0'].includes(tz)) fail(ctx, 'virtual TZ overrides support UTC or GMT only');
      const utc = !!options.utc || tz !== undefined;
      let format = operands.length ? operands[0].slice(1) : '%a %b %e %H:%M:%S %Z %Y';
      if (options.iso !== undefined) {
        const precision = options.iso === true ? 'date' : options.iso;
        const formats = { date: '%F', hours: '%FT%H%:z', minutes: '%FT%H:%M%:z', seconds: '%FT%T%:z', ns: '%FT%T,%N%:z' };
        if (!Object.hasOwn(formats, precision)) fail(ctx, 'invalid ISO timespec');
        format = formats[precision];
      }
      if (options.rfc3339 !== undefined) {
        const formats = { date: '%F', seconds: '%F %T%:z', ns: '%F %T.%N%:z' };
        if (!Object.hasOwn(formats, options.rfc3339)) fail(ctx, 'invalid RFC3339 timespec');
        format = formats[options.rfc3339];
      }
      if (options.email) format = '%a, %d %b %Y %T %z';
      const compiled = await compileDateFormat(ctx, format);
      try {
        let date;
        if (options.date !== undefined) date = parseDateInput(options.date, utc);
        else if (options.reference !== undefined) {
          const { stat } = await resolveVirtualPath(io, options.reference, { context: ctx, mode: 'existing', followFinal: true });
          if (!Number.isFinite(stat?.mtimeMs)) fail(ctx, 'reference modification timestamp is unavailable');
          date = new Date(stat.mtimeMs);
        } else date = new Date(now());
        ctx.budget.check(); await writeDate(ctx, date, compiled, utc);
        return finish(ctx);
      } finally { compiled.release(); }
    },
    uname(argv) {
      const ctx = context('uname', argv);
      const { options, operands } = parseArgs(argv, { all: flag('a', 'all'), kernel: flag('s', 'kernel-name'), node: flag('n', 'nodename'), release: flag('r', 'kernel-release'),
        version: flag('v', 'kernel-version'), machine: flag('m', 'machine'), processor: flag('p', 'processor'), hardware: flag('i', 'hardware-platform'), os: flag('o', 'operating-system') }, { command: 'uname' });
      noOperands(ctx, operands);
      const selected = Object.keys(facts).filter((name) => options.all || options[name]);
      ctx.output.argument((selected.length ? selected : ['kernel']).map((name) => facts[name]).join(' ') + '\n'); return finish(ctx);
    },
    arch(argv) {
      const ctx = context('arch', argv); noOperands(ctx, parseArgs(argv, {}, { command: 'arch' }).operands);
      ctx.output.argument(facts.machine + '\n'); return finish(ctx);
    },
    whoami(argv) {
      const ctx = context('whoami', argv); noOperands(ctx, parseArgs(argv, {}, { command: 'whoami' }).operands);
      ctx.output.argument('workspace\n'); return finish(ctx);
    },
    id(argv) {
      const ctx = context('id', argv);
      const { options, operands } = parseArgs(argv, { user: flag('u', 'user'), name: flag('n', 'name'), group: flag('g', 'group'), groups: flag('G', 'groups'), real: flag('r', 'real'), zero: flag('z', 'zero') }, { command: 'id' });
      if (operands.length > 1 || operands.length && operands[0] !== 'workspace') fail(ctx, 'only the virtual workspace principal is available');
      if (options.group || options.groups || options.real || options.user && !options.name || options.name && !options.user) fail(ctx, 'POSIX uid/gid and host identity queries are unavailable');
      if (options.zero && !options.user) fail(ctx, '--zero requires --user --name');
      ctx.output.argument(options.user ? 'workspace' : 'user=workspace (virtual; POSIX uid/gid unavailable)'); ctx.output.byte(options.zero ? 0 : 10); return finish(ctx);
    },
    nproc(argv) {
      const ctx = context('nproc', argv);
      const { options, operands } = parseArgs(argv, { all: flag(null, 'all'), ignore: flag(null, 'ignore', true) }, { command: 'nproc' });
      noOperands(ctx, operands);
      if (options.ignore !== undefined) parseCount(options.ignore, { command: 'nproc', label: 'ignored execution lanes' });
      ctx.output.argument('1\n'); return finish(ctx);
    },
    async timeout(argv, stdin = '') {
      const ctx = context('timeout', argv);
      const { options, operands } = parseArgs(argv, { preserve: flag(null, 'preserve-status'), verbose: flag('v', 'verbose') }, { command: 'timeout', stopAtOperand: true });
      if (operands.length < 2) fail(ctx, 'expected DURATION COMMAND [ARGS...]');
      const milliseconds = await durationMilliseconds(ctx, operands[0]);
      if (typeof runWithTimeout !== 'function') fail(ctx, 'scoped cancellation capability is unavailable');
      const result = await runWithTimeout(milliseconds, operands.slice(1), stdin);
      ctx.budget.check();
      if (!result.timedOut) return result.result;
      return { text: new Uint8Array(), raw: true, code: options.preserve ? 130 : 124,
        ...(options.verbose ? { displayText: 'timeout: command timed out' } : {}) };
    },
  };
}

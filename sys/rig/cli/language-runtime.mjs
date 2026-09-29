// Async AST execution stays inside the shell's owned confirmation coroutine.
import { LanguageError, languageLimits, assignmentWord } from './language-parser.mjs';
import { createWordExpander } from './language-words.mjs';
import { commandStreams, lineData, resultEvents, streamResult } from './command-streams.mjs';
import { IOFailure, concatData, toBytes, autoData, renderData } from './io.mjs';
import { ShellInterrupted } from './execution.mjs';
import { isByteStream, ownByteStream, collectByteStream, closeByteStream } from './cmds/streams.mjs';
import { utf8Length, createU2Context } from './cmds/u2-common.mjs';
import { resolveVirtualPath } from './cmds/path-resolution.mjs';

export class LanguageFlow extends Error {
  constructor(kind, level = 1, code = 0) { super(kind); this.kind = kind; this.level = level; this.code = code; this.shellFlow = true; }
}
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const noInput = new Set(['echo', 'printf', 'pwd', 'cd', 'true', 'false', ':', 'clear', 'history', 'help', 'export', 'unset',
  'local', 'shift', 'set', 'return', 'break', 'continue', 'date', 'uname', 'whoami', 'id', 'nproc', 'arch', 'sleep',
  'ls', 'dir', 'vdir', 'stat', 'touch', 'mkdir', 'cp', 'mv', 'rm', 'chmod', 'readlink', 'realpath', 'rmdir', 'mktemp',
  'truncate', 'unlink', 'du', 'tree', 'file', 'seq', 'printenv', 'yes', 'basename', 'dirname', 'which', 'test', '[']);
const reader = (data = '') => ({ data, at: 0, closed: false });
const buffer = (events, channel) => ({ kind: 'buffer', events, channel });
const closed = Object.freeze({ kind: 'closed' }), sink = Object.freeze({ kind: 'sink' });

export function createLanguage({ state, io, execution, runCommand, isCurrent, getCode, setCode, limits: overrides = {}, onListing = () => {} }) {
  const limits = languageLimits(overrides);
  state.functions ??= new Map(); state.positionals ??= [];
  let steps = 0, argumentsUsed = 0, outputUsed = 0, frames = [], loopDepth = 0, lastSubstitution = null;
  let status = getCode();
  let outcome = {};
  const outcomeOf = (result) => Object.fromEntries(['cancelled', 'interrupted', 'timedOut', 'streamFailed']
    .filter((key) => result?.[key]).map((key) => [key, true]));
  const terminal = { 1: { kind: 'terminal', channel: 1 }, 2: { kind: 'terminal', channel: 2 } };
  let expansionChannels = terminal;
  const check = () => { execution.check(); if (!isCurrent()) throw new ShellInterrupted(); };
  const spend = (count = 1) => {
    check();
    if (!Number.isSafeInteger(count) || count < 0 || (steps += count) > limits.maxSteps) throw new LanguageError('execution steps exceed their limit');
  };
  let lastYield = 0;
  const tick = async (count = 1) => {
    spend(count);
    if (steps - lastYield >= limits.yieldEvery) { lastYield = steps; await new Promise((resolve) => setTimeout(resolve, 0)); check(); }
  };
  const argument = (text) => {
    check();
    try { argumentsUsed += utf8Length(String(text), limits.maxArgumentBytes - argumentsUsed); }
    catch (_) { throw new LanguageError('argument expansion bytes exceed their limit'); }
  };
  const code = (value) => { status = value; if (isCurrent()) setCode(value); return value; };
  const get = (name) => name === 'PWD' ? '/' + state.cwd : state.vars.get(name);
  const set = (name, value) => {
    check(); if (!identifier.test(name)) throw new LanguageError(`invalid variable name '${name}'`);
    value = String(value); if (value.includes('\0')) throw new LanguageError('variables cannot contain NUL');
    state.vars.set(name, value);
  };
  async function scope(operation) {
    const saved = { vars: state.vars, functions: state.functions, positionals: state.positionals, cwd: state.cwd, frames, explicitEnv: state.explicitEnv };
    state.vars = new Map(state.vars); state.functions = new Map(state.functions); state.positionals = [...state.positionals];
    frames = frames.map((frame) => ({ ...frame, locals: new Map(frame.locals) }));
    try { return await operation(); }
    catch (error) { if (error instanceof LanguageFlow) return code(error.code); throw error; }
    finally {
      if (isCurrent()) { Object.assign(state, { vars: saved.vars, functions: saved.functions, positionals: saved.positionals, cwd: saved.cwd, explicitEnv: saved.explicitEnv }); frames = saved.frames; }
    }
  }
  async function readRedirect(path) {
    let data;
    try { data = await io.readBytes(path, { maxBytes: limits.maxOutputBytes, rejectSymlinks: true }); }
    catch (error) {
      // Legacy whole-object hosts supported redirects before bounded reads.
      // Preserve that route without weakening the strict U2 reader. Such a
      // host can enforce this size ceiling only after allocating its response.
      if (!(error instanceof IOFailure && error.code === 'ENOTSUP'
        && error.message === 'storage backend does not support bounded reads')) throw error;
      data = await io.readBytes(path, { rejectSymlinks: true });
    }
    if (data.length > limits.maxOutputBytes) throw new LanguageError('redirect input bytes exceed their limit');
    return data;
  }
  async function write(target, data) {
    check(); const bytes = toBytes(data);
    if (!bytes.length) return;
    outputUsed += bytes.length;
    if (outputUsed > limits.maxOutputBytes) throw new LanguageError('output bytes exceed their limit');
    if (target.kind === 'sink') return;
    if (target.kind === 'closed') throw new IOFailure('write', { code: 'EBADF', message: 'output descriptor is closed' });
    if (target.kind === 'terminal') { execution.writeStreams(target.channel === 1 ? data : '', target.channel === 2 ? data : ''); return; }
    if (target.kind === 'buffer' || target.kind === 'pipe') {
      if (target.stream) throw new LanguageError('cannot append data after a live byte producer');
      target.events.push({ channel: target.channel, data }); return;
    }
    if (target.kind === 'file') {
      let before;
      try { before = target.staged ? target.data : await readRedirect(target.path); }
      catch (error) { if (!(error instanceof IOFailure && error.code === 'ENOENT')) throw error; before = new Uint8Array(); }
      const start = target.append ? before.length : target.offset;
      const length = Math.max(before.length, start + bytes.length);
      if (length > limits.maxOutputBytes) throw new LanguageError('redirected file exceeds its byte limit');
      const after = new Uint8Array(length); after.set(before); after.set(bytes, start);
      if (target.staged) target.data = after;
      else await io.write(target.path, after, { createParents: true });
      check(); target.offset = start + bytes.length; return;
    }
    throw new LanguageError('unknown output target');
  }
  async function diagnostic(error, channels) {
    if (error instanceof ShellInterrupted || error?.shellFlow) throw error;
    outcome = outcomeOf(error);
    const result = typeof error.code === 'number' ? error.code : 1;
    if (channels[2].kind !== 'closed') await write(channels[2], lineData(error.message || String(error)));
    return code(result);
  }
  async function emit(result, channels) {
    result = commandStreams(result);
    if (result.stream) {
      if (channels[1].kind === 'pipe' && !channels[1].events.length) channels[1].stream = ownByteStream(result.stream);
      else {
        const data = await collectByteStream(result.stream, { signal: () => execution.signal, limits: { maxOutputBytes: limits.maxOutputBytes, maxInputBytes: limits.maxOutputBytes } });
        await write(channels[1], data);
      }
    }
    if (channels[1] === channels[2] && result.combined !== undefined && !result.stream) await write(channels[1], result.combined);
    else if (channels[1].kind === 'terminal' && channels[1].channel === 1 && channels[2].kind === 'terminal' && channels[2].channel === 2
      && !result.stream && (result.combined !== undefined || result.displayText !== undefined || result.listing)) {
      let display = result.displayText ?? renderData(autoData(result.combined ?? concatData([result.stdout, result.stderr])));
      if (result.listing) display = onListing(display, result.listing);
      const size = toBytes(result.stdout).length + toBytes(result.stderr).length;
      if ((outputUsed += size) > limits.maxOutputBytes) throw new LanguageError('output bytes exceed their limit');
      execution.writeStreams(result.stdout, result.stderr, display);
    } else for (const event of resultEvents(result)) await write(channels[event.channel], event.data);
    return code(result.code ?? 0);
  }
  async function bytes(input) {
    if (input.closed) throw new IOFailure('read', { code: 'EBADF', message: 'input descriptor is closed' });
    if (isByteStream(input.data)) input.data = await collectByteStream(input.data, { signal: () => execution.signal, limits: { maxOutputBytes: limits.maxOutputBytes, maxInputBytes: limits.maxOutputBytes } });
    const data = toBytes(input.data); if (data.length > limits.maxOutputBytes) throw new LanguageError('input bytes exceed their limit');
    input.data = data; return data;
  }
  function takesInput(argv) {
    if (noInput.has(argv[0])) return false;
    if (argv[0] === 'cat' || argv[0] === 'more') return !argv.slice(1).some((arg) => !arg.startsWith('-')) || argv.includes('-');
    return true;
  }
  async function takeInput(input, argv) {
    if (!takesInput(argv)) return '';
    if (input.closed) throw new IOFailure('read', { code: 'EBADF', message: 'input descriptor is closed' });
    if (isByteStream(input.data)) { const stream = input.data; input.data = ''; input.at = 0; return stream; }
    const data = await bytes(input), value = data.subarray(input.at); input.at = data.length; return value;
  }
  async function canonical(path, mode, missingParents = false) {
    const context = createU2Context({ command: 'shell redirect', io, signal: () => execution.signal });
    const resolved = await resolveVirtualPath(io, path, { context, mode, followFinal: true, missingParents });
    return '/' + resolved.path;
  }
  async function redirects(node, input, channels) {
    let incoming = input; const outputs = { ...channels }, files = [];
    for (const redirect of node.redirects || []) {
      await tick();
      if (redirect.op === '<<' || redirect.op === '<<-') { incoming = reader(redirect.body); continue; }
      const values = await words.expand(redirect.target);
      if (values.length !== 1) throw new LanguageError('ambiguous redirect');
      const value = values[0];
      if (redirect.op === '>&') {
        if (!['1', '2', '-'].includes(value)) throw new LanguageError('output duplication supports descriptors 1, 2 or - only');
        outputs[redirect.fd] = value === '-' ? closed : outputs[Number(value)]; continue;
      }
      if (redirect.op === '<&') {
        if (!['0', '-'].includes(value)) throw new LanguageError('input duplication supports descriptor 0 or - only');
        if (value === '-') incoming = { ...reader(), closed: true }; continue;
      }
      const isNull = io.resolve(value) === 'dev/null';
      if (redirect.op === '<') {
        incoming = reader(isNull ? '' : await readRedirect(await canonical(value, 'existing'))); continue;
      }
      let target = sink;
      if (!isNull) {
        // Keep the established parent-creation contract. Check lexical fences
        // before metadata traversal, then check the resolved destination again.
        const lexical = await execution.authorize('fs.write', { path: io.resolve(value), data: '', createParents: true });
        if (lexical && !lexical.ok) throw new IOFailure('fs.write', lexical);
        const path = await canonical(value, 'all-but-last', true), append = redirect.op.endsWith('>>');
        const authorized = await execution.authorize('fs.write', { path: io.resolve(path), data: '', createParents: true });
        if (authorized && !authorized.ok) throw new IOFailure('fs.write', authorized);
        const staged = execution.isStaged('fs.write');
        if (staged && !authorized) throw new LanguageError('staged redirects require governed authorization preflight');
        let existing = new Uint8Array();
        if (append) {
          try { existing = await readRedirect(path); }
          catch (error) { if (!(error instanceof IOFailure && error.code === 'ENOENT')) throw error; }
          if (!staged) await io.write(path, existing, { createParents: true });
        } else if (!staged) await io.write(path, '', { createParents: true });
        target = { kind: 'file', path, append, offset: 0, staged, data: existing };
        files.push(target);
      }
      outputs[redirect.fd] = target;
      if (redirect.op.startsWith('&')) outputs[2] = target;
    }
    return { input: incoming, channels: outputs, files };
  }
  const words = createWordExpander({ limits, argument, spend, tick, get, set, io, cwd: () => state.cwd,
    positionals: () => state.positionals, lastCode: () => status,
    substitute: async (body) => {
      const events = [], savedStatus = status, channels = { 1: buffer(events, 1), 2: expansionChannels[2] };
      let result;
      try { result = await scope(() => list(body, reader(), channels)); }
      finally { code(savedStatus); }
      lastSubstitution = result;
      const data = toBytes(concatData(events.map((event) => event.data)));
      if (data.includes(0)) throw new LanguageError('command substitution cannot contain NUL');
      if (data.some((byte) => byte < 9 || byte > 13 && byte < 32)) throw new LanguageError('command substitution cannot contain binary controls');
      let text;
      try { text = strictDecoder.decode(data); } catch (_) { throw new LanguageError('command substitution requires valid UTF-8 text'); }
      return text.replace(/\n+$/, '');
    },
  });
  async function readBuiltin(argv, input) {
    let raw = false, at = 0;
    while (at < argv.length) {
      if (argv[at] === '--') { at++; break; }
      if (argv[at] === '-r') { raw = true; at++; continue; }
      if (argv[at].startsWith('-')) throw new LanguageError('read supports -r and variable names only');
      break;
    }
    const names = argv.slice(at);
    if (names.some((name) => !identifier.test(name))) throw new LanguageError('read: invalid variable name');
    const data = await bytes(input), output = []; let terminated = false;
    while (input.at < data.length) {
      await tick(); const byte = data[input.at++];
      if (byte === 10) { terminated = true; break; }
      if (!raw && byte === 92 && input.at < data.length) {
        const next = data[input.at++]; if (next !== 10) output.push(next); continue;
      }
      output.push(byte);
    }
    let text;
    try { text = strictDecoder.decode(Uint8Array.from(output)); } catch (_) { throw new LanguageError('read requires valid UTF-8 text'); }
    if (text.includes('\0')) throw new LanguageError('read variables cannot contain NUL');
    if (!names.length) set('REPLY', text);
    else {
      const ifs = get('IFS') ?? ' \t\n', separators = new Set(ifs), white = (c) => /[ \t\n]/.test(c) && separators.has(c);
      let begin = 0, end = text.length;
      while (begin < end && white(text[begin])) begin++;
      while (end > begin && white(text[end - 1])) end--;
      for (let n = 0; n < names.length; n++) {
        if (n === names.length - 1) { set(names[n], text.slice(begin, end)); break; }
        let stop = begin; while (stop < end && !separators.has(text[stop])) stop++;
        set(names[n], text.slice(begin, stop)); begin = stop;
        if (begin < end && !white(text[begin])) begin++;
        else {
          while (begin < end && white(text[begin])) begin++;
          if (begin < end && separators.has(text[begin])) begin++;
        }
        while (begin < end && white(text[begin])) begin++;
      }
    }
    return code(terminated ? 0 : 1);
  }
  async function invoke(argv, input, channels, { producer = false } = {}) {
    outcome = {};
    check(); if (!argv.length) return code(0);
    const [verb, ...args] = argv;
    if (verb === ':') return code(0);
    if (verb === 'read') return readBuiltin(args, input);
    if (verb === 'set') {
      if (args[0] !== '--') throw new LanguageError('set supports -- followed by positional arguments only');
      state.positionals = args.slice(1); return code(0);
    }
    if (verb === 'shift') {
      if (args.length > 1 || args.length && !/^[0-9]+$/.test(args[0])) throw new LanguageError('shift expects one nonnegative integer');
      const count = args.length ? Number(args[0]) : 1;
      if (!Number.isSafeInteger(count) || count > state.positionals.length) { await write(channels[2], 'shift: count exceeds positional parameters\n'); return code(1); }
      state.positionals = state.positionals.slice(count); return code(0);
    }
    if (verb === 'local') {
      if (!frames.length) throw new LanguageError('local is available only in a function');
      for (const arg of args) {
        const cut = arg.indexOf('='), name = cut < 0 ? arg : arg.slice(0, cut);
        if (!identifier.test(name)) throw new LanguageError('local: invalid variable name or option');
        const saved = frames.at(-1).locals;
        if (!saved.has(name)) saved.set(name, { present: state.vars.has(name), value: state.vars.get(name) });
        if (cut >= 0) set(name, arg.slice(cut + 1));
        else if (!state.vars.has(name)) set(name, '');
      }
      return code(0);
    }
    if (verb === 'return') {
      if (!frames.length) throw new LanguageError('return is available only in a function');
      if (args.length > 1 || args.length && !/^[+-]?[0-9]+$/.test(args[0])) throw new LanguageError('return expects one integer status');
      const value = args.length ? Number(BigInt.asUintN(8, BigInt(args[0]))) : status;
      throw new LanguageFlow('return', 1, value);
    }
    if (verb === 'break' || verb === 'continue') {
      if (!loopDepth) throw new LanguageError(`${verb} is available only in a loop`);
      if (args.length > 1 || args.length && !/^[1-9][0-9]*$/.test(args[0])) throw new LanguageError(`${verb} expects one positive loop count`);
      const level = args.length ? Number(args[0]) : 1;
      throw new LanguageFlow(verb, Math.min(Number.isSafeInteger(level) ? level : loopDepth, loopDepth), 0);
    }
    if (state.functions.has(verb)) {
      if (frames.length >= limits.maxFunctionDepth) throw new LanguageError('function recursion exceeds its limit');
      const saved = state.positionals, frame = { locals: new Map() }; frames.push(frame); state.positionals = args;
      try { return await node(state.functions.get(verb), input, channels); }
      catch (error) { if (error instanceof LanguageFlow && error.kind === 'return') return code(error.code); throw error; }
      finally {
        if (isCurrent()) {
          state.positionals = saved; frames.pop();
          for (const [name, value] of frame.locals) { if (value.present) state.vars.set(name, value.value); else state.vars.delete(name); }
        }
      }
    }
    const stdin = await takeInput(input, argv);
    const result = await runCommand(argv, stdin, producer);
    outcome = outcomeOf(result);
    if (result.clear) { execution.clear?.(); return code(result.code ?? 0); }
    return emit(result, channels);
  }
  async function prepareSimple(command) {
    const assignments = []; let at = 0;
    while (at < command.words.length) { const item = assignmentWord(command.words[at]); if (!item) break; assignments.push(item); at++; }
    lastSubstitution = null;
    const argv = [];
    for (const word of command.words.slice(at)) {
      const declaration = ['local', 'export'].includes(argv[0]) && assignmentWord(word);
      argv.push(...(declaration ? [declaration.name + '=' + await words.scalar(declaration.word)] : await words.expand(word)));
    }
    return { assignments, argv, substitutionCode: lastSubstitution };
  }
  async function simple(prepared, input, channels) {
    const { assignments, argv, substitutionCode } = prepared;
    lastSubstitution = substitutionCode;
    const saved = new Map();
    try {
      for (const assignment of assignments) {
        if (!saved.has(assignment.name)) saved.set(assignment.name, { present: state.vars.has(assignment.name), value: state.vars.get(assignment.name) });
        set(assignment.name, await words.scalar(assignment.word));
      }
      if (!argv.length) return code(lastSubstitution ?? 0);
      return await invoke(argv, input, channels, { producer: channels[1].kind === 'pipe' });
    } finally {
      if (argv.length && isCurrent()) for (const [name, value] of saved) { if (value.present) state.vars.set(name, value.value); else state.vars.delete(name); }
    }
  }
  async function loop(command, input, channels) {
    let result = 0, count = 0; loopDepth++;
    try {
      let values = null;
      if (command.kind === 'for') {
        values = command.words === null ? [...state.positionals] : [];
        if (command.words !== null) for (const word of command.words) values.push(...await words.expand(word));
      }
      let index = 0;
      while (true) {
        await tick();
        if (values) { if (index >= values.length) break; set(command.name, values[index++]); }
        else {
          const condition = await list(command.condition, input, channels);
          if (command.kind === 'while' ? condition !== 0 : condition === 0) break;
        }
        if (++count > limits.maxLoopIterations) throw new LanguageError('loop iterations exceed their limit');
        try { result = await list(command.body, input, channels); }
        catch (error) {
          if (!(error instanceof LanguageFlow) || !['break', 'continue'].includes(error.kind)) throw error;
          if (--error.level > 0) throw error;
          result = 0; if (error.kind === 'break') break;
        }
      }
      return code(result);
    } finally { loopDepth--; }
  }
  async function node(command, inheritedInput, inheritedChannels) {
    await tick(); const savedChannels = expansionChannels; expansionChannels = inheritedChannels;
    let channels = inheritedChannels, files = [], finalize = false;
    try {
      // Definition-time redirects are retained with the function body.
      if (command.kind === 'function') { state.functions.set(command.name, command.body); return code(0); }
      const prepared = command.kind === 'simple' ? await prepareSimple(command) : null;
      const redirected = await redirects(command, inheritedInput, inheritedChannels), input = redirected.input;
      files = redirected.files; finalize = true;
      channels = redirected.channels; expansionChannels = channels;
      switch (command.kind) {
        case 'simple': return await simple(prepared, input, channels);
        case 'group': return await list(command.body, input, channels);
        case 'subshell': return await scope(() => list(command.body, input, channels));
        case 'arithmetic': return code(await words.math(await words.scalar(command.word)) === 0n ? 1 : 0);
        case 'for': case 'while': case 'until': return await loop(command, input, channels);
        case 'if': {
          for (const branch of command.branches) if (await list(branch.condition, input, channels) === 0) return await list(branch.body, input, channels);
          return command.otherwise ? await list(command.otherwise, input, channels) : code(0);
        }
        case 'case': {
          const value = await words.scalar(command.word);
          for (const item of command.cases) for (const pattern of item.patterns) {
            if (words.matches(words.compilePattern(await words.pattern(pattern)), value)) return await list(item.body, input, channels);
          }
          return code(0);
        }
        default: throw new LanguageError(`unknown command node '${command.kind}'`);
      }
    } catch (error) {
      if (error instanceof LanguageError || error instanceof ShellInterrupted) { finalize = false; throw error; }
      if (error?.shellFlow) throw error;
      return diagnostic(error, channels);
    } finally {
      try { if (finalize) for (const target of files) if (target.staged) { check(); await io.write(target.path, target.data, { createParents: true }); } }
      catch (error) {
        if (error instanceof LanguageError || error instanceof ShellInterrupted || error?.shellFlow) throw error;
        return await diagnostic(error, inheritedChannels);
      }
      finally { expansionChannels = savedChannels; }
    }
  }
  async function pipeline(command, input, channels) {
    let incoming = input, result = 0; const previousStatus = status;
    for (let index = 0; index < command.commands.length; index++) {
      const last = index === command.commands.length - 1, events = [], output = { kind: 'pipe', channel: 1, events, stream: null };
      const sinks = last ? channels : { 1: output, 2: channels[2] };
      let transferred = false;
      try {
        outcome = {};
        if (command.commands.length > 1) code(previousStatus);
        result = command.commands.length > 1
          ? await scope(() => node(command.commands[index], incoming, sinks)) : await node(command.commands[index], incoming, sinks);
        transferred = true;
      } finally {
        if (incoming !== input && isByteStream(incoming.data)) await closeByteStream(incoming.data, { suppress: true });
        if (!transferred && output.stream) await closeByteStream(output.stream, { suppress: true });
      }
      // Refusal, deadline expiry and failed producer transport preserve the
      // owning operation's status and cannot trigger downstream mutations.
      if (Object.keys(outcome).length) {
        if (output.stream) await closeByteStream(output.stream, { suppress: true });
        break;
      }
      if (!last) incoming = reader(output.stream || concatData(events.map((event) => event.data)));
    }
    return code(command.negate ? result === 0 ? 1 : 0 : result);
  }
  async function list(body, input, channels) {
    let result = body.items.length ? status : code(0);
    for (const item of body.items) {
      await tick(); result = await pipeline(item.first, input, channels);
      for (const branch of item.rest) {
        if (branch.operator === '&&' ? result !== 0 : result === 0) continue;
        result = await pipeline(branch.node, input, channels);
      }
    }
    return result;
  }
  return {
    async run(body) { await list(body, reader(), terminal); return { code: status }; },
    async invoke(argv, stdin = '') {
      if (argv.length > limits.maxTokens) throw new LanguageError('nested argument count exceeds its limit');
      for (const item of argv) argument(item);
      const events = [], channels = { 1: buffer(events, 1), 2: buffer(events, 2) };
      try { const result = await invoke(argv, reader(stdin), channels); return streamResult(events, result, outcome); }
      catch (error) {
        if (error instanceof ShellInterrupted) error.shellResult = streamResult(events, 130);
        throw error;
      }
    },
    reset() { state.functions = new Map(); state.positionals = []; },
  };
}

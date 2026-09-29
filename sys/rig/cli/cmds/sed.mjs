// sed's parser and interpreter keep one JavaScript character per byte. UTF-8
// decoding belongs at the shell's rendering boundary, never inside a byte edit.
import { ArgError, parseArgs } from '../args.mjs';
import { IOFailure, autoData, toBytes, concatData } from '../io.mjs';
import { ShellInterrupted } from '../execution.mjs';
import { parseSed, decodeEscape } from './sed-parser.mjs';
import { findRegex } from './sed-regex.mjs';

const fail = (message) => { throw new ArgError(`sed: ${message}`); };
function binary(data) {
  const bytes = toBytes(data); const parts = [];
  for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return parts.join('');
}
const bytes = (value) => Uint8Array.from(value, (character) => character.charCodeAt(0));
const filename = (value) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes(value));

function records(data, delimiter, path, budget) {
  const result = [];
  let from = 0, end;
  while ((end = data.indexOf(delimiter, from)) !== -1) {
    if (--budget.left < 0) fail('input exceeds the record limit');
    result.push({ text: data.slice(from, end), terminated: true, path }); from = end + 1;
  }
  if (from < data.length) {
    if (--budget.left < 0) fail('input exceeds the record limit');
    result.push({ text: data.slice(from), terminated: false, path });
  }
  return result;
}

export function createSedCommands(io, { signal = () => null, maxSteps = 1000000, maxOutputBytes = 16777216 } = {}) {
  return {
    async sed(argv, stdin = '') {
      const { options, operands, occurrences } = parseArgs(argv, {
        quiet: { short: 'n', long: ['quiet', 'silent'] },
        expression: { short: 'e', long: 'expression', value: true, multiple: true },
        file: { short: 'f', long: 'file', value: true, multiple: true },
        extended: { short: ['E', 'r'], long: 'regexp-extended' },
        inPlace: { short: 'i', long: 'in-place', value: 'optional' },
        separate: { short: 's', long: 'separate' },
        zero: { short: 'z', long: 'null-data' },
      }, { command: 'sed' });
      const scripts = [], errors = [];
      let files = operands.slice(), readStdin = false, scriptBytes = 0;
      const addScript = (data) => {
        const raw = toBytes(data);
        scriptBytes += raw.length + (scripts.length ? 1 : 0);
        if (scriptBytes > 262144) fail('script exceeds the 262144-byte limit');
        scripts.push(binary(raw));
      };
      const checkStop = () => { if (signal()?.aborted) throw new ShellInterrupted(); };
      for (const occurrence of occurrences) {
        if (occurrence.key === 'expression') addScript(occurrence.value);
        else if (occurrence.key === 'file') {
          try {
            checkStop();
            if (occurrence.value === '-') { addScript(readStdin ? '' : stdin); readStdin = true; }
            else addScript(await io.readBytes(occurrence.value));
          } catch (error) {
            if (!(error instanceof IOFailure)) throw error;
            return { text: `sed: ${occurrence.value}: ${error.code}`, code: 1 };
          }
        }
      }
      if (!scripts.length) {
        if (!files.length) fail('missing script operand');
        addScript(files.shift());
      }
      const script = scripts.join('\n');
      if (script.length > 262144) fail('script exceeds the 262144-byte limit');
      const program = parseSed(script, { extended: !!options.extended });
      const quiet = !!options.quiet || program.quiet;
      const inPlace = options.inPlace !== undefined;
      if (inPlace && !files.length) fail('in-place editing requires a file operand');
      if (inPlace && files.includes('-')) fail('cannot edit standard input in place');
      const separate = !!options.separate || inPlace, delimiter = options.zero ? '\0' : '\n';
      let steps = 0, totalOutput = 0, yieldedAt = 0;
      const tick = () => { if (++steps > maxSteps) fail(`execution exceeds the ${maxSteps}-step limit`); };
      const bounded = (value) => { if (value.length > maxOutputBytes) fail(`buffer exceeds the ${maxOutputBytes}-byte limit`); return value; };
      const account = (length) => {
        if (totalOutput + length > maxOutputBytes) fail(`output exceeds the ${maxOutputBytes}-byte limit`);
        totalOutput += length;
      };
      const checkpoint = async () => {
        checkStop();
        yieldedAt = steps;
        // Promise.resolve() alone cannot deliver the Stop button's event.
        await new Promise((resolve) => setTimeout(resolve, 0));
        checkStop();
      };
      const writer = () => {
        const pieces = []; let incomplete = false;
        return {
          record(text, terminated = true) {
            const prefix = incomplete ? delimiter : '';
            const suffix = terminated ? delimiter : '';
            account(prefix.length + text.length + suffix.length);
            pieces.push(prefix, text, suffix); incomplete = !terminated;
          },
          flushMissing() {
            if (!incomplete) return;
            account(delimiter.length); pieces.push(delimiter); incomplete = false;
          },
          raw(text) {
            account(text.length); pieces.push(text);
            // Queued file contents use raw writes, so their final byte never
            // schedules a separator before the next pattern-space output.
          },
          value: () => pieces.join(''),
        };
      };
      const stdout = writer();
      const writeFiles = new Map();
      // Validate every filename and backup path before opening any output. A
      // malformed script never truncates its w target or creates an -i backup.
      for (const command of program.commands) if (command.file != null) {
        try { command.path = filename(command.file); }
        catch (_) { fail('filenames in scripts must be valid UTF-8'); }
        if (command.path.includes('\0')) fail('filename contains a NUL byte');
        if (command.op === 'w' || command.op === 's') writeFiles.set(command.path, writer());
      }
      const backups = new Map();
      if (inPlace && options.inPlace !== true && options.inPlace !== '') {
        for (const path of files) {
          const backup = options.inPlace.includes('*') ? options.inPlace.split('*').join(path) : path + options.inPlace;
          if (io.resolve(backup) === io.resolve(path)) fail('backup filename resolves to the input file');
          backups.set(path, backup);
        }
      }
      const diagnostic = (path, error) => { errors.push(`sed: ${path}: ${error.code}`); };
      try {
        for (const path of writeFiles.keys()) { checkStop(); await io.write(path, ''); }
      } catch (error) {
        if (!(error instanceof IOFailure)) throw error;
        return { text: `sed: ${error.code}: ${error.message}`, code: 1 };
      }
      let inputBytes = 0;
      const inputBudget = { left: Math.min(maxSteps, 262144) };
      const loadFile = async (path) => {
        try {
          checkStop();
          const raw = toBytes(path === '-' ? readStdin ? '' : stdin : await io.readBytes(path));
          inputBytes += raw.length;
          if (inputBytes > maxOutputBytes * 4) fail(`input exceeds the ${maxOutputBytes * 4}-byte limit`);
          const data = binary(raw);
          if (path === '-') readStdin = true;
          return { path, data, records: records(data, delimiter, path, inputBudget) };
        } catch (error) {
          if (!(error instanceof IOFailure)) throw error;
          diagnostic(path, error);
          return null;
        }
      };

      let exitCode = 0, quit = false, hold = { text: '', terminated: true }, lastRegex = null;
      const ranges = new Map();
      const compiled = (pattern, insensitive = false, multiline = false) => {
        if (pattern) lastRegex = { regex: pattern, insensitive, multiline };
        if (!lastRegex) fail('no previous regular expression');
        return lastRegex;
      };
      const match = (pattern, text, from = 0) => findRegex(pattern.regex, text, from, { ...pattern, tick });
      async function selected(command, line, last, pattern) {
        if (!command.first) return { yes: !command.negate, end: false };
        const test = async (address) => {
          if (address.kind === 'line') return line === address.line;
          if (address.kind === 'last') return !(await last());
          if (address.kind === 'step') return line >= address.first && (line - address.first) % address.step === 0;
          if (address.kind === 'regex') return !!match(compiled(address.regex, address.insensitive, address.multiline), pattern);
          return false;
        };
        let yes, end = false;
        if (!command.second) yes = await test(command.first);
        else {
          let range = ranges.get(command);
          if (!range) { range = { active: command.first.kind === 'line' && command.first.line === 0, began: 0, used: false }; ranges.set(command, range); }
          const already = range.active;
          if (!already) {
            // A numeric starting address must not restart when a branch visits
            // the same command twice during one input cycle.
            const numericOnce = command.first.kind === 'line';
            range.active = !(numericOnce && range.used) && await test(command.first);
            if (range.active) { range.began = line; range.used = true; }
          }
          yes = range.active;
          if (yes) {
            const second = command.second;
            if (second.kind === 'relative') end = line >= range.began + second.count;
            else if (second.kind === 'multiple') end = line > range.began && line % second.count === 0;
            else if (second.kind === 'line') end = line >= second.line;
            else if (second.kind === 'regex') end = already && await test(second);
            else end = await test(second);
            if (end) range.active = false;
          }
        }
        return { yes: command.negate ? !yes : yes, end };
      }
      function replacement(template, found) {
        let text = '', mode = null, nextCase = null;
        const add = (value) => {
          if (text.length + value.length > maxOutputBytes) fail(`buffer exceeds the ${maxOutputBytes}-byte limit`);
          if (!mode && !nextCase) { text += value; return; }
          for (let c of value) {
            const which = nextCase || mode;
            if (which === 'lower' && c >= 'A' && c <= 'Z') c = String.fromCharCode(c.charCodeAt(0) + 32);
            if (which === 'upper' && c >= 'a' && c <= 'z') c = String.fromCharCode(c.charCodeAt(0) - 32);
            text += c; nextCase = null;
          }
        };
        for (let i = 0; i < template.length; i++) {
          const c = template[i];
          if (c === '&') { add(found.captures[0]); continue; }
          if (c !== '\\') { add(c); continue; }
          const escaped = template[++i];
          if (escaped == null) fail('trailing backslash in replacement');
          if (/[1-9]/.test(escaped)) {
            if (+escaped >= found.captures.length) fail('invalid reference in substitution replacement');
            add(found.captures[+escaped]);
          } else if (escaped === 'L' || escaped === 'U') mode = escaped === 'L' ? 'lower' : 'upper';
          else if (escaped === 'l' || escaped === 'u') nextCase = escaped === 'l' ? 'lower' : 'upper';
          else if (escaped === 'E') mode = nextCase = null;
          else if ('xod'.includes(escaped)) {
            const rule = escaped === 'x' ? /^[\da-fA-F]{1,2}/ : escaped === 'o' ? /^[0-7]{1,3}/ : /^\d{1,3}/;
            const m = rule.exec(template.slice(i + 1));
            if (m) { i += m[0].length; add(String.fromCharCode(parseInt(m[0], escaped === 'x' ? 16 : escaped === 'o' ? 8 : 10) & 255)); }
            else add(escaped);
          } else add(decodeEscape(escaped));
        }
        return bounded(text);
      }
      function substitute(command, input) {
        const regex = compiled(command.pattern, command.insensitive, command.multiline);
        let search = 0, consumed = 0, count = 0, changed = false, previousEnd = -1, size = 0;
        const pieces = [];
        const append = (piece) => {
          if (size + piece.length > maxOutputBytes) fail(`buffer exceeds the ${maxOutputBytes}-byte limit`);
          size += piece.length; pieces.push(piece);
        };
        while (search <= input.length) {
          const found = match(regex, input, search); if (!found) break;
          // GNU/POSIX substitutions do not count an empty match immediately
          // following a nonempty match of the same expression.
          if (found.index === found.end && found.index === previousEnd) { search = found.end + 1; continue; }
          count++;
          const replace = command.occurrence == null ? command.global || count === 1
            : command.global ? count >= command.occurrence : count === command.occurrence;
          if (replace) {
            append(input.slice(consumed, found.index)); append(replacement(command.replacement, found));
            consumed = found.end; changed = true;
          }
          previousEnd = found.end;
          search = found.end === found.index ? found.end + 1 : found.end;
          if (replace && !command.global) break;
        }
        append(input.slice(consumed));
        return { text: bounded(pieces.join('')), changed };
      }
      const list = (text, width) => {
        const escapes = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r', 92: '\\\\' };
        let line = '', output = '';
        for (let i = 0; i <= text.length; i++) {
          const code = text.charCodeAt(i);
          const unit = i === text.length ? '$' : escapes[code] || (code >= 32 && code <= 126 ? text[i] : '\\' + code.toString(8).padStart(3, '0'));
          if (width > 0 && line.length && line.length + unit.length > width) {
            if (output.length + line.length + 2 > maxOutputBytes) fail('list output exceeds the output limit');
            output += line + '\\\n'; line = '';
          }
          if (output.length + line.length + unit.length > maxOutputBytes) fail('list output exceeds the output limit');
          line += unit;
        }
        return output + line;
      };
      const writePattern = async (path, pattern) => {
        const output = writeFiles.get(path);
        output.record(pattern.text, pattern.terminated);
        checkStop(); await io.write(path, autoData(bytes(output.value())));
      };
      const paths = files.length ? files : ['-'];
      const groups = separate ? paths.map((path) => ({ files: [path] })) : [{ files: paths }];
      try {
        for (const group of groups) {
          if (quit) break;
          if (separate) { ranges.clear(); hold = { text: '', terminated: hold.terminated }; }
          const output = inPlace ? writer() : stdout;
          let fileIndex = 0, inputIndex = 0, inputFile = null, peeked = null, line = 0, substituted = false;
          const hasNext = async () => {
            while (!peeked) {
              if (inputFile && inputIndex < inputFile.records.length) { peeked = inputFile.records[inputIndex++]; break; }
              if (fileIndex >= group.files.length) return false;
              inputFile = await loadFile(group.files[fileIndex++]); inputIndex = 0;
            }
            return true;
          };
          const readNext = async () => {
            if (!(await hasNext())) return null;
            const next = { ...peeked }; peeked = null;
            line++; substituted = false; return next;
          };
          while (!quit) {
            checkStop(); tick();
            let pattern = await readNext(); if (!pattern) break;
            bounded(pattern.text);
            let pc = 0, deleted = false, appended = [], appendedBytes = 0;
            const queueAppend = (item) => {
              appendedBytes += (item.text?.length ?? item.path.length) + 1;
              if (appendedBytes > maxOutputBytes) fail('append queue exceeds the output limit');
              appended.push(item);
            };
            const flushAppend = async (force = false) => {
              // Flush the preceding pattern's missing separator even when a
              // queued file is empty or absent. GNU's append queue does this
              // once before reading any queued files.
              if (force || appended.length) output.flushMissing();
              for (const item of appended) {
                if (item.path != null) {
                  try {
                    checkStop();
                    const raw = toBytes(await io.readBytes(item.path));
                    if (raw.length > maxOutputBytes) fail(`buffer exceeds the ${maxOutputBytes}-byte limit`);
                    output.raw(binary(raw));
                  } catch (error) {
                    if (!(error instanceof IOFailure)) throw error;
                    if (!['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) throw error;
                  }
                } else output.record(item.text, true);
              }
              appended = []; appendedBytes = 0;
            };
            while (pc < program.commands.length && !deleted && !quit) {
              tick();
              if (steps - yieldedAt >= 512) await checkpoint();
              const command = program.commands[pc++];
              if (command.op === '}') continue;
              const selection = await selected(command, line, hasNext, pattern.text);
              if (!selection.yes) { if (command.op === '{') pc = command.end + 1; continue; }
              switch (command.op) {
                case '{': case ':': break;
                case 's': {
                  const result = substitute(command, pattern.text);
                  pattern.text = result.text;
                  if (result.changed) {
                    substituted = true;
                    if (command.print) output.record(pattern.text, pattern.terminated);
                    if (command.path != null) await writePattern(command.path, pattern);
                  }
                  break;
                }
                case 'y': {
                  const table = new Map([...command.from].map((c, index) => [c, command.to[index]]));
                  let translated = '';
                  for (let i = 0; i < pattern.text.length; i++) translated += table.get(pattern.text[i]) ?? pattern.text[i];
                  pattern.text = translated; break;
                }
                case 'p': output.record(pattern.text, pattern.terminated); break;
                case 'P': {
                  const end = pattern.text.indexOf(delimiter);
                  output.record(end < 0 ? pattern.text : pattern.text.slice(0, end), end < 0 ? pattern.terminated : true); break;
                }
                case '=': output.record(String(line)); break;
                case 'l': output.record(list(pattern.text, command.number ?? 70)); break;
                case 'd': deleted = true; break;
                case 'D': {
                  const end = pattern.text.indexOf(delimiter);
                  if (end < 0) deleted = true;
                  else { pattern.text = pattern.text.slice(end + 1); pc = 0; }
                  break;
                }
                case 'n': {
                  if (!quiet) output.record(pattern.text, pattern.terminated);
                  await flushAppend();
                  const next = await readNext();
                  if (!next) deleted = true;
                  else pattern = next;
                  break;
                }
                case 'N': {
                  if (!(await hasNext())) {
                    if (!quiet) output.record(pattern.text, pattern.terminated);
                    deleted = true;
                  } else {
                    await flushAppend();
                    const next = await readNext();
                    pattern = { ...next, text: bounded(pattern.text + delimiter + next.text) };
                  }
                  break;
                }
                case 'a': queueAppend({ text: command.text }); break;
                case 'i': output.record(command.text); break;
                case 'c':
                  if (!command.second || command.negate || selection.end || !(await hasNext())) output.record(command.text);
                  deleted = true; break;
                case 'q':
                  if (!quiet) output.record(pattern.text, pattern.terminated);
                  await flushAppend(true); quit = true; deleted = true; exitCode = command.number ?? 0; break;
                case 'Q': quit = true; deleted = true; appended = []; exitCode = command.number ?? 0; break;
                case 'r': queueAppend({ path: command.path }); break;
                case 'w': await writePattern(command.path, pattern); break;
                case 'h': hold = { ...pattern }; break;
                case 'H': hold = { text: bounded(hold.text + delimiter + pattern.text), terminated: pattern.terminated }; break;
                case 'g': pattern = { ...hold }; break;
                case 'G': pattern = { text: bounded(pattern.text + delimiter + hold.text), terminated: hold.terminated }; break;
                case 'x': { const before = pattern; pattern = { ...hold }; hold = before; break; }
                case 'b': pc = command.label ? command.target : program.commands.length; break;
                case 't': case 'T': {
                  const branch = command.op === 't' ? substituted : !substituted;
                  substituted = false;
                  if (branch) pc = command.label ? command.target : program.commands.length;
                  break;
                }
                default: fail(`unsupported command ${command.op}`);
              }
              bounded(pattern.text); bounded(hold.text);
            }
            if (!deleted && !quiet) output.record(pattern.text, pattern.terminated);
            await flushAppend();
            if ((line & 255) === 0) await checkpoint();
          }
          if (inPlace) {
            const file = inputFile;
            if (!file) continue;
            try {
              checkStop();
              if (backups.has(file.path)) await io.write(backups.get(file.path), autoData(bytes(file.data)));
              checkStop(); await io.write(file.path, autoData(bytes(output.value())));
            } catch (error) {
              if (!(error instanceof IOFailure)) throw error;
              diagnostic(file.path, error);
            }
          }
        }
      } catch (error) {
        if (error instanceof ArgError) {
          errors.push(error.message); exitCode = 2;
        } else if (error instanceof IOFailure) { errors.push(`sed: ${error.code}: ${error.message}`); exitCode = 1; }
        else throw error;
      }
      const output = autoData(bytes(stdout.value()));
      return {
        text: errors.length ? concatData([errors.join('\n') + '\n', output]) : output,
        ...(errors.length ? { displayText: errors.join('\n') + '\n' + (typeof output === 'string' ? output : `<${output.length} bytes>`) } : {}),
        stdout: output, stderr: errors.length ? errors.join('\n') + '\n' : '', code: errors.length ? 2 : exitCode, raw: true,
      };
    },
  };
}

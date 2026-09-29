// Bounded C-locale layout. Input bytes never pass through a UTF-8 decoder.
import { ArgError, parseArgs } from '../args.mjs';
import { IOFailure } from '../io.mjs';
import { createU2Context, parseCount, utf8Length } from './u2-common.mjs';

const flag = (short, long) => ({ short, long });
const argumentBytes = (text) => new TextEncoder().encode(text);
const value = (short, long) => ({ short, long, value: true });
const fail = (command, message) => { throw new ArgError(`${command}: ${message}`); };
const blank = (c) => c === 32 || c === 9;
const space = (c) => c === 32 || c >= 9 && c <= 13;
const word = (c) => c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 95;
const folded = (s) => s.replace(/[a-z]/g, (c) => c.toUpperCase());
const trim = (s) => s.replace(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/g, '');
const done = (ctx) => ({ text: ctx.output.finish(), code: ctx.code || 0, raw: true });
const count = (ctx, text, label, min = 1) => parseCount(String(text), {
  command: ctx.command, label, min, max: Number.MAX_SAFE_INTEGER,
});

async function byteString(ctx, bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 4096) { await ctx.budget.checkpoint(); chunks.push(String.fromCharCode(...bytes.subarray(i, i + 4096))); }
  return chunks.join('');
}

async function emit(ctx, text) {
  if (!text.length) return;
  if (text.length > ctx.budget.remaining('outputBytes')) fail(ctx.command, 'output byte limit exceeded');
  const release = ctx.budget.reserveRetained(text.length);
  try {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) { if ((i & 4095) === 0) await ctx.budget.checkpoint(); bytes[i] = text.charCodeAt(i); }
    ctx.output.append(bytes);
  } finally { release(); }
}

function byteWriter(ctx) {
  let bytes = new Uint8Array(4096), used = 0;
  const flush = () => {
    if (!used) return;
    ctx.output.append(bytes.subarray(0, used)); bytes = new Uint8Array(4096); used = 0;
  };
  return {
    put(c) {
      if (used >= ctx.budget.remaining('outputBytes')) fail(ctx.command, 'output byte limit exceeded');
      bytes[used++] = c; if (used === bytes.length) flush();
    },
    finish: flush,
  };
}

function tabs(ctx, source = '8') {
  const raw = String(source).trim();
  if (!raw || !/^\d+(?:[ ,]+[+\/]?\d+)*$/.test(raw)) fail(ctx.command, `invalid tab stops: ${source}`);
  ctx.budget.reserveRetained(raw.length * 24 + 128);
  const items = raw.split(/[ ,]+/), stops = []; let repeat = 0, offset = 0;
  for (let i = 0; i < items.length; i++) {
    ctx.budget.spend('steps');
    const mark = items[i][0], suffix = mark === '+' || mark === '/';
    const n = count(ctx, suffix ? items[i].slice(1) : items[i], 'tab stop');
    if (suffix) {
      if (i !== items.length - 1) fail(ctx.command, 'a repeating tab size must be last');
      repeat = n; offset = mark === '+' ? stops.at(-1) || 0 : 0;
    } else {
      if (stops.length && n <= stops.at(-1)) fail(ctx.command, 'tab stops must be strictly increasing');
      stops.push(n);
    }
  }
  if (stops.length === 1 && !repeat) { repeat = stops[0]; stops.length = 0; }
  return (column) => {
    let low = 0, high = stops.length;
    while (low < high) {
      ctx.budget.spend('steps'); const middle = Math.floor((low + high) / 2);
      if (stops[middle] <= column) low = middle + 1; else high = middle;
    }
    if (low < stops.length) return stops[low];
    return repeat ? column + repeat - (column - offset) % repeat : null;
  };
}

async function eachRecord(ctx, operands, callback) {
  for (const source of ctx.inputs.operands(operands)) {
    let cursor;
    try { cursor = await source.open(); }
    catch (error) { inputFailure(ctx, source, error); continue; }
    let record;
    while ((record = await cursor.nextRecord()) !== null) {
      await ctx.budget.checkpoint(); await callback(record);
    }
  }
}

function inputFailure(ctx, source, error) {
  if (!(error instanceof IOFailure)) throw error;
  ctx.code = 1; ctx.output.argument(`${ctx.command}: ${source.display}: ${error.code}: ${error.message}\n`);
}

function argumentOptions(ctx, argv, spec) {
  // Charge all tokens before parsing or retaining option-derived strings.
  for (const arg of argv) {
    try { ctx.budget.spend('argumentBytes', utf8Length(arg, ctx.budget.remaining('argumentBytes'))); }
    catch (error) { if (error instanceof ArgError) fail(ctx.command, 'argument byte limit exceeded'); throw error; }
  }
  return parseArgs(argv, spec, { command: ctx.command });
}

export function createLayoutCommands(io, { signal = () => null, environment = () => new Map(), limits = {} } = {}) {
  const context = (command, stdin) => createU2Context({ command, io, stdin, signal, limits });
  return {
    async fold(argv, stdin = '') {
      const ctx = context('fold', stdin);
      const { options: o, operands } = argumentOptions(ctx, argv, {
        w: value('w', 'width'), b: flag('b', 'bytes'), s: flag('s', 'spaces'),
      });
      const width = count(ctx, o.w ?? 80, 'width');
      await eachRecord(ctx, operands, async ({ bytes, terminated }) => {
        let begin = 0, at = 0, column = 0, lastBlank = -1;
        while (at < bytes.length) {
          if ((at & 255) === 0) await ctx.budget.checkpoint();
          const c = bytes[at];
          const next = o.b ? column + 1 : c === 8 ? Math.max(0, column - 1) : c === 13 ? 0 : c === 9 ? column + 8 - column % 8 : column + 1;
          if (next > width && at > begin) {
            const end = o.s && lastBlank >= begin ? lastBlank + 1 : at;
            ctx.output.append(bytes.subarray(begin, end)); ctx.output.byte(10);
            begin = at = end; column = 0; lastBlank = -1; continue;
          }
          if (blank(c)) lastBlank = at;
          column = next; at++;
        }
        ctx.output.append(bytes.subarray(begin)); if (terminated) ctx.output.byte(10);
      });
      return done(ctx);
    },

    async expand(argv, stdin = '') {
      const ctx = context('expand', stdin);
      const { options: o, operands } = argumentOptions(ctx, argv, { t: value('t', 'tabs'), i: flag('i', 'initial') });
      const nextTab = tabs(ctx, o.t), output = byteWriter(ctx);
      await eachRecord(ctx, operands, async ({ bytes, terminated }) => {
        let column = 0, initial = true;
        for (let i = 0; i < bytes.length; i++) {
          if ((i & 255) === 0) await ctx.budget.checkpoint();
          const c = bytes[i];
          if (c === 9) {
            const end = nextTab(column) ?? column + 1;
            if (!o.i || initial) for (; column < end; column++) { output.put(32); if ((column & 255) === 0) await ctx.budget.checkpoint(); }
            else { output.put(c); column = end; }
          } else {
            output.put(c); column = c === 8 ? Math.max(0, column - 1) : c === 13 ? 0 : column + 1;
          }
          if (!blank(c)) initial = false;
        }
        if (terminated) output.put(10);
      });
      output.finish(); return done(ctx);
    },

    async unexpand(argv, stdin = '') {
      const ctx = context('unexpand', stdin);
      const { options: o, operands } = argumentOptions(ctx, argv, {
        t: value('t', 'tabs'), a: flag('a', 'all'), first: { long: 'first-only' },
      });
      const nextTab = tabs(ctx, o.t), all = !o.first && (o.a || o.t !== undefined), output = byteWriter(ctx);
      await eachRecord(ctx, operands, async ({ bytes, terminated }) => {
        let column = 0, initial = true;
        for (let i = 0; i < bytes.length;) {
          await ctx.budget.checkpoint(); const c = bytes[i];
          if (blank(c) && (initial || all)) {
            const begin = column; let hadTab = false;
            while (i < bytes.length && blank(bytes[i])) {
              if ((i & 255) === 0) await ctx.budget.checkpoint();
              if (bytes[i++] === 9) { column = nextTab(column) ?? column + 1; hadTab = true; } else column++;
            }
            let emitted = begin;
            while (emitted < column) {
              await ctx.budget.checkpoint(); const next = nextTab(emitted);
              if (next != null && next <= column && (next - emitted > 1 || hadTab)) { output.put(9); emitted = next; }
              else { output.put(32); emitted++; }
            }
          } else {
            output.put(c); i++;
            column = c === 9 ? nextTab(column) ?? column + 1 : c === 8 ? Math.max(0, column - 1) : c === 13 ? 0 : column + 1;
            if (!blank(c)) initial = false;
          }
        }
        if (terminated) output.put(10);
      });
      output.finish(); return done(ctx);
    },

    async fmt(argv, stdin = '') {
      const ctx = context('fmt', stdin);
      let optionMode = true;
      const normalized = argv.map((arg) => {
        if (arg === '--') optionMode = false;
        return optionMode && /^-\d+$/.test(arg) ? '-w' + arg.slice(1) : arg;
      });
      const { options: o, operands } = argumentOptions(ctx, normalized, {
        w: value('w', 'width'), g: value('g', 'goal'), s: flag('s', 'split-only'), u: flag('u', 'uniform-spacing'),
        p: value('p', 'prefix'), c: flag('c', 'crown-margin'), t: flag('t', 'tagged-paragraph'),
      });
      const goalOption = o.g == null ? null : count(ctx, o.g, 'goal');
      const width = count(ctx, o.w ?? (goalOption == null ? 75 : goalOption + 10), 'width');
      const goal = goalOption ?? Math.max(1, Math.floor(width * .935));
      if (goal > width) fail('fmt', 'goal must not exceed width');
      const prefix = o.p == null ? null : await byteString(ctx, argumentBytes(o.p));
      let paragraph = [], reservations = [], tabsSeen = false, secondaryIndent = 0;
      const flush = async () => {
        if (!paragraph.length) return;
        if (o.t && !o.s) secondaryIndent = paragraph.length > 1 ? paragraph[1].indent
          : secondaryIndent === paragraph[0].indent ? paragraph[0].indent === 0 ? 3 : 0 : secondaryIndent;
        try { await formatParagraph(ctx, paragraph, { ...o, width, goal, tabsSeen, secondaryIndent }); }
        finally { for (const release of reservations) release(); reservations = []; paragraph = []; }
      };
      try {
        for (const source of ctx.inputs.operands(operands)) {
          tabsSeen = false; secondaryIndent = 0;
          let cursor;
          try { cursor = await source.open(); }
          catch (error) { inputFailure(ctx, source, error); continue; }
          let record;
          while ((record = await cursor.nextRecord()) !== null) {
            await ctx.budget.checkpoint();
            const release = ctx.budget.reserveRetained(record.bytes.length * 4 + 96);
            let text;
            try { text = await byteString(ctx, record.bytes); } catch (error) { release(); throw error; }
            tabsSeen ||= text.includes('\t');
            const leading = /^[ \t]*/.exec(text)[0];
            const indent = await displayWidth(ctx, leading), match = prefix == null || text.slice(leading.length).startsWith(prefix);
            let body = text.slice(leading.length), decoration = '';
            if (prefix != null && match) { decoration = leading + prefix; body = body.slice(prefix.length); }
            if (!match || !trim(body) || prefix == null && text.startsWith('.')) {
              await flush(); ctx.output.record(record); release(); continue;
            }
            const restIndent = prefix == null ? indent : await displayWidth(ctx, /^[ \t]*/.exec(body)[0]);
            if (prefix != null) body = body.replace(/^[ \t]*/, '');
            const item = { body, indent: restIndent, decoration, terminated: record.terminated };
            if (paragraph.length) {
              const desired = paragraph.length > 1 ? paragraph[1].indent : paragraph[0].indent;
              const changed = (!o.c && !o.t || paragraph.length > 1) && item.indent !== desired;
              if (o.s || changed || item.decoration !== paragraph[0].decoration || o.t && paragraph.length === 1 && item.indent === desired) await flush();
            }
            paragraph.push(item); reservations.push(release);
          }
          await flush();
        }
      } finally { for (const release of reservations) release(); }
      return done(ctx);
    },

    async column(argv, stdin = '') {
      const ctx = context('column', stdin);
      const { options: o, operands } = argumentOptions(ctx, argv, {
        t: flag('t', 'table'), s: value('s', 'separator'), o: value('o', 'output-separator'), c: value('c', 'output-width'), x: flag('x', 'fillrows'),
      });
      const envWidth = environment().get('COLUMNS');
      const width = count(ctx, o.c ?? (/^\d+$/.test(envWidth || '') && Number(envWidth) > 0 ? envWidth : 80), 'width', 0);
      if (o.x && o.t) fail('column', '-x and -t are mutually exclusive');
      const delimiters = o.s == null ? null : new Set(argumentBytes(o.s));
      const separator = o.o == null ? '  ' : await byteString(ctx, argumentBytes(o.o));
      const rows = [], releases = [];
      try {
        await eachRecord(ctx, operands, async ({ bytes }) => {
          if (!bytes.length) return;
          let empty = true;
          for (let i = 0; i < bytes.length; i++) {
            if ((i & 255) === 0) await ctx.budget.checkpoint();
            if (!space(bytes[i])) { empty = false; break; }
          }
          if (empty) return;
          releases.push(ctx.budget.reserveRetained(bytes.length * 4 + 64));
          const text = await byteString(ctx, bytes);
          if (!o.t) { rows.push(text); return; }
          const cells = []; let start = 0;
          for (let i = 0; i <= bytes.length; i++) {
            if ((i & 255) === 0) await ctx.budget.checkpoint();
            const split = i === bytes.length || (delimiters ? delimiters.has(bytes[i]) : space(bytes[i]));
            if (!split) continue;
            if (delimiters || i > start) { releases.push(ctx.budget.reserveRetained(48)); cells.push(text.slice(start, i)); }
            start = i + 1;
          }
          rows.push(cells);
        });
        if (o.t) {
          const widths = [];
          for (const row of rows) for (let i = 0; i < row.length; i++) { await ctx.budget.checkpoint(); widths[i] = Math.max(widths[i] || 0, await displayWidth(ctx, row[i])); }
          for (const row of rows) {
            for (let i = 0; i < row.length; i++) {
              await emit(ctx, row[i]);
              if (i + 1 < row.length) { ctx.output.repeat(32, widths[i] - await displayWidth(ctx, row[i])); await emit(ctx, separator); }
            }
            ctx.output.byte(10);
          }
        } else if (rows.length) {
          let maximum = 0;
          for (const row of rows) maximum = Math.max(maximum, await displayWidth(ctx, row));
          const cellWidth = Math.floor(maximum / 8) * 8 + 8;
          const columns = Math.max(1, Math.min(rows.length, width ? Math.floor(width / cellWidth) : rows.length));
          const height = Math.ceil(rows.length / columns);
          for (let line = 0; line < height; line++) {
            await ctx.budget.checkpoint(); let current = 0;
            for (let col = 0; col < columns; col++) {
              const index = o.x ? line * columns + col : col * height + line;
              if (index >= rows.length) break;
              if (col) while (current < col * cellWidth) { await ctx.budget.checkpoint(); ctx.output.byte(9); current += 8 - current % 8; }
              await emit(ctx, rows[index]); current += await displayWidth(ctx, rows[index]);
            }
            ctx.output.byte(10);
          }
        }
      } finally { for (const release of releases) release(); }
      return done(ctx);
    },

    async ptx(argv, stdin = '') {
      const ctx = context('ptx', stdin);
      const { options: o, operands } = argumentOptions(ctx, argv, {
        f: flag('f', 'ignore-case'), b: value('b', 'break-file'), i: value('i', 'ignore-file'), o: value('o', 'only-file'),
        r: flag('r', 'references'), t: flag('t', 'typeset-mode'), w: value('w', 'width'), g: value('g', 'gap-size'),
        O: flag('O'), format: { long: 'format', value: true },
      });
      if (o.format != null && o.format !== 'roff') fail('ptx', 'supported output formats are terminal text and roff');
      const width = count(ctx, o.w ?? (o.t ? 100 : 72), 'width'), gap = count(ctx, o.g ?? 3, 'gap', 0);
      const releases = [], occurrences = []; let serial = 0, maxRef = 0, maxWord = 0;
      const normalize = async (s) => {
        if (!o.f) return s;
        const parts = [];
        for (let at = 0; at < s.length; at += 4096) { await ctx.budget.checkpoint(); parts.push(folded(s.slice(at, at + 4096))); }
        return parts.join('');
      };
      const readAux = async (path, words) => {
        if (path == null) return null;
        const cursor = await ctx.inputs.operands([path], { defaultStdin: false })[0].open();
        if (!words) {
          const bytes = await cursor.rest(), set = new Set();
          releases.push(ctx.budget.reserveRetained(256 * 8));
          for (let i = 0; i < bytes.length; i++) { if ((i & 255) === 0) await ctx.budget.checkpoint(); set.add(bytes[i]); }
          return set;
        }
        const set = new Set(); let record;
        while ((record = await cursor.nextRecord()) !== null) {
          await ctx.budget.checkpoint(); releases.push(ctx.budget.reserveRetained(record.bytes.length * 8 + 48));
          set.add(await normalize(await byteString(ctx, record.bytes)));
        }
        return set;
      };
      try {
        const breaks = await readAux(o.b, false), ignore = await readAux(o.i, true), only = await readAux(o.o, true);
        for (const source of ctx.inputs.operands(operands)) {
          let cursor;
          try { cursor = await source.open(); }
          catch (error) { inputFailure(ctx, source, error); continue; }
          const bytes = await cursor.rest();
          releases.push(ctx.budget.reserveRetained(bytes.length * 4));
          const text = await byteString(ctx, bytes), contexts = []; let start = 0;
          for (let i = 0; i <= text.length; i++) {
            if ((i & 255) === 0) await ctx.budget.checkpoint();
            let end = i === text.length;
            if (o.r) end ||= text.charCodeAt(i) === 10;
            else if ('.?!'.includes(text[i] || '\0')) {
              let j = i + 1;
              while (j < text.length && ']"\')}'.includes(text[j])) { if ((j & 255) === 0) await ctx.budget.checkpoint(); j++; }
              if (j === text.length || text[j] === '\n' || text[j] === '\t' || text.slice(j, j + 2) === '  ') { i = j; end = true; }
            }
            if (!end) continue;
            if (i > start) {
              let begin = start, end = i;
              while (begin < end && space(bytes[begin])) { if ((begin & 255) === 0) await ctx.budget.checkpoint(); begin++; }
              while (end > begin && space(bytes[end - 1])) { if ((end & 255) === 0) await ctx.budget.checkpoint(); end--; }
              if (end > begin) { releases.push(ctx.budget.reserveRetained(32)); contexts.push([begin, end]); }
            }
            start = i + 1;
          }
          for (const [begin, end] of contexts) {
            let body = begin, ref = '';
            if (o.r) {
              while (body < end && space(bytes[body])) { if ((body & 255) === 0) await ctx.budget.checkpoint(); body++; }
              const refStart = body; while (body < end && !space(bytes[body])) { if ((body & 255) === 0) await ctx.budget.checkpoint(); body++; }
              ref = text.slice(refStart, body); while (body < end && space(bytes[body])) { if ((body & 255) === 0) await ctx.budget.checkpoint(); body++; }
              maxRef = Math.max(maxRef, ref.length);
            }
            for (let at = body; at < end;) {
              await ctx.budget.checkpoint();
              const constituent = (index) => breaks ? !breaks.has(bytes[index]) : word(bytes[index]);
              if (!constituent(at)) { at++; continue; }
              const keyStart = at++;
              while (at < end && constituent(at)) { if ((at & 255) === 0) await ctx.budget.checkpoint(); at++; }
              maxWord = Math.max(maxWord, at - keyStart);
              const releaseKey = ctx.budget.reserveRetained((at - keyStart) * 6 + 112);
              const key = await normalize(text.slice(keyStart, at));
              if (only && !only.has(key) || ignore?.has(key)) { releaseKey(); continue; }
              ctx.budget.spend('records'); releases.push(releaseKey);
              occurrences.push({ text, begin: body, end, start: keyStart, keyEnd: at, key, ref, serial: serial++ });
            }
          }
        }
        await sortOccurrences(ctx, occurrences);
        for (const occurrence of occurrences) {
          await ctx.budget.checkpoint();
          await formatPtx(ctx, occurrence, { width, gap, maxRef, maxWord, breaks, references: o.r, roff: o.O || o.format === 'roff' });
        }
      } finally { for (const release of releases) release(); }
      return done(ctx);
    },
  };
}

async function sortOccurrences(ctx, items) {
  const release = ctx.budget.reserveRetained(items.length * 16);
  try {
    let source = items, target = new Array(items.length);
    const compare = async (a, b) => {
      const length = Math.min(a.key.length, b.key.length);
      for (let i = 0; i < length; i++) {
        ctx.budget.spend('steps'); if ((i & 255) === 0) await ctx.budget.checkpoint(0);
        const difference = a.key.charCodeAt(i) - b.key.charCodeAt(i); if (difference) return difference;
      }
      return a.key.length - b.key.length || a.serial - b.serial;
    };
    for (let size = 1; size < items.length; size *= 2) {
      for (let start = 0; start < items.length; start += size * 2) {
        await ctx.budget.checkpoint();
        const mid = Math.min(start + size, items.length), end = Math.min(start + size * 2, items.length);
        let left = start, right = mid;
        for (let at = start; at < end; at++) {
          if ((at & 255) === 0) await ctx.budget.checkpoint();
          target[at] = right >= end || left < mid && await compare(source[left], source[right]) <= 0 ? source[left++] : source[right++];
        }
      }
      [source, target] = [target, source];
    }
    if (source !== items) for (let i = 0; i < items.length; i++) {
      if ((i & 255) === 0) await ctx.budget.checkpoint(); items[i] = source[i];
    }
  } finally { release(); }
}

async function displayWidth(ctx, text) {
  let column = 0;
  for (let i = 0; i < text.length; i++) {
    if ((i & 255) === 0) await ctx.budget.checkpoint();
    const c = text.charCodeAt(i);
    column = c === 9 ? column + 8 - column % 8 : c === 8 ? Math.max(0, column - 1) : c === 13 ? 0 : column + 1;
  }
  return column;
}

async function formatParagraph(ctx, lines, options) {
  const words = [], reservations = [];
  const sentence = (text) => /[.!?][)\]"']*$/.test(text);
  try {
    for (const line of lines) {
      const text = line.body; let at = 0, column = line.indent + await displayWidth(ctx, line.decoration);
      while (at < text.length) {
        await ctx.budget.checkpoint();
        while (at < text.length && space(text.charCodeAt(at))) {
          if ((at & 255) === 0) await ctx.budget.checkpoint();
          column += text.charCodeAt(at++) === 9 ? 8 - column % 8 : 1;
        }
        if (at === text.length) break;
        const begin = at;
        while (at < text.length && !space(text.charCodeAt(at))) { if ((at & 255) === 0) await ctx.budget.checkpoint(); at++; column++; }
        const body = text.slice(begin, at), gapStartColumn = column;
        while (at < text.length && space(text.charCodeAt(at))) {
          if ((at & 255) === 0) await ctx.budget.checkpoint();
          column += text.charCodeAt(at++) === 9 ? 8 - column % 8 : 1;
        }
        const ended = at === text.length, original = ended ? sentence(body) ? 2 : 1 : column - gapStartColumn;
        const gap = options.u ? sentence(body) && (original > 1 || ended) ? 2 : 1 : original;
        ctx.budget.spend('records'); reservations.push(ctx.budget.reserveRetained(96));
        words.push({ text: body, gap, period: sentence(body), sentence: sentence(body) && gap > 1,
          punct: /^[!-\/:-@[-`{-~]$/.test(body.at(-1)), paren: "(['`\"".includes(body[0]) });
      }
    }
    if (!words.length) return;
    const decoration = lines[0].decoration, first = lines[0].indent;
    const later = options.s ? first : options.t ? options.secondaryIndent
      : lines.length > 1 && options.c ? lines[1].indent : first;
    // Match GNU's documented paragraph optimization: line length, raggedness,
    // sentence boundaries, and isolated sentence words all affect a break.
    words.at(-1).period = words.at(-1).sentence = true;
    reservations.push(ctx.budget.reserveRetained((words.length + 1) * 20));
    const baseWidth = await displayWidth(ctx, decoration), costs = new Float64Array(words.length + 1), next = new Uint32Array(words.length);
    const lengths = new Float64Array(words.length);
    const boundaryCost = (index) => {
      let cost = 4900;
      const previous = words[index - 1], current = words[index];
      if (previous?.period) cost += previous.sentence ? -2500 : 360000;
      else if (previous?.punct) cost -= 1600;
      else if (index > 1 && words[index - 2].sentence) cost += Math.floor(40000 / (previous.text.length + 2));
      if (current.paren) cost -= 1600;
      else if (current.sentence) cost += Math.floor(22500 / (current.text.length + 2));
      return cost;
    };
    for (let i = words.length - 1; i >= 0; i--) {
      costs[i] = Infinity; let length = baseWidth + (i ? later : first);
      for (let j = i; j < words.length; j++) {
        await ctx.budget.checkpoint();
        length += words[j].text.length;
        if (j > i && length > options.width) break;
        const after = j + 1, deviation = options.goal - length;
        let penalty = after === words.length ? 0 : 100 * deviation * deviation;
        if (after < words.length && next[after] < words.length) penalty += 50 * (length - lengths[after]) ** 2;
        const cost = costs[after] + penalty;
        if (cost < costs[i]) { costs[i] = cost; next[i] = after; lengths[i] = length; }
        length += words[j].gap;
      }
      costs[i] += boundaryCost(i);
    }
    for (let start = 0; start < words.length;) {
      await ctx.budget.checkpoint(); await emit(ctx, decoration);
      const indent = start ? later : first;
      let outColumn = baseWidth;
      const outputSpace = (count) => {
        const target = outColumn + count, tabTarget = Math.floor(target / 8) * 8;
        if (options.tabsSeen && outColumn + 1 < tabTarget) {
          ctx.output.repeat(9, Math.ceil((tabTarget - outColumn) / 8)); outColumn = tabTarget;
        }
        ctx.output.repeat(32, target - outColumn); outColumn = target;
      };
      outputSpace(indent);
      const end = next[start];
      for (let i = start; i < end; i++) {
        await emit(ctx, words[i].text); outColumn += words[i].text.length;
        if (i + 1 < end) outputSpace(words[i].gap);
      }
      // fmt is a paragraph formatter: even an unterminated paragraph gets LF.
      ctx.output.byte(10); start = end;
    }
  } finally { for (const release of reservations) release(); }
}

async function formatPtx(ctx, item, { width, gap, maxRef, maxWord, breaks, references, roff }) {
  // Reserve marker columns before choosing whole words. Wrapped context starts
  // beside the visible context, rather than at the distant end of its sentence.
  const half = Math.floor(Math.max(0, width - (references ? maxRef + gap : 0)) / 2);
  const leftLimit = Math.max(0, half - gap - 2), rightLimit = half - 2;
  const text = item.text, white = (at) => space(text.charCodeAt(at));
  const constituent = (at) => breaks ? !breaks.has(text.charCodeAt(at)) : word(text.charCodeAt(at));
  const step = async (at, end) => {
    if (at >= end) return end;
    if (!constituent(at)) { await ctx.budget.checkpoint(); return at + 1; }
    do { if ((at & 255) === 0) await ctx.budget.checkpoint(); at++; } while (at < end && constituent(at));
    return at;
  };
  const skipSpace = async (at, end) => { while (at < end && white(at)) { if ((at & 255) === 0) await ctx.budget.checkpoint(); at++; } return at; };
  const trimSpace = async (at, begin) => { while (at > begin && white(at - 1)) { if ((at & 255) === 0) await ctx.budget.checkpoint(); at--; } return at; };
  let afterEnd = item.keyEnd, cursor = afterEnd;
  while (cursor < item.end && cursor <= item.start + rightLimit) { afterEnd = cursor; cursor = await step(cursor, item.end); }
  if (cursor <= item.start + rightLimit) afterEnd = cursor;
  let afterCut = afterEnd < item.end;
  afterEnd = await trimSpace(afterEnd, item.start);

  let leftStart = item.begin;
  if (item.start - leftStart > half + maxWord) leftStart = await step(item.start - half - maxWord, item.start);
  const beforeEnd = await trimSpace(item.start, leftStart);
  let beforeStart = leftStart;
  while (beforeStart + leftLimit < beforeEnd) beforeStart = await step(beforeStart, beforeEnd);
  let beforeCut = await trimSpace(beforeStart, item.begin) > item.begin;
  beforeStart = await skipSpace(beforeStart, item.start);

  let tailStart = 0, tailEnd = 0, tailCut = false;
  const tailRoom = leftLimit - (beforeEnd - beforeStart) - gap;
  if (tailRoom > 0) {
    tailStart = await skipSpace(afterEnd, item.end); tailEnd = tailStart; cursor = tailStart;
    while (cursor < item.end && cursor < tailStart + tailRoom) { tailEnd = cursor; cursor = await step(cursor, item.end); }
    if (cursor < tailStart + tailRoom) tailEnd = cursor;
    if (tailEnd > tailStart) { afterCut = false; tailCut = tailEnd < item.end; }
    tailEnd = await trimSpace(tailEnd, tailStart);
  }
  let headStart = 0, headEnd = 0, headCut = false;
  const headRoom = rightLimit - (afterEnd - item.start) - gap;
  if (headRoom > 0) {
    headEnd = await trimSpace(beforeStart, item.begin); headStart = leftStart;
    while (headStart + headRoom < headEnd) headStart = await step(headStart, headEnd);
    if (headEnd > headStart) { beforeCut = false; headCut = headStart > item.begin; }
    headStart = await skipSpace(headStart, headEnd);
  }
  const size = Math.max(0, tailEnd - tailStart) + Math.max(0, beforeEnd - beforeStart) + afterEnd - item.start + Math.max(0, headEnd - headStart) + (references ? item.ref.length : 0);
  const release = ctx.budget.reserveRetained(size * 8 + 512);
  try {
    const clean = (begin, end) => text.slice(begin, end).replace(/[\t\n\r\v\f]/g, ' ');
    const tail = clean(tailStart, tailEnd) + (tailCut ? '/' : '');
    const before = (beforeCut ? '/' : '') + clean(beforeStart, beforeEnd);
    const after = clean(item.start, afterEnd) + (afterCut ? '/' : '');
    const head = (headCut ? '/' : '') + clean(headStart, headEnd);
    if (roff) {
      await emit(ctx, '.xx');
      for (const field of [tail, before, after, head, ...(references ? [item.ref] : [])]) await emit(ctx, ` "${field.replaceAll('"', '""')}"`);
    } else {
      if (references) await emit(ctx, item.ref);
      ctx.output.repeat(32, (references ? maxRef - item.ref.length : 0) + gap);
      // Whitespace skipped past an empty left field still contributes to the
      // native alignment calculation, but never to retained string storage.
      const beforeColumns = beforeEnd - beforeStart + (beforeCut ? 1 : 0);
      await emit(ctx, tail); ctx.output.repeat(32, Math.max(0, half - gap - tail.length - beforeColumns)); await emit(ctx, before);
      ctx.output.repeat(32, gap); await emit(ctx, after);
      if (headEnd > headStart) { ctx.output.repeat(32, Math.max(0, half - after.length - head.length)); await emit(ctx, head); }
    }
    ctx.output.byte(10);
  } finally { release(); }
}

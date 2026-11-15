// Pure logic with no DOM and no storage: ids, chunking, keyword search (BM25), the chat prompt with its
// citation map, and reading citations back out of an answer. The node tests import this file directly.

/** @param {string} prefix */
export function uid(prefix) {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}_${Date.now().toString(36)}${[...rand].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 8)}`;
}

/** A rough count: about four characters per token for English prose. @param {string} text */
export const estimateTokens = (text) => Math.ceil((text ?? '').length / 4);

/**
 * Split text into chunks of about `size` characters, breaking at a paragraph, then a sentence, then a space.
 * Each chunk keeps its character offsets into the original text, so a citation can open the exact passage.
 * @param {string} text
 * @param {{ size?: number, overlap?: number }} [opts]
 * @returns {{ i: number, start: number, end: number, text: string }[]}
 */
export function chunkText(text, { size = 1600, overlap = 160 } = {}) {
  const src = String(text ?? '');
  /** @type {{ i: number, start: number, end: number, text: string }[]} */
  const out = [];
  let start = 0;
  while (start < src.length) {
    // Skip leading whitespace so a chunk never starts blank.
    while (start < src.length && /\s/.test(src[start])) start++;
    if (start >= src.length) break;
    let end = Math.min(src.length, start + size);
    if (end < src.length) {
      const span = src.slice(start, end);
      const floor = Math.floor(size * 0.5);
      const para = span.lastIndexOf('\n\n');
      const sentence = Math.max(span.lastIndexOf('. '), span.lastIndexOf('? '), span.lastIndexOf('! '), span.lastIndexOf('.\n'));
      const space = span.lastIndexOf(' ');
      const cut = para > floor ? para + 2 : sentence > floor ? sentence + 2 : space > floor ? space + 1 : span.length;
      end = start + cut;
    }
    const piece = src.slice(start, end).trim();
    if (piece) out.push({ i: out.length, start, end, text: piece });
    if (end >= src.length) break;
    // Overlap backs up to a word boundary, and always moves forward.
    let next = Math.max(start + 1, end - overlap);
    while (next < end && !/\s/.test(src[next - 1])) next++;
    start = next;
  }
  return out;
}

const STOP = new Set(
  'a an and are as at be but by for from has have he her his i if in into is it its of on or our she so that the their them then there these they this to was we were what when where which who why will with you your'.split(' '),
);

/** Lower-case word tokens, letters and digits in any script, stop words removed. @param {string} text */
export function tokenize(text) {
  return (String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
}

/**
 * Build a BM25 index over chunks.
 * @param {{ id: string, title: string, chunks: { i: number, text: string }[] }[]} docs
 */
export function buildIndex(docs) {
  /** @type {{ docId: string, title: string, chunk: number, text: string, tf: Map<string, number>, len: number }[]} */
  const entries = [];
  /** @type {Map<string, number>} */
  const df = new Map();
  for (const d of docs) {
    for (const c of d.chunks) {
      const words = tokenize(c.text);
      /** @type {Map<string, number>} */
      const tf = new Map();
      for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
      entries.push({ docId: d.id, title: d.title, chunk: c.i, text: c.text, tf, len: words.length });
    }
  }
  const avg = entries.reduce((n, e) => n + e.len, 0) / (entries.length || 1);
  return { entries, df, avg };
}

/**
 * Rank chunks for a query with BM25 (k1 1.2, b 0.75). Chunks that match no query word are left out.
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query
 * @param {number} [k]
 */
export function search(index, query, k = 8) {
  const terms = [...new Set(tokenize(query))];
  const N = index.entries.length;
  const scored = [];
  for (const e of index.entries) {
    let score = 0;
    for (const t of terms) {
      const f = e.tf.get(t);
      if (!f) continue;
      const n = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (e.len / (index.avg || 1)))));
    }
    if (score > 0) scored.push({ docId: e.docId, title: e.title, chunk: e.chunk, text: e.text, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

/**
 * @typedef {{ kind: 'source' | 'note', id: string, title: string, text: string }} ContextItem
 * @typedef {{ n: number, kind: 'source' | 'note', id: string, title: string, chunk?: number }} Ref
 */

export const SYSTEM_PROMPT = [
  'You are a research assistant working inside one notebook.',
  'Answer from the numbered context items below. Cite each claim with the item number in square brackets, like [1] or [2][3].',
  'If the context does not hold the answer, say so plainly and do not invent one.',
  'Write in plain, short paragraphs. Use Markdown lists only when they help.',
].join(' ');

/**
 * Build the chat request. When the full text of the chosen items fits `budget` tokens, every item goes in whole
 * (one number per item). Otherwise the best-matching chunks for the question go in, one number per chunk, so the
 * answer can cite a passage. Notes always count as whole items.
 * @param {{ notebook: { name: string, description?: string }, items: ContextItem[],
 *   history?: { role: 'user' | 'assistant', content: string }[], question: string, budget: number,
 *   chunks?: Map<string, { i: number, start: number, end: number, text: string }[]> }} input
 * @returns {{ messages: { role: string, content: string }[], refs: Ref[], mode: 'full' | 'passages' | 'empty', tokens: number }}
 */
export function buildChat({ notebook, items, history = [], question, budget, chunks }) {
  const head = `Notebook: ${notebook.name}${notebook.description ? `\nAbout it: ${notebook.description}` : ''}`;
  const past = history.slice(-6);
  const fixed = estimateTokens(SYSTEM_PROMPT + head + question + past.map((m) => m.content).join(''));
  /** @type {Ref[]} */
  const refs = [];
  /** @type {string[]} */
  const blocks = [];
  let mode = /** @type {'full' | 'passages' | 'empty'} */ ('empty');
  const full = items.reduce((n, it) => n + estimateTokens(it.text) + 12, 0);
  if (items.length && fixed + full <= budget) {
    mode = 'full';
    items.forEach((it, idx) => {
      refs.push({ n: idx + 1, kind: it.kind, id: it.id, title: it.title });
      blocks.push(`[${idx + 1}] ${it.kind === 'note' ? 'Note' : 'Source'}: ${it.title}\n${it.text}`);
    });
  } else if (items.length) {
    mode = 'passages';
    let room = budget - fixed;
    const docs = items.map((it) => ({ id: it.id, title: it.title, chunks: chunks?.get(it.id) ?? chunkText(it.text) }));
    const kindOf = new Map(items.map((it) => [it.id, it.kind]));
    let hits = search(buildIndex(docs), [question, ...past.filter((m) => m.role === 'user').map((m) => m.content)].join(' '), 40);
    // A question with no matching words (say, "summarise this") still gets the opening of each item.
    if (!hits.length) hits = docs.flatMap((d) => d.chunks.slice(0, 2).map((c) => ({ docId: d.id, title: d.title, chunk: c.i, text: c.text, score: 0 })));
    for (const h of hits) {
      const cost = estimateTokens(h.text) + 12;
      if (cost > room) continue;
      room -= cost;
      const n = refs.length + 1;
      refs.push({ n, kind: /** @type {'source' | 'note'} */ (kindOf.get(h.docId)), id: h.docId, title: h.title, chunk: h.chunk });
      blocks.push(`[${n}] ${kindOf.get(h.docId) === 'note' ? 'Note' : 'Source'}: ${h.title} (passage ${h.chunk + 1})\n${h.text}`);
    }
  }
  const context = blocks.length ? `Context items:\n\n${blocks.join('\n\n---\n\n')}` : 'There are no context items: no source or note is switched on for chat.';
  const messages = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${head}\n\n${context}` },
    ...past,
    { role: 'user', content: question },
  ];
  return { messages, refs, mode, tokens: estimateTokens(messages.map((m) => m.content).join('')) };
}

/**
 * The refs an answer actually cites, in order of first use. `[3]`, `[2][3]` and `[2, 3]` all count.
 * @param {string} answer @param {Ref[]} refs
 */
export function citedRefs(answer, refs) {
  const byN = new Map(refs.map((r) => [r.n, r]));
  /** @type {Ref[]} */
  const out = [];
  for (const m of String(answer ?? '').matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const part of m[1].split(',')) {
      const r = byN.get(Number(part.trim()));
      if (r && !out.includes(r)) out.push(r);
    }
  }
  return out;
}

/** A short note title from the first line of a text. @param {string} text */
export function titleFrom(text) {
  const line = String(text ?? '').replace(/[#*_`>\[\]]/g, '').split('\n').map((s) => s.trim()).find(Boolean) ?? 'Untitled';
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/** Escape text for HTML. @param {string} s */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/**
 * A small, safe Markdown renderer: everything is escaped first, then headings, lists, quotes, code, bold, italics
 * and links (http and https only) are drawn. `[n]` citations become buttons when `cite` is set.
 * @param {string} md @param {{ cite?: boolean }} [opts]
 */
export function renderMarkdown(md, { cite = false } = {}) {
  const inline = (/** @type {string} */ s) => {
    let h = esc(s);
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    if (cite) h = h.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, list) => list.split(',').map((n) => `<button class="cite" data-cite="${n.trim()}">${n.trim()}</button>`).join(''));
    return h;
  };
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {string[]} */
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      html.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(6, h[1].length + 2);
      html.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*([-*]|\d+[.)])\s+/, ''))}</li>`);
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      html.push(`<blockquote>${inline(body.join(' '))}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>|\s*([-*]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++]);
    html.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return html.join('');
}

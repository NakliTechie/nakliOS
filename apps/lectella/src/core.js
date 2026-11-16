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
  return (String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

/**
 * A light English stem, so "named" meets "name" and "launched" meets "launch". Latin-script words of four or more
 * letters lose a plural or verb ending and a final "e"; short words and other scripts stay as they are.
 * @param {string} w
 */
export function stem(w) {
  if (w.length < 4 || !/^[a-z]+$/.test(w)) return w;
  let base = w;
  for (const end of ['ies', 'ing', 'ed', 'es', 's']) {
    if (!w.endsWith(end) || w.length - end.length < 3) continue;
    if (end === 's' && /(ss|us|is)$/.test(w)) break;
    base = end === 'ies' ? `${w.slice(0, -3)}y` : w.slice(0, -end.length);
    // A doubled final consonant is undone ("stopped" → "stop"), except ll, ss and zz.
    if ((end === 'ed' || end === 'ing') && /([b-df-hj-np-tv-z])\1$/.test(base) && !/(ll|ss|zz)$/.test(base)) base = base.slice(0, -1);
    break;
  }
  return base.length >= 4 ? base.replace(/e$/, '') : base;
}

/**
 * Footnote and reference markers copied from web pages and PDFs ("[ 25 ]", "[12]", "[a]", "[citation needed]").
 * They are dropped from text sent to the model, so it cannot mistake them for this notebook's citation numbers.
 * @param {string} text
 */
export const stripMarkers = (text) =>
  String(text ?? '')
    .replace(/\[\s*(?:\d{1,4}|[a-z]|note\s*\d+|citation needed|clarification needed|when\?|who\?)\s*\](?!\()/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:])/g, '$1');

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
 * @typedef {{ kind: 'source' | 'note' | 'lorewell', id: string, title: string, text: string, work?: string, location?: string }} ContextItem
 * @typedef {{ n: number, kind: 'source' | 'note' | 'lorewell', id: string, title: string, chunk?: number, work?: string, location?: string }} Ref
 */

/** How each kind of context item is named to the model. @type {Record<string, string>} */
const KIND_LABEL = { source: 'Source', note: 'Note', lorewell: 'Book passage' };

export const SYSTEM_PROMPT = [
  'You are a research assistant working inside one notebook.',
  'Answer from the numbered context items below. Cite each claim with the item number in square brackets, like [1] or [2][3].',
  'Cite an item only when that item itself states the fact. When a claim needs two items, cite each for its own part.',
  'If the context does not hold the answer, say so plainly and do not invent one or answer from memory.',
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
      refs.push({ n: idx + 1, kind: it.kind, id: it.id, title: it.title, ...(it.work ? { work: it.work, location: it.location } : {}) });
      blocks.push(`[${idx + 1}] ${KIND_LABEL[it.kind] ?? 'Source'}: ${it.title}\n${stripMarkers(it.text)}`);
    });
  } else if (items.length) {
    mode = 'passages';
    let room = budget - fixed;
    const docs = items.map((it) => ({ id: it.id, title: it.title, chunks: chunks?.get(it.id) ?? chunkText(it.text) }));
    const kindOf = new Map(items.map((it) => [it.id, it.kind]));
    const itemOf = new Map(items.map((it) => [it.id, it]));
    // Search on the question alone. A short follow-up ("and why?") borrows the previous question's words, but
    // never the whole history, which pulled in passages for earlier topics.
    const lastUser = past.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    const query = tokenize(question).length < 3 && lastUser ? `${question} ${lastUser}` : question;
    let hits = search(buildIndex(docs), query, 40);
    // Each document that matches well puts its best passage first, so a question that spans two sources gets both.
    // "Well" is at least half the top score; weaker documents would only spend the budget on stray words.
    const firsts = [];
    const seen = new Set();
    const top = hits[0]?.score ?? 0;
    for (const h of hits) if (!seen.has(h.docId) && h.score >= top / 2) (seen.add(h.docId), firsts.push(h));
    // Then the opening passage of each of those documents, where an article states its key facts (dates, names),
    // which a question about two topics rarely ranks high.
    const openings = [];
    for (const id of seen) {
      if (firsts.some((h) => h.docId === id && h.chunk === 0)) continue;
      const doc = docs.find((dd) => dd.id === id);
      const c = doc?.chunks[0];
      if (doc && c) openings.push(hits.find((h) => h.docId === id && h.chunk === 0) ?? { docId: id, title: doc.title, chunk: 0, text: c.text, score: 0 });
    }
    const lead = [...firsts, ...openings];
    hits = [...lead, ...hits.filter((h) => !lead.some((l) => l.docId === h.docId && l.chunk === h.chunk))];
    // A question with no matching words (say, "summarise this") still gets the opening of each item.
    if (!hits.length) hits = docs.flatMap((d) => d.chunks.slice(0, 2).map((c) => ({ docId: d.id, title: d.title, chunk: c.i, text: c.text, score: 0 })));
    for (const h of hits) {
      const cost = estimateTokens(stripMarkers(h.text)) + 12;
      if (cost > room) continue;
      room -= cost;
      const n = refs.length + 1;
      const it = itemOf.get(h.docId);
      refs.push({ n, kind: /** @type {any} */ (kindOf.get(h.docId)), id: h.docId, title: h.title, chunk: h.chunk, ...(it?.work ? { work: it.work, location: it.location } : {}) });
      blocks.push(`[${n}] ${KIND_LABEL[/** @type {string} */ (kindOf.get(h.docId))] ?? 'Source'}: ${h.title} (passage ${h.chunk + 1})\n${stripMarkers(h.text)}`);
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

// ── Briefing ─────────────────────────────────────────────────────────────────────────────────────────
// A briefing runs in two steps so it works on a small in-browser model: each source is summarised on its own
// (cut to fit the budget), then the summaries are combined into one briefing that cites each source by number.

/**
 * The request that summarises one source. A source longer than the budget is cut, and the prompt says so.
 * @param {{ title: string, text: string }} item @param {number} budget
 */
export function summaryRequest(item, budget) {
  const room = Math.max(400, budget - 400) * 4;
  const clean = stripMarkers(item.text);
  const cut = clean.length > room;
  const text = cut ? `${clean.slice(0, room)}\n\n[The rest of this source was cut to fit the model.]` : clean;
  return {
    cut,
    messages: [
      { role: 'system', content: 'You summarise one source for a research briefing. Write 5 to 8 short bullet points with the main claims, numbers, names and dates in the source. Use only what the source says. No introduction.' },
      { role: 'user', content: `Source: ${item.title}\n\n${text}` },
    ],
  };
}

export const SPEAKERS = ['Asha', 'Ravi'];

/** The part of a studio note before its trailing "**Sources**" list. @param {string} md */
export const beforeSources = (md) => String(md ?? '').split(/\n\s*\*\*Sources\*\*\s*\n/)[0];

const STUDIO = {
  briefing:
    'You write a briefing document from numbered source summaries. Use these Markdown sections: "## Overview" (one paragraph), "## Key points" (bullets), "## Where sources differ" (bullets, or "None found"), and "## Open questions" (bullets). Cite every claim with the source number in square brackets, like [1]. Use only the summaries.',
  audio: `You write the script of a short two-person audio overview about the topic named below, using the facts from its sources below. ${SPEAKERS[0]} is the curious host and ${SPEAKERS[1]} explains. Talk about the topic itself, as two people who find it interesting: never mention notes, summaries, sources lists, numbers in brackets or this task. Write 12 to 18 turns. Every line starts with the speaker's name and a colon, like "${SPEAKERS[0]}: …". Spoken English, short sentences, no stage directions, no Markdown. When it helps, say which source a fact comes from by its title. Use only the notes.`,
  mindmap:
    'You turn numbered source summaries into a mind map. Answer with a Markdown outline only: a first line "# <central topic>" (at most 5 words), then nested "- " bullets indented by two spaces, 3 to 6 main branches, at most 3 levels deep, each item at most 8 words. End a leaf with the source number in square brackets, like [2], when it comes from one source.',
  slides:
    'You turn numbered source summaries into a slide deck of 6 to 9 slides. Answer in Markdown only. Start each slide with "## <slide title>", then 2 to 5 short "- " bullets. The first slide\'s heading is the deck\'s own title (never the words "Title slide"), followed by one plain subtitle line instead of bullets. Cite claims with the source number in square brackets, like [1]. Use only the summaries.',
};

/**
 * The request that combines per-source summaries into one studio output: a briefing, an audio script, a mind map
 * outline or a slide deck. [n] cites source n.
 * @param {'briefing' | 'audio' | 'mindmap' | 'slides'} kind
 * @param {{ name: string, description?: string }} notebook @param {{ n: number, title: string, summary: string }[]} parts
 */
export function studioRequest(kind, notebook, parts) {
  const body = parts.map((p) => `[${p.n}] ${p.title}\n${p.summary}`).join('\n\n');
  return [
    { role: 'system', content: STUDIO[kind] },
    { role: 'user', content: `Topic: ${notebook.description || notebook.name}\nNotebook: ${notebook.name}\n\n${body}` },
  ];
}

/** @param {{ name: string, description?: string }} notebook @param {{ n: number, title: string, summary: string }[]} parts */
export const briefingRequest = (notebook, parts) => studioRequest('briefing', notebook, parts);

/**
 * Speaker lines from a script: "Asha: text" or "**Asha:** text". Lines from no known speaker join the line before.
 * @param {string} text @returns {{ speaker: string, text: string }[]}
 */
export function parseScript(text) {
  /** @type {{ speaker: string, text: string }[]} */
  const out = [];
  for (const raw of beforeSources(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^\**\s*([\p{L}][\p{L} .'-]{0,30}?)\s*\**\s*:\s*\**\s*(.+)$/u.exec(line);
    if (m && SPEAKERS.some((sp) => sp.toLowerCase() === m[1].trim().toLowerCase())) {
      const speaker = SPEAKERS.find((sp) => sp.toLowerCase() === m[1].trim().toLowerCase());
      out.push({ speaker: /** @type {string} */ (speaker), text: m[2].replace(/\*+/g, '').trim() });
    } else if (out.length && !/^#/.test(line)) out[out.length - 1].text += ` ${line.replace(/\*+/g, '')}`;
  }
  return out.filter((l) => l.text);
}

/** @param {{ speaker: string, text: string }[]} lines */
export const scriptMarkdown = (lines) => lines.map((l) => `**${l.speaker}:** ${l.text}`).join('\n\n');

/**
 * A mind map tree from a Markdown outline: "# root" then nested "- " bullets (any consistent indent).
 * @param {string} md @returns {{ text: string, children: any[] }}
 */
export function parseOutline(md) {
  const lines = beforeSources(String(md ?? '').replace(/\r/g, '')).split('\n');
  const head = lines.find((l) => /^#\s+/.test(l.trim()));
  const root = { text: head ? head.trim().replace(/^#+\s+/, '') : 'Notebook', children: /** @type {any[]} */ ([]) };
  /** @type {{ indent: number, node: any }[]} */
  const stack = [{ indent: -1, node: root }];
  for (const l of lines) {
    const m = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/.exec(l);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '  ').length;
    const node = { text: m[2].replace(/\*\*/g, '').trim(), children: [] };
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  return root;
}

/**
 * Slides from Markdown: each "## title" starts a slide; "- " lines are bullets, other lines a subtitle.
 * @param {string} md @returns {{ title: string, bullets: string[], subtitle: string }[]}
 */
export function parseSlides(md) {
  /** @type {{ title: string, bullets: string[], subtitle: string }[]} */
  const slides = [];
  for (const raw of beforeSources(String(md ?? '').replace(/\r/g, '')).split('\n')) {
    const line = raw.trim();
    const h = /^#{1,3}\s+(.+)$/.exec(line);
    if (h) {
      slides.push({ title: h[1].trim(), bullets: [], subtitle: '' });
      continue;
    }
    if (!slides.length || !line || /^\*\*Sources\*\*$/.test(line)) continue;
    const b = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    const cur = slides[slides.length - 1];
    if (b) cur.bullets.push(b[1].trim());
    else if (!cur.bullets.length) cur.subtitle = cur.subtitle ? `${cur.subtitle} ${line}` : line;
  }
  // Small models often head the first slide "Title slide" and put the real title in bold underneath.
  const first = slides[0];
  if (first && /^title( slide)?$/i.test(first.title.replace(/[*_]/g, '').trim())) {
    const m = /^\*\*(.+?)\*\*\s*(.*)$/.exec(first.subtitle);
    if (m) {
      first.title = m[1].trim();
      first.subtitle = m[2].trim();
    } else if (first.subtitle) {
      first.title = first.subtitle;
      first.subtitle = '';
    }
  }
  for (const sl of slides) sl.subtitle = sl.subtitle.replace(/^[*_]+|[*_]+$/g, '').trim();
  return slides;
}

/**
 * Draw a mind map tree as an SVG string: the root on the left, branches to the right, one row per leaf.
 * Text is escaped; long items are cut with an ellipsis and keep their full text in a <title>.
 * @param {{ text: string, children: any[] }} root
 */
export function mindmapSvg(root) {
  const COL = 230;
  const ROW = 34;
  const MAX = 30;
  const PALETTE = ['#2e5bb8', '#3f6b2a', '#a2541a', '#7a3fa0', '#1f7a7a', '#a03f5c'];
  /** @type {{ x: number, y: number, text: string, depth: number, branch: number }[]} */
  const nodes = [];
  /** @type {{ from: any, to: any }[]} */
  const links = [];
  let leaf = 0;
  /** @param {any} n @param {number} depth @param {number} branch */
  const place = (n, depth, branch) => {
    const kids = (n.children ?? []).map((/** @type {any} */ c, /** @type {number} */ i) => place(c, depth + 1, depth === 0 ? i : branch));
    const y = kids.length ? (kids[0].y + kids[kids.length - 1].y) / 2 : leaf++ * ROW;
    const node = { x: depth * COL, y, text: String(n.text ?? ''), depth, branch };
    nodes.push(node);
    for (const k of kids) links.push({ from: node, to: k });
    return node;
  };
  place(root, 0, 0);
  const width = (Math.max(...nodes.map((n) => n.depth)) + 1) * COL + 20;
  const height = Math.max(1, leaf) * ROW + 20;
  const cut = (/** @type {string} */ t) => (t.length > MAX ? `${t.slice(0, MAX - 1).trimEnd()}…` : t);
  const boxW = (/** @type {string} */ t) => Math.min(COL - 24, cut(t).length * 7 + 18);
  const parts = links.map(({ from, to }) => {
    const x1 = from.x + boxW(from.text) + 10;
    const y1 = from.y + 10 + ROW / 2 - 7;
    const x2 = to.x + 10;
    const y2 = to.y + 10 + ROW / 2 - 7;
    const mid = (x1 + x2) / 2;
    return `<path d="M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}" fill="none" stroke="${PALETTE[to.branch % PALETTE.length]}" stroke-opacity=".55" stroke-width="1.6"/>`;
  });
  for (const n of nodes) {
    const color = n.depth === 0 ? '#1d1c19' : PALETTE[n.branch % PALETTE.length];
    const w = boxW(n.text);
    const y = n.y + 10;
    parts.push(
      `<g><title>${esc(n.text)}</title><rect x="${n.x + 10}" y="${y}" width="${w}" height="${ROW - 10}" rx="7" fill="${n.depth === 0 ? '#1d1c19' : '#fff'}" stroke="${color}" stroke-width="${n.depth === 1 ? 1.8 : 1}"/>` +
        `<text x="${n.x + 19}" y="${y + ROW / 2 - 1}" font-size="12.5" font-family="system-ui, sans-serif" fill="${n.depth === 0 ? '#fff' : '#1d1c19'}" font-weight="${n.depth <= 1 ? 600 : 400}">${esc(cut(n.text))}</text></g>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Mind map: ${esc(root.text)}">${parts.join('')}</svg>`;
}

// ── Podcast: a longer, conversational audio overview ────────────────────────────────────────────────
// Written in stages so a small model keeps up: a plan of segments, then each segment's dialogue with the end of the
// previous one in view. The two hosts react to each other in short lines of their own, which playback can overlap.

/** Segments, and turns per segment, for each length. The episode's own length shows on its note, from its word count. */
export const PODCAST_LENGTHS = /** @type {const} */ ({
  short: { label: 'Short', segments: 3, turns: 9 },
  standard: { label: 'Standard', segments: 5, turns: 11 },
  long: { label: 'Long', segments: 7, turns: 13 },
});

const HOSTS = `${SPEAKERS[0]} is the curious host who asks, reacts and sums up; ${SPEAKERS[1]} knows the material and explains it with examples.`;

/**
 * The request for a podcast plan: numbered segments, each with a title, two or three points and its source numbers.
 * @param {{ name: string, description?: string }} notebook @param {{ n: number, title: string, summary: string }[]} parts
 * @param {keyof typeof PODCAST_LENGTHS} length
 */
export function podcastPlanRequest(notebook, parts, length) {
  const { segments } = PODCAST_LENGTHS[length];
  const body = parts.map((p) => `[${p.n}] ${p.title}\n${p.summary}`).join('\n\n');
  return [
    {
      role: 'system',
      content: `You plan a two-host podcast episode about the topic below, from the numbered source notes. ${HOSTS} Plan exactly ${segments} segments that flow from an opening hook to a closing takeaway. Answer with one line per segment and nothing else, in this form:\n1. Segment title | point one; point two; point three | sources: 1, 3\nUse only facts from the notes.`,
    },
    { role: 'user', content: `Topic: ${notebook.description || notebook.name}\n\n${body}` },
  ];
}

/**
 * Segments from a plan: "1. Title | points | sources: 1, 3". Lines that do not fit are skipped.
 * @param {string} text @returns {{ title: string, points: string, sources: number[] }[]}
 */
export function parsePlan(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const m = /^\s*(?:\d+[.)]|[-*])\s*(.+)$/.exec(raw);
    if (!m) continue;
    const [title, points = '', src = ''] = m[1].split('|').map((s) => s.replace(/\*\*/g, '').trim());
    if (!title) continue;
    const sources = [...src.matchAll(/\d+/g)].map((x) => Number(x[0]));
    out.push({ title, points, sources });
  }
  return out;
}

/**
 * The request for one segment's dialogue.
 * @param {{ name: string, description?: string }} notebook @param {{ n: number, title: string, summary: string }[]} parts
 * @param {{ title: string, points: string, sources: number[] }[]} plan @param {number} i which segment
 * @param {{ speaker: string, text: string }[]} before the dialogue so far
 * @param {keyof typeof PODCAST_LENGTHS} length
 */
export function podcastSegmentRequest(notebook, parts, plan, i, before, length) {
  const { turns } = PODCAST_LENGTHS[length];
  const seg = plan[i];
  const chosen = parts.filter((p) => seg.sources.includes(p.n));
  const notes = (chosen.length ? chosen : parts).map((p) => `[${p.n}] ${p.title}\n${p.summary}`).join('\n\n');
  const position = i === 0 ? 'This is the opening segment: start with a hook, not a greeting speech.' : i === plan.length - 1 ? 'This is the last segment: end with a short takeaway and a natural sign-off.' : 'Carry on from the dialogue so far without greeting again.';
  const ending = i === plan.length - 1 ? '' : ' Never announce, tease or name the next segment; end on a line about this segment\'s subject.';
  const outline = plan.map((s, k) => `${k + 1}. ${s.title}${k === i ? '  ← this segment' : ''}`).join('\n');
  const recent = before.slice(-4).map((l) => `${l.speaker}: ${l.text}`).join('\n');
  return [
    {
      role: 'system',
      content: [
        `You write one segment of a lively two-host podcast about the topic below. ${HOSTS}`,
        `Write about ${turns} turns for this segment. ${position}${ending}`,
        'Make it sound like two people talking, not reading: contractions, short sentences, questions, a vivid example or comparison.',
        `About one turn in four is a short reaction on its own line, of one to four words, such as "Right.", "Wait, really?", "Huh.", "Exactly." or "Mm, go on." A reaction never repeats a number or a fact; facts are said once, exactly as the notes give them.`,
        `Every line starts with the speaker's name and a colon, like "${SPEAKERS[0]}: …". No stage directions, no sound effects, no Markdown, no citation numbers, no mention of notes or this task.`,
        'Use only facts from the notes. Do not repeat what was already said.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Topic: ${notebook.description || notebook.name}\n\nEpisode plan:\n${outline}\n\nThis segment: ${seg.title}. Cover: ${seg.points || seg.title}.\n\nNotes:\n${notes}${recent ? `\n\nThe dialogue so far ended with:\n${recent}` : ''}`,
    },
  ];
}

/** A short reaction line ("Right.", "Wait, really?"), which playback may start before the last line ends. @param {string} text */
export const isReaction = (text) => {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 4 && String(text).length <= 30;
};

/**
 * A podcast note's lines, each with its segment: "### Segment title" headings separate segments.
 * @param {string} md @returns {{ speaker: string, text: string, segment: number }[]}
 */
export function parseEpisode(md) {
  const out = [];
  let segment = 0;
  let seen = false;
  for (const block of beforeSources(md).split(/^###\s+/m)) {
    if (!block.trim()) continue;
    const lines = parseScript(block);
    if (seen && lines.length) segment++;
    if (lines.length) seen = true;
    for (const l of lines) out.push({ ...l, segment });
  }
  return out;
}

/**
 * Split a short reaction that opens a longer line ("Wait, really? It burst in 1919.") into a line of its own, so
 * playback can start it over the end of the line before. Models tend to glue the two together.
 * @param {{ speaker: string, text: string }[]} lines
 */
export function splitReactions(lines) {
  const out = [];
  for (const l of lines) {
    const m = /^((?:[^\s.!?]+[\s,]+){0,3}[^\s.!?]+[.!?]+)\s+(\S.*)$/u.exec(l.text);
    if (m && isReaction(m[1]) && m[2].trim().split(/\s+/).length >= 3) out.push({ ...l, text: m[1] }, { ...l, text: m[2] });
    else out.push(l);
  }
  return out;
}

/** Spoken minutes for a script, at about 150 words a minute. @param {{ text: string }[]} lines */
export const spokenMinutes = (lines) => Math.max(1, Math.round(lines.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0) / 150));

/** A line that announces what comes next ("For our next segment…", "Coming up…"), which must not end a segment. */
const TEASER = /\b(next segment|next part|coming up|after the break|stay tuned|in our next|up next|let'?s move on to|moving on to|we'?ll (look at|talk about|turn to|get to)|we'?re (going|about) to (look at|talk about|turn to))\b/i;

/** Drop teaser lines from the end of a segment. @param {{ speaker: string, text: string }[]} lines */
export function dropTeasers(lines) {
  const out = [...lines];
  while (out.length > 1 && TEASER.test(out[out.length - 1].text)) out.pop();
  return out;
}

/**
 * Fit a plan to the length asked for: too many segments keep the first ones and the closing one; too few stay as
 * they are (the caller asks once more first).
 * @param {{ title: string, points: string, sources: number[] }[]} plan @param {number} target
 */
export function fitPlan(plan, target) {
  if (plan.length <= target) return plan;
  return [...plan.slice(0, target - 1), plan[plan.length - 1]];
}

const BACKCHANNELS = ['Right.', 'Mm-hm.', 'Okay.', 'I see.', 'Huh.'];

/**
 * Give a long explanation a listener: split a line of 30 or more words at the sentence break nearest its middle,
 * and put a short reaction from the other host between the halves. At most every third line gets one, and the
 * reactions rotate, so they never repeat back to back.
 * @param {{ speaker: string, text: string }[]} lines @param {string[]} hosts the two speaker names
 */
export function addBackchannels(lines, hosts) {
  const out = [];
  let since = 3;
  let k = 0;
  for (const l of lines) {
    since++;
    const words = l.text.split(/\s+/).filter(Boolean);
    const other = hosts.find((h) => h !== l.speaker);
    if (since >= 3 && other && words.length >= 30) {
      const breaks = [...l.text.matchAll(/[.!?]["”’)]?\s+(?=[A-Z0-9“"‘(])/g)].map((m) => /** @type {number} */ (m.index) + m[0].length);
      const mid = l.text.length / 2;
      const cut = breaks.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
      if (cut && cut > 40 && l.text.length - cut > 40) {
        out.push({ ...l, text: l.text.slice(0, cut).trim() }, { ...l, speaker: other, text: BACKCHANNELS[k++ % BACKCHANNELS.length] }, { ...l, text: l.text.slice(cut).trim() });
        since = 0;
        continue;
      }
    }
    out.push(l);
  }
  return out;
}

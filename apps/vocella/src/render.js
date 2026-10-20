// Render a card the way Anki does: fill the note type's template from the note's fields, then wrap the
// result with the note type's CSS in a document for a sandboxed frame (no scripts run, nothing loads from
// the network).
//
// Template syntax covered: {{Field}}, {{#Field}}…{{/Field}}, {{^Field}}…{{/Field}}, {{FrontSide}}, the
// special fields Tags, Type, Deck, Subdeck, Card, CardFlag, and the filters text, cloze, cloze-only, hint,
// type, furigana, kana, kanji and tts (spoken text is shown as text). Filters apply right to left, as in
// Anki. [sound:…] tags become audio players. Image Occlusion cards get their masks drawn as SVG over the
// image, because Anki's own drawing script never runs here. Media names and formulas are resolved later, by
// media.js and math.js, once the card's HTML is final.

/** @typedef {import('./apkg.js').Collection} Collection */
/** @typedef {import('./apkg.js').Card} Card */
/** @typedef {{ question: string, answer: string, css: string, ord: number }} RenderedCard */

/** @typedef {{ type: 'text', text: string } | { type: 'var', name: string } | { type: 'if', name: string, negate: boolean, children: Node[] }} Node */

/**
 * @param {Collection} col
 * @param {Card} card
 * @returns {RenderedCard}
 */
export function renderCard(col, card) {
  const note = col.notes.get(card.nid);
  if (!note) throw new Error(`Card ${card.id} points to a missing note ${card.nid}.`);
  const nt = col.noteTypes.get(note.mid);
  if (!nt) throw new Error(`Note ${note.id} points to a missing note type ${note.mid}.`);
  const template = nt.cloze ? nt.templates[0] : nt.templates.find((t) => t.ord === card.ord);
  if (!template) throw new Error(`Note type "${nt.name}" has no template ${card.ord + 1}.`);

  /** @type {Record<string, string>} */
  const fields = {};
  nt.fields.forEach((name, i) => (fields[name] = note.fields[i] ?? ''));
  const deckName = col.decks.find((d) => d.id === card.did)?.path ?? [];
  const special = {
    Tags: note.tags,
    Type: nt.name,
    Deck: deckName.join('::'),
    Subdeck: deckName.at(-1) ?? '',
    Card: template.name,
    CardFlag: '',
  };
  const cloze = nt.cloze ? card.ord + 1 : 0;

  let question = render(parse(template.qfmt), { fields, special, cloze, answer: false, frontSide: '' });
  const frontSide = question.replace(/<input class="vc-typeans"[^>]*>/g, '');
  let answer = render(parse(template.afmt), { fields, special, cloze, answer: true, frontSide });
  if (template.qfmt.includes('image-occlusion-container') && 'Occlusion' in fields) {
    const shapes = occlusions(fields.Occlusion);
    question = withMasks(question, shapes, cloze, false);
    answer = withMasks(answer, shapes, cloze, true);
  }
  return { question, answer, css: nt.css, ord: card.ord };
}

/**
 * Parse a template into a tree of text, replacements and conditional sections.
 * @param {string} src
 * @returns {Node[]}
 */
export function parse(src) {
  /** @type {Node[]} */
  const root = [];
  /** @type {{ name: string, children: Node[] }[]} */
  const stack = [{ name: '', children: root }];
  const re = /\{\{(.*?)\}\}/gs;
  let last = 0;
  for (const m of src.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.children.push({ type: 'text', text: src.slice(last, m.index) });
    last = m.index + m[0].length;
    const tag = m[1].trim();
    if (tag.startsWith('#') || tag.startsWith('^')) {
      /** @type {Node} */
      const node = { type: 'if', name: tag.slice(1).trim(), negate: tag[0] === '^', children: [] };
      top.children.push(node);
      stack.push({ name: node.name, children: node.children });
    } else if (tag.startsWith('/')) {
      // Anki rejects a mismatched close; a reader shows what it can, so it closes back to the matching open.
      const name = tag.slice(1).trim();
      const at = stack.findLastIndex((s, i) => i > 0 && s.name === name);
      if (at > 0) stack.length = at;
    } else {
      top.children.push({ type: 'var', name: tag });
    }
  }
  if (last < src.length) stack[stack.length - 1].children.push({ type: 'text', text: src.slice(last) });
  return root;
}

/** @typedef {{ fields: Record<string, string>, special: Record<string, string>, cloze: number, answer: boolean, frontSide: string }} Ctx */

/** @param {Node[]} nodes @param {Ctx} ctx @returns {string} */
function render(nodes, ctx) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.text;
    else if (n.type === 'if') {
      if (nonEmpty(lookup(ctx, n.name) ?? '') !== n.negate) out += render(n.children, ctx);
    } else out += replacement(n.name, ctx);
  }
  return out
    .replace(/\[anki:tts\b([^\]]*)\]([\s\S]*?)\[\/anki:tts\]/gi, (_, opts, text) => speakable(/lang=([\w-]+)/.exec(opts)?.[1] ?? '', text))
    .replace(/\[sound:([^\]]+)\]/g, (_, name) => `<audio class="vc-sound" controls preload="none" src="${escapeHtml(name.trim())}"></audio>`);
}

/** @param {Ctx} ctx @param {string} name @returns {string | undefined} */
function lookup(ctx, name) {
  if (name === 'FrontSide') return ctx.frontSide;
  if (name in ctx.fields) return ctx.fields[name];
  if (name in ctx.special) return ctx.special[name];
  const lower = name.toLowerCase();
  const key = Object.keys(ctx.fields).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : ctx.fields[key];
}

/** @param {string} tag @param {Ctx} ctx */
function replacement(tag, ctx) {
  const parts = tag.split(':');
  const name = parts.pop()?.trim() ?? '';
  const filters = parts.map((f) => f.trim());
  let value = lookup(ctx, name);
  if (value === undefined) return `<span class="vc-missing">{{${escapeHtml(tag)}}}: unknown field</span>`;

  if (filters.includes('type')) {
    if (!ctx.answer) return '<input class="vc-typeans" type="text" aria-label="Type the answer" autocomplete="off">';
    const expected = filters.includes('cloze') ? clozeOnly(value, ctx.cloze) : stripHtml(value);
    return `<div id="typeans"><code>${escapeHtml(expected)}</code></div>`;
  }
  for (const f of filters.reverse()) value = applyFilter(f, value, ctx);
  return value;
}

/** @param {string} filter @param {string} value @param {Ctx} ctx */
function applyFilter(filter, value, ctx) {
  switch (filter) {
    case 'text':
      return stripHtml(value);
    case 'cloze':
      return renderCloze(value, ctx.cloze, ctx.answer);
    case 'cloze-only':
      return clozeOnly(value, ctx.cloze);
    case 'hint':
      return nonEmpty(value) ? `<details class="hint"><summary>Show hint</summary>${value}</details>` : '';
    case 'furigana':
      return value.replace(RUBY, (_, base, reading) => `<ruby><rb>${base}</rb><rt>${reading}</rt></ruby>`);
    case 'kana':
      return value.replace(RUBY, (_, _base, reading) => reading);
    case 'kanji':
      return value.replace(RUBY, (_, base) => base);
    default:
      if (filter.startsWith('tts ')) return speakable(filter.split(/\s+/)[1] ?? '', value);
      return value; // unknown filters: show the field as it is
  }
}

/**
 * Text to read aloud, shown as text with a Speak button. The frame runs no scripts, so the page wires the
 * button to the browser's speech synthesis. lang is Anki's form, e.g. en_US.
 * @param {string} lang @param {string} html
 */
function speakable(lang, html) {
  const text = stripHtml(html).trim();
  if (!text) return html;
  return `<span class="vc-tts">${html}</span> <button type="button" class="vc-speak" data-lang="${escapeHtml(lang)}" data-text="${escapeHtml(text)}">Speak</button>`;
}

/** Anki's ruby syntax: an optional leading space, the base text, then the reading in brackets. */
const RUBY = / ?([^ >[]+?)\[(.+?)\]/g;

/** @typedef {string | { n: number, content: ClozePart[], hint: string }} ClozePart */

/**
 * Split cloze text into plain text and (possibly nested) {{cN::content::hint}} deletions.
 * @param {string} s
 * @returns {ClozePart[]}
 */
function parseCloze(s) {
  /** @type {{ n: number, content: ClozePart[] }[]} */
  const stack = [{ n: 0, content: [] }];
  let i = 0;
  let text = '';
  const flush = () => {
    if (text) stack[stack.length - 1].content.push(text);
    text = '';
  };
  while (i < s.length) {
    const open = /^\{\{c(\d+)::/.exec(s.slice(i, i + 12));
    if (open) {
      flush();
      stack.push({ n: Number(open[1]), content: [] });
      i += open[0].length;
    } else if (s.startsWith('}}', i) && stack.length > 1) {
      flush();
      const done = /** @type {{ n: number, content: ClozePart[] }} */ (stack.pop());
      stack[stack.length - 1].content.push({ n: done.n, ...splitHint(done.content) });
      i += 2;
    } else {
      text += s[i++];
    }
  }
  flush();
  // An unclosed deletion shows as written.
  while (stack.length > 1) {
    const open = /** @type {{ n: number, content: ClozePart[] }} */ (stack.pop());
    stack[stack.length - 1].content.push(`{{c${open.n}::`, ...open.content);
  }
  return stack[0].content;
}

/** The hint follows the last "::" in the deletion's own text. @param {ClozePart[]} content */
function splitHint(content) {
  const last = content.at(-1);
  if (typeof last === 'string' && last.includes('::')) {
    const at = last.lastIndexOf('::');
    const rest = last.slice(0, at);
    return { content: [...content.slice(0, -1), ...(rest ? [rest] : [])], hint: last.slice(at + 2) };
  }
  return { content, hint: '' };
}

/** @param {string} value @param {number} n @param {boolean} answer */
export function renderCloze(value, n, answer) {
  /** @param {ClozePart[]} parts @returns {string} */
  const walk = (parts) =>
    parts
      .map((p) => {
        if (typeof p === 'string') return p;
        if (isOcclusion(p)) return ''; // Image Occlusion shapes are drawn by withMasks, not shown as text
        if (p.n !== n) return walk(p.content);
        if (answer) return `<span class="cloze">${walk(p.content)}</span>`;
        return `<span class="cloze">[${p.hint || '...'}]</span>`;
      })
      .join('');
  return walk(parseCloze(value));
}

/** @param {Exclude<ClozePart, string>} p */
const isOcclusion = (p) => typeof p.content[0] === 'string' && p.content[0].startsWith('image-occlusion:');

/** @typedef {{ n: number, shape: string, props: Record<string, string> }} Occlusion */

/**
 * The shapes of an Image Occlusion note: each {{cN::image-occlusion:shape:key=value:…}} in its Occlusion
 * field. Coordinates are fractions of the image's width and height.
 * @param {string} field
 * @returns {Occlusion[]}
 */
export function occlusions(field) {
  /** @type {Occlusion[]} */
  const out = [];
  /** @param {ClozePart[]} parts */
  const walk = (parts) => {
    for (const p of parts) {
      if (typeof p === 'string') continue;
      if (isOcclusion(p)) {
        const [, shape, ...pairs] = String(p.content[0]).split(':');
        out.push({ n: p.n, shape, props: Object.fromEntries(pairs.map((kv) => kv.split('=')).filter((kv) => kv.length === 2)) });
      } else walk(p.content);
    }
  };
  walk(parseCloze(field));
  return out;
}

/**
 * Draw the occlusion masks over the image, in place of Anki's canvas. The card's own deletion is masked on
 * the question and outlined on the answer; the others are masked on both sides when the note hides all
 * shapes (oi=1), and not drawn otherwise.
 * @param {string} html @param {Occlusion[]} shapes @param {number} n @param {boolean} answer
 */
export function withMasks(html, shapes, n, answer) {
  const num = (/** @type {string | undefined} */ v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const marks = shapes
    .map((s) => {
      const active = s.n === n;
      if (!active && s.props.oi !== '1') return '';
      const cls = active ? (answer ? 'vc-io-shown' : 'vc-io-active') : 'vc-io-inactive';
      const p = s.props;
      if (s.shape === 'rect') return `<rect class="${cls}" x="${num(p.left)}" y="${num(p.top)}" width="${num(p.width)}" height="${num(p.height)}"/>`;
      if (s.shape === 'ellipse') {
        return `<ellipse class="${cls}" cx="${num(p.left) + num(p.rx)}" cy="${num(p.top) + num(p.ry)}" rx="${num(p.rx)}" ry="${num(p.ry)}"/>`;
      }
      if (s.shape === 'polygon' && p.points) return `<polygon class="${cls}" points="${escapeHtml(p.points)}"/>`;
      return ''; // text labels and unknown shapes are not drawn
    })
    .join('');
  const svg = `<svg class="vc-io-masks" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">${marks}</svg>`;
  return html.replace(/<canvas id="image-occlusion-canvas"><\/canvas>/g, svg).replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

/** @param {string} value @param {number} n */
function clozeOnly(value, n) {
  /** @type {string[]} */
  const found = [];
  /** @param {ClozePart[]} parts @returns {string} */
  const text = (parts) => parts.map((p) => (typeof p === 'string' ? p : text(p.content))).join('');
  /** @param {ClozePart[]} parts */
  const walk = (parts) => {
    for (const p of parts) {
      if (typeof p === 'string') continue;
      if (p.n === n) found.push(stripHtml(text(p.content)));
      else walk(p.content);
    }
  };
  walk(parseCloze(value));
  return found.join(', ');
}

/** A field counts as filled when it has text other than whitespace once tags are removed. @param {string} s */
const nonEmpty = (s) => stripHtml(s).trim() !== '';

/** @param {string} s */
export function stripHtml(s) {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** @param {string} s */
export const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Content Security Policy for the card frame: inline styles and data: images only, no scripts, no network. */
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; font-src data: blob:";

/** Vocella's own styles for what Anki's built-in stylesheet would add. */
const BASE_CSS = `
html, body { margin: 0; padding: 0; }
body { padding: 1.25rem; }
.card { background-color: white; color: black; }
.nightMode.card { background-color: #2c2c2b; color: #ecece8; }
.cloze { font-weight: bold; color: blue; }
.nightMode .cloze { color: lightblue; }
.vc-typeans { font: inherit; width: min(100%, 20em); padding: .25em .4em; }
.vc-missing { color: #b00; font-family: monospace; font-size: .8em; }
details.hint summary { cursor: pointer; color: #36c; }
img { max-width: 100%; height: auto; }
#image-occlusion-container { position: relative; display: inline-block; }
#image-occlusion-container img { display: block; }
.vc-io-masks { position: absolute; inset: 0; width: 100%; height: 100%; }
.vc-io-masks * { vector-effect: non-scaling-stroke; stroke: #212121; stroke-width: 1px; }
.vc-io-active { fill: #ff8e8e; }
.vc-io-inactive { fill: #ffeba2; }
.vc-io-shown { fill: none; stroke: #ff8e8e; stroke-width: 2px; }
.vc-math-error { font-family: monospace; color: #b00; }
.vc-speak { font: inherit; font-size: .75em; padding: .1em .6em; border: 1px solid #c8c8c2; border-radius: 6px; background: #fff; color: #2f5fd0; cursor: pointer; vertical-align: middle; }
.nightMode .vc-speak { background: #222; color: #8fb0ff; border-color: #444; }
#typeans { font-family: monospace; }
.typeGood { background: #afa; color: black; }
.typeBad { background: #faa; color: black; }
.typeMissed { background: #ccc; color: black; }
`;

/**
 * The frame document for one side of a card. The body gets Anki's classes (`card`, `cardN`, and the
 * night-mode classes Anki desktop and AnkiDroid set), so deck CSS written for Anki applies unchanged.
 * @param {string} html @param {string} css @param {number} ord @param {boolean} dark
 */
export function cardDocument(html, css, ord, dark) {
  const night = dark ? ' nightMode night_mode' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>${BASE_CSS}</style><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head>
<body class="card card${ord + 1}${night}"><div id="qa">${html}</div></body></html>`;
}

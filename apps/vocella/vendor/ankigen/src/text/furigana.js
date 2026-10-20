// @ts-check
// Example sentences and Japanese readings (DATA_FORMAT §6).
//   Furigana, Anki-style: 漢字[かな]. A kanji run that follows other text is preceded by one space,
//   which belongs to the markup and is removed: お 茶[ちゃ]を → お<ruby>茶<rt>ちゃ</rt></ruby>を.
//   Target: exactly one {…} per sentence → <b class="t">…</b>. Braces end a furigana base, like the
//   tag boundary in Anki's furigana filter.
// Input is plain data text; all output is escaped HTML.

import { escapeHtml } from './html.js';

/** Anki's base rule: a run of non-space characters right before [reading]. */
const FURIGANA = / ?([^ [\]{}]+?)\[([^\]]*)\]/g;
const TARGET = /\{([^{}]*)\}/;
const KANJI = /[\p{Script=Han}々〆ヶ]/u;

/** @param {string} part text without braces */
function rubyPart(part) {
  let out = '';
  let last = 0;
  for (const m of part.matchAll(FURIGANA)) {
    out += escapeHtml(part.slice(last, m.index)) + `<ruby>${escapeHtml(m[1])}<rt>${escapeHtml(m[2])}</rt></ruby>`;
    last = (m.index ?? 0) + m[0].length;
  }
  return out + escapeHtml(part.slice(last));
}

/** Remove readings and their separator spaces: 私[わたし]は 水[みず] → 私は水. @param {string} text */
export function stripFurigana(text) {
  return text.replace(FURIGANA, '$1');
}

/** Remove the target braces. @param {string} text */
export function stripTarget(text) {
  return text.replace(/[{}]/g, '');
}

/**
 * Example sentence → HTML with the target in <b class="t">.
 * @param {string} text sentence with one {target}; Japanese may carry furigana
 * @param {{ furigana?: 'ruby' | 'strip' }} [opts] Japanese only: show readings as ruby, or drop them
 */
export function exampleHtml(text, { furigana } = {}) {
  /** @param {string} part */
  const render = (part) => (furigana === 'ruby' ? rubyPart(part) : escapeHtml(furigana === 'strip' ? stripFurigana(part) : part));
  const m = TARGET.exec(text);
  if (!m) return render(text);
  const before = text.slice(0, m.index);
  const after = text.slice(m.index + m[0].length);
  return `${render(before)}<b class="t">${render(m[1])}</b>${render(stripTarget(after))}`;
}

/** @param {string} ch */
function isKana(ch) {
  return /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u.test(ch);
}

/** @param {string} ch */
function hiragana(ch) {
  const c = ch.codePointAt(0) ?? 0;
  return c >= 0x30a1 && c <= 0x30f6 ? String.fromCodePoint(c - 0x60) : ch;
}

/**
 * The word with its reading as ruby. The reading belongs to the whole word, so the ruby spans the
 * kanji part; kana that the word and its reading share at the start or end (okurigana, honorific お)
 * stay outside: 食べる + たべる → <ruby>食<rt>た</rt></ruby>べる.
 * @param {string} word
 * @param {string | undefined} reading
 */
export function wordRubyHtml(word, reading) {
  if (!reading || !KANJI.test(word)) return escapeHtml(word);
  const w = [...word];
  const r = [...reading];
  const same = (/** @type {string} */ a, /** @type {string} */ b) => isKana(a) && hiragana(a) === hiragana(b);
  let start = 0;
  while (start < w.length && start < r.length && same(w[start], r[start])) start++;
  let end = 0;
  while (end < w.length - start && end < r.length - start && same(w[w.length - 1 - end], r[r.length - 1 - end])) end++;
  const base = w.slice(start, w.length - end).join('');
  const rt = r.slice(start, r.length - end).join('');
  if (!rt) return `<ruby>${escapeHtml(word)}<rt>${escapeHtml(reading)}</rt></ruby>`;
  return `${escapeHtml(w.slice(0, start).join(''))}<ruby>${escapeHtml(base)}<rt>${escapeHtml(rt)}</rt></ruby>${escapeHtml(w.slice(w.length - end).join(''))}`;
}

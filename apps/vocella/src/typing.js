// Compare a typed answer with the expected one the way Anki shows it: the typed line with each character
// marked right or wrong, an arrow, then the expected line with the characters that were missed. An exact
// match shows the answer once, all marked right.

import { escapeHtml } from './render.js';

/**
 * Character diff by longest common subsequence.
 * @param {string} a typed  @param {string} b expected
 * @returns {{ typed: [string, boolean][], expected: [string, boolean][] }}  [char, matched]
 */
export function diffChars(a, b) {
  const A = [...a];
  const B = [...b];
  const L = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  /** @type {[string, boolean][]} */
  const typed = [];
  /** @type {[string, boolean][]} */
  const expected = [];
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      typed.push([A[i++], true]);
      expected.push([B[j++], true]);
    } else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) expected.push([B[j++], false]);
    else typed.push([A[i++], false]);
  }
  return { typed, expected };
}

/** @param {[string, boolean][]} chars @param {string} good @param {string} bad */
function marked(chars, good, bad) {
  /** @type {string[]} */
  const out = [];
  for (const [c, ok] of chars) {
    const cls = ok ? good : bad;
    const last = out.length - 1;
    if (last >= 0 && out[last].startsWith(`<span class="${cls}">`)) out[last] = out[last].replace(/<\/span>$/, `${escapeHtml(c)}</span>`);
    else out.push(`<span class="${cls}">${escapeHtml(c)}</span>`);
  }
  return out.join('');
}

/**
 * The comparison HTML for the answer side.
 * @param {string} typed @param {string} expected
 */
export function compareTyped(typed, expected) {
  const t = typed.trim();
  if (!t) return `<code id="typeans">${escapeHtml(expected)}</code>`;
  if (t === expected) return `<code id="typeans">${marked([...t].map((c) => [c, true]), 'typeGood', 'typeBad')}</code>`;
  const d = diffChars(t, expected);
  return `<code id="typeans">${marked(d.typed, 'typeGood', 'typeBad')}<br><span id="typearrow">&darr;</span><br>${marked(d.expected, 'typeGood', 'typeMissed')}</code>`;
}

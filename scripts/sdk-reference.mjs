#!/usr/bin/env node
// U1 (2026-09-13): the SDK is ONE document — docs/app-contract.md. Its `## Reference` section names
// every public member of `sdk/naklios.js`, rendered here from the ledger (docs/sdk-api-audit.md,
// which stays the audit: status and criteria) so the two cannot drift: `--write` re-renders the
// block between the markers; `--check` (the gate) is red when the rendered block is not what the
// ledger says — a member added to the ledger and not re-rendered, or a row hand-edited in place.
//
//   node scripts/sdk-reference.mjs --write     re-render docs/app-contract.md
//   node scripts/sdk-reference.mjs --check     exit 1 on drift (the gate lane)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LEDGER = join(HERE, '..', 'docs', 'sdk-api-audit.md');
export const DOC = join(HERE, '..', 'docs', 'app-contract.md');
export const BEGIN = '<!-- sdk-reference:begin — rendered by `node scripts/sdk-reference.mjs --write` from docs/sdk-api-audit.md; do not edit by hand -->';
export const END = '<!-- sdk-reference:end -->';

// THE ledger parser — the audit lane (scripts/test-sdk-audit.mjs) imports this one too, so the two
// cannot disagree about what a row is. Every line that starts `| \`` is a member row and MUST parse:
// a note with a `|` in it, a missing column, a second row for the same member — each is an error
// here, never a silently skipped member (the checker's finding, 2026-09-13: a `|` in one note made
// a member vanish from the reference with every lane green).
export function ledgerRows(text) {
  const rows = []; const seen = new Set();
  // only the member table: from its header row to the first blank line after it
  const start = text.indexOf('| member | kind | status |');
  if (start < 0) throw new Error('docs/sdk-api-audit.md: the member table (| member | kind | status | …) is missing');
  const endAt = text.indexOf('\n\n', start);
  const table = text.slice(start, endAt < 0 ? undefined : endAt);
  for (const line of table.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 5) throw new Error(`docs/sdk-api-audit.md: a member row must have exactly five cells (a \`|\` inside a note breaks it): ${line}`);
    const member = cells[0].replace(/^`|`$/g, '');
    if (!/^(getter|function|namespace|field)$/.test(cells[1])) throw new Error(`docs/sdk-api-audit.md: unknown kind "${cells[1]}" for ${member}`);
    if (seen.has(member)) throw new Error(`docs/sdk-api-audit.md: two rows for ${member}`);
    seen.add(member);
    rows.push({ member, kind: cells[1], status: cells[2], criteria: cells[3], note: cells[4] });
  }
  return rows;
}

// Grouped by top-level namespace, in the ledger's own order; a namespace row heads its group.
export function renderReference(rows) {
  const groups = new Map();
  for (const r of rows) {
    const top = r.member.includes('.') ? r.member.split('.')[0] : r.member;
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(r);
  }
  const out = [BEGIN, '', `${rows.length} public members. Kinds: getter · function · namespace · field. Status and stabilization criteria live in the ledger (\`docs/sdk-api-audit.md\`); an \`experimental_\` member is named here like any other and marked so.`, ''];
  for (const [top, list] of groups) {
    const head = list.find((r) => r.member === top);
    out.push(`### \`${top}\`${head && head.kind === 'namespace' ? ' (namespace)' : ''}`, '');
    out.push('| member | kind | what it is |', '|---|---|---|');
    for (const r of list) out.push(`| \`${r.member}\` | ${r.kind}${r.status === 'experimental' ? ' · **experimental**' : ''} | ${r.note || '—'} |`);
    out.push('');
  }
  out.push(END);
  return out.join('\n');
}

export function currentBlock(doc) {
  const a = doc.indexOf(BEGIN), b = doc.indexOf(END);
  if (a < 0 || b < 0 || b < a) return null;
  if (doc.indexOf(BEGIN, a + 1) >= 0 || doc.indexOf(END, b + 1) >= 0) return null; // two blocks: one is stale
  return doc.slice(a, b + END.length);
}

export function splice(doc, block) {
  const cur = currentBlock(doc);
  if (cur === null) throw new Error('docs/app-contract.md has no sdk-reference markers');
  return doc.replace(cur, () => block);
}

export function check({ ledger = readFileSync(LEDGER, 'utf8'), doc = readFileSync(DOC, 'utf8') } = {}) {
  let rows, want; try { rows = ledgerRows(ledger); want = renderReference(rows); } catch (e) { return { ok: false, why: e.message }; }
  const have = currentBlock(doc);
  if (have === null) return { ok: false, why: 'no single sdk-reference block in docs/app-contract.md (missing, reversed, or duplicated markers)' };
  if (have === want) return { ok: true, why: '', members: rows.length };
  const w = want.split('\n'), h = have.split('\n');
  let i = 0; while (i < w.length && i < h.length && w[i] === h[i]) i++;
  return { ok: false, why: `line ${i + 1} of the block: rendered "${(h[i] || '').slice(0, 80)}" vs ledger "${(w[i] || '').slice(0, 80)}"` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const write = process.argv.includes('--write'), chk = process.argv.includes('--check');
  if (!write && !chk) { console.error('usage: node scripts/sdk-reference.mjs --write | --check'); process.exit(2); }
  if (write) {
    const doc = readFileSync(DOC, 'utf8');
    const rows = ledgerRows(readFileSync(LEDGER, 'utf8'));
    writeFileSync(DOC, splice(doc, renderReference(rows)));
    console.log(`sdk-reference: rendered ${rows.length} members into docs/app-contract.md`);
  }
  const r = check();
  if (!r.ok) { console.error(`sdk-reference: DRIFT — ${r.why}\nRe-render with \`node scripts/sdk-reference.mjs --write\` after reading the change.`); process.exit(1); }
  console.log(`sdk-reference: docs/app-contract.md names all ${r.members} SDK members, as the ledger has them`);
}

// The "wide" tier (2026-10-30, plan/2026-10-30-droid-mechanisms-rebuild-plan.md, Phase 1): six tasks that
// need the same small operation on 12 to 16 files. They exist to test Script mode (the `codemode` tool):
// the base battery's tasks take 2 to 5 model steps, too few for a program that makes many tool calls to
// save anything. Each task can also be done with direct calls, one file at a time. Every expected value is
// computed from the seed below, never typed by hand. `solve` is a scripted answer used only to check that
// the gate passes on a correct workspace (scripts/autoharness/check-wide.mjs).
import { all, ok, no, onlyChanged, fileEq, write, say } from './gates.mjs';

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const pad = (n) => String(n).padStart(2, '0');

// 1. wide-add-total: add a computed field to 12 JSON files, then summarise.
const r1 = rng(101);
const REC = Array.from({ length: 12 }, (_, i) => ({ file: `data/rec${pad(i + 1)}.json`, name: `r${pad(i + 1)}`, a: Math.floor(r1() * 90) + 10, b: Math.floor(r1() * 90) + 10 }));
const recText = (r, total) => JSON.stringify({ name: r.name, a: r.a, b: r.b, ...(total ? { total: r.a + r.b } : {}) }, null, 2) + '\n';
const wideAddTotal = {
  id: 'wide-add-total', split: 'wide', seed: Object.fromEntries(REC.map((r) => [r.file, recText(r, false)])),
  prompt: 'Each file in data/ is a JSON object with the numbers a and b. Add a field "total" equal to a + b to every file, keeping the other fields. Then write summary.txt with one line per file, in filename order, formatted as "<filename> <total>" (for example "rec01.json 57").',
  gate: all(
    (c) => { for (const r of REC) { let o; try { o = JSON.parse(c.file(r.file) || ''); } catch (_) { return no(`${r.file} is not valid JSON`); } if (o.name !== r.name || o.a !== r.a || o.b !== r.b || o.total !== r.a + r.b) return no(`${r.file} is wrong`); } return ok(); },
    fileEq('summary.txt', REC.map((r) => `${r.file.split('/')[1]} ${r.a + r.b}`).join('\n')),
    onlyChanged(['data/', 'summary.txt'])),
  solve: [...REC.map((r) => write(r.file, recText(r, true))), write('summary.txt', REC.map((r) => `${r.file.split('/')[1]} ${r.a + r.b}`).join('\n') + '\n'), say('Done.')],
};

// 2. wide-versions-table: read a field from 14 package files and write a sorted table.
const r2 = rng(202);
const WORDS = ['alpha', 'bravo', 'cedar', 'delta', 'ember', 'fjord', 'gamma', 'harbor', 'iris', 'jade', 'kilo', 'lumen', 'maple', 'nova'];
const PKG = WORDS.map((w, i) => ({ file: `pkgs/p${pad(i + 1)}/package.json`, name: `@acme/${w}`, version: `${Math.floor(r2() * 4)}.${Math.floor(r2() * 20)}.${Math.floor(r2() * 10)}` }));
const pkgsSorted = [...PKG].sort((a, b) => (a.name < b.name ? -1 : 1));
const versionsMd = '| name | version |\n| --- | --- |\n' + pkgsSorted.map((p) => `| ${p.name} | ${p.version} |`).join('\n');
const wideVersions = {
  id: 'wide-versions-table', split: 'wide', seed: Object.fromEntries(PKG.map((p) => [p.file, JSON.stringify({ name: p.name, version: p.version, private: true }, null, 2) + '\n'])),
  prompt: 'Every pkgs/*/package.json has a name and a version. Write VERSIONS.md as a markdown table with the header row "| name | version |", the separator row "| --- | --- |", then one row "| <name> | <version> |" per package, sorted by name. Do not change the package files.',
  gate: all(fileEq('VERSIONS.md', versionsMd), onlyChanged(['VERSIONS.md'])),
  solve: [write('VERSIONS.md', versionsMd + '\n'), say('Done.')],
};

// 3. wide-fix-typo: fix a misspelling in 8 of 12 docs; 4 must stay byte-identical.
const r3 = rng(303);
const hasTypo = Array.from({ length: 12 }, (_, i) => [0, 2, 3, 5, 6, 8, 9, 11].includes(i));
const TYPO = ['recieve', 'recieved', 'recieves'];
const docText = (i, fixed) => {
  const t = hasTypo[i] ? (fixed ? ['receive', 'received', 'receives'] : TYPO)[Math.floor(r3() * 3)] : 'handle';
  return `# Note ${pad(i + 1)}\n\nThe service will ${t} the request and log it.\nSee section ${i + 1} for details.\n`;
};
const DOCS = Array.from({ length: 12 }, (_, i) => { const before = (() => { const g = rng(900 + i); const t = hasTypo[i] ? TYPO[Math.floor(g() * 3)] : 'handle'; return `# Note ${pad(i + 1)}\n\nThe service will ${t} the request and log it.\nSee section ${i + 1} for details.\n`; })(); return { file: `docs/d${pad(i + 1)}.md`, before, after: before.replace(/recieve/g, 'receive') }; });
void docText;
const wideTypo = {
  id: 'wide-fix-typo', split: 'wide', seed: Object.fromEntries(DOCS.map((d) => [d.file, d.before])),
  prompt: 'The misspelling "recieve" (also "recieved" and "recieves") appears in some files under docs/. Fix it to "receive" (and "received", "receives") everywhere. Do not touch files that do not contain it.',
  gate: all((c) => { for (const d of DOCS) if ((c.file(d.file) || '') !== d.after) return no(`${d.file} is wrong`); return ok(); }, onlyChanged(DOCS.filter((d) => d.before !== d.after).map((d) => d.file))),
  solve: [...DOCS.filter((d) => d.before !== d.after).map((d) => write(d.file, d.after)), say('Done.')],
};

// 4. wide-line-counts: count lines in 15 files.
const r4 = rng(404);
const LOGS = Array.from({ length: 15 }, (_, i) => { const n = Math.floor(r4() * 40) + 1; return { file: `logs/l${pad(i + 1)}.txt`, n, text: Array.from({ length: n }, (_, k) => `line ${k + 1} of file ${i + 1}`).join('\n') + '\n' }; });
const countsCsv = 'file,lines\n' + LOGS.map((l) => `${l.file.split('/')[1]},${l.n}`).join('\n');
const wideCounts = {
  id: 'wide-line-counts', split: 'wide', seed: Object.fromEntries(LOGS.map((l) => [l.file, l.text])),
  prompt: 'Count the lines in each file under logs/. Write counts.csv with the header "file,lines" and one row per file as "<filename>,<line count>", in filename order. Do not change the logs.',
  gate: all(fileEq('counts.csv', countsCsv), onlyChanged(['counts.csv'])),
  solve: [write('counts.csv', countsCsv + '\n'), say('Done.')],
};

// 5. wide-license-header: add a header line to 7 of 12 files; 5 already have it and must not change.
const HDR = '// SPDX-License-Identifier: MIT';
const hasHdr = Array.from({ length: 12 }, (_, i) => [1, 4, 5, 8, 10].includes(i));
const SRC = Array.from({ length: 12 }, (_, i) => { const body = `export const f${pad(i + 1)} = (x) => x + ${i + 1};\n`; return { file: `src/f${pad(i + 1)}.js`, before: (hasHdr[i] ? HDR + '\n' : '') + body, after: HDR + '\n' + body }; });
const wideHeader = {
  id: 'wide-license-header', split: 'wide', seed: Object.fromEntries(SRC.map((s) => [s.file, s.before])),
  prompt: 'Make every .js file under src/ start with the line "// SPDX-License-Identifier: MIT". Some files already have it; leave those exactly as they are.',
  gate: all((c) => { for (const s of SRC) if ((c.file(s.file) || '') !== s.after) return no(`${s.file} is wrong`); return ok(); }, onlyChanged(SRC.filter((s) => s.before !== s.after).map((s) => s.file))),
  solve: [...SRC.filter((s) => s.before !== s.after).map((s) => write(s.file, s.after)), say('Done.')],
};

// 6. wide-find-owners: aggregate over 16 small config files.
const r6 = rng(606);
const OWN = ['payments', 'search', 'identity', 'billing'];
const SVC = Array.from({ length: 16 }, (_, i) => ({ file: `svc/s${pad(i + 1)}.yaml`, owner: OWN[Math.floor(r6() * OWN.length)], tier: Math.floor(r6() * 3) + 1 }));
const tier1 = {}; for (const s of SVC) if (s.tier === 1) tier1[s.owner] = (tier1[s.owner] || 0) + 1;
const ownersTxt = Object.keys(tier1).sort().map((o) => `${o} ${tier1[o]}`).join('\n');
const wideOwners = {
  id: 'wide-find-owners', split: 'wide', seed: Object.fromEntries(SVC.map((s) => [s.file, `name: svc-${s.file.slice(5, 7)}\nowner: ${s.owner}\ntier: ${s.tier}\n`])),
  prompt: 'Each file in svc/ has an owner and a tier. Write owners.txt listing every owner that has at least one tier 1 service, one line per owner as "<owner> <number of tier 1 services>", sorted by owner name. Do not change the service files.',
  gate: all(fileEq('owners.txt', ownersTxt), onlyChanged(['owners.txt'])),
  solve: [write('owners.txt', ownersTxt + '\n'), say('Done.')],
};

export const WIDE_TASKS = [wideAddTotal, wideVersions, wideTypo, wideCounts, wideHeader, wideOwners].map((t) => ({ family: 'wide', ...t }));

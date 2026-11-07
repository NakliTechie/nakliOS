// BibTeX read and written as plain records, and the checks that need no network.
const REQUIRED = { article:['author', 'title', 'journal', 'year'], inproceedings:['author', 'title', 'booktitle', 'year'], book:['title', 'publisher', 'year'], misc:[] };
const KNOWN = new Set(['article', 'book', 'booklet', 'conference', 'inbook', 'incollection', 'inproceedings', 'manual', 'mastersthesis', 'misc', 'online', 'phdthesis', 'proceedings', 'techreport', 'unpublished']);

function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function parseFields(body) {
  const fields = {};
  let i = 0;
  while (i < body.length) {
    const name = /\s*,?\s*([A-Za-z][\w-]*)\s*=\s*/y;
    name.lastIndex = i;
    const match = name.exec(body);
    if (!match) break;
    i = name.lastIndex;
    let value = '';
    if (body[i] === '{') {
      const end = closing(body, i);
      if (end < 0) break;
      value = body.slice(i + 1, end);
      i = end + 1;
    } else if (body[i] === '"') {
      const end = body.indexOf('"', i + 1);
      if (end < 0) break;
      value = body.slice(i + 1, end);
      i = end + 1;
    } else {
      const bare = /[^,\s}]+/y;
      bare.lastIndex = i;
      value = bare.exec(body)?.[0] || '';
      i = bare.lastIndex || body.length;
    }
    fields[match[1].toLowerCase()] = value.replace(/\s+/g, ' ').trim();
  }
  return fields;
}

export function parseBib(text) {
  const entries = [], problems = [];
  for (const match of text.matchAll(/@([a-zA-Z]+)\s*\{/g)) {
    const type = match[1].toLowerCase();
    if (['comment', 'string', 'preamble'].includes(type)) continue;
    const open = match.index + match[0].length - 1, end = closing(text, open);
    if (end < 0) { problems.push({ message:`An entry near offset ${match.index} is not closed.` }); continue; }
    const body = text.slice(open + 1, end), comma = body.indexOf(',');
    entries.push({ type, key:(comma < 0 ? body : body.slice(0, comma)).trim(), fields:parseFields(comma < 0 ? '' : body.slice(comma + 1)), from:match.index, to:end + 1, raw:text.slice(match.index, end + 1) });
  }
  return { entries, problems };
}

export function writeEntry({ type, key, fields }) {
  return `@${type}{${key},\n${Object.entries(fields).filter(([, value]) => value).map(([name, value]) => `  ${name} = {${value}}`).join(',\n')}\n}\n`;
}

// Adds fields to one entry and leaves everything already written in it as it was.
export function addFields(text, entry, fields) {
  if (text.slice(entry.from, entry.to) !== entry.raw) throw new Error('This entry changed. Run the check again.');
  const body = entry.raw.slice(0, -1).trimEnd().replace(/,$/, '');
  const added = Object.entries(fields).map(([name, value]) => `,\n  ${name} = {${value}}`).join('');
  return `${text.slice(0, entry.from)}${body}${added}\n}${text.slice(entry.to)}`;
}

// A value from an outside record, made safe to put between braces: no markup, no commands, specials escaped.
export function cleanValue(value) {
  return String(value ?? '').replace(/<[^>]+>/g, '').replace(/[\\{}]/g, '').replace(/[~^]/g, ' ').replace(/[&%$#_]/g, '\\$&').replace(/\s+/g, ' ').trim();
}

export function scanEntries({ entries, problems }) {
  const found = [...problems], keys = new Map(), dois = new Map();
  for (const entry of entries) {
    const say = message => found.push({ key:entry.key, message });
    if (keys.has(entry.key.toLowerCase())) say('This key appears twice.');
    keys.set(entry.key.toLowerCase(), true);
    if (!KNOWN.has(entry.type)) say(`Unknown entry type ${entry.type}.`);
    if (entry.fields.crossref == null) for (const field of REQUIRED[entry.type] || []) if (!entry.fields[field]) say(`Missing ${field}.`);
    if (entry.type === 'article' && entry.fields.booktitle) say('An article has a booktitle. It may be @inproceedings.');
    if (entry.type === 'inproceedings' && entry.fields.journal) say('A proceedings entry has a journal. It may be @article.');
    if (entry.fields.year && !/^\d{4}$/.test(entry.fields.year)) say(`The year "${entry.fields.year}" is not four digits.`);
    const doi = entry.fields.doi?.toLowerCase();
    if (doi && dois.has(doi)) say(`Same DOI as ${dois.get(doi)}.`);
    if (doi) dois.set(doi, entry.key);
  }
  return found;
}

export const plainTitle = title => (title || '').replace(/[{}\\]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const familyNames = authors => (authors || '').split(/\s+and\s+/i).map(name => (name.includes(',') ? name.split(',')[0] : name.trim().split(/\s+/).pop() || '').replace(/[{}\\]/g, '').toLowerCase()).filter(Boolean);

// A replacement must be the same paper: the same title and the same authors in the same order.
export function sameWork(a, b) {
  if (plainTitle(a.title) !== plainTitle(b.title)) return false;
  const left = familyNames(a.author), right = familyNames(b.author);
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export function citeKey(fields) {
  const family = familyNames(fields.author)[0]?.replace(/[^a-z]/g, '') || 'paper';
  const word = plainTitle(fields.title).split(' ').find(item => item.length > 3) || 'work';
  return `${family}${fields.year || ''}${word}`;
}

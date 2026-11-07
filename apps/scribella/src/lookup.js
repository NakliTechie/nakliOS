// Paper metadata from Crossref and OpenAlex, which both answer browsers directly. A failed lookup is "unavailable" and
// never counts as a check that passed.
import { citeKey, cleanValue, plainTitle, sameWork } from './bib.js';

const TIMEOUT_MS = 8000;
const CROSSREF = 'https://api.crossref.org/works';
const OPENALEX = 'https://api.openalex.org/works';

async function getJson(url, load) {
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
  try {
    const reply = await load(url, { signal:stop.signal });
    if (reply.status === 404) return null;
    if (!reply.ok) throw new Error(`Lookup failed with ${reply.status}`);
    return await reply.json();
  } finally { clearTimeout(timer); }
}

const TYPES = { 'journal-article':'article', 'proceedings-article':'inproceedings', 'book-chapter':'incollection', book:'book', 'posted-content':'misc' };

export function fromCrossref(work) {
  const year = work.issued?.['date-parts']?.[0]?.[0] ?? work.published?.['date-parts']?.[0]?.[0];
  const venue = work['container-title']?.[0];
  const type = TYPES[work.type] || 'misc';
  const fields = {
    title:cleanValue(work.title?.[0]),
    author:(work.author || []).map(person => cleanValue([person.family, person.given].filter(Boolean).join(', '))).join(' and '),
    [type === 'inproceedings' || type === 'incollection' ? 'booktitle' : 'journal']:cleanValue(venue),
    year:year ? String(year) : '', volume:cleanValue(work.volume), number:cleanValue(work.issue), pages:cleanValue(work.page), publisher:cleanValue(work.publisher), doi:cleanValue(work.DOI),
  };
  if (type === 'book' || type === 'misc') delete fields.journal;
  return { type, key:citeKey(fields), fields };
}

export function fromOpenAlex(work) {
  const fields = {
    title:cleanValue(work.title),
    author:(work.authorships || []).map(item => {
      const parts = cleanValue(item.author?.display_name).split(/\s+/);
      return `${parts.pop()}, ${parts.join(' ')}`.replace(/, $/, '');
    }).join(' and '),
    year:work.publication_year ? String(work.publication_year) : '',
    doi:cleanValue(work.doi?.replace(/^https:\/\/doi\.org\//, '')),
  };
  const source = work.primary_location?.source, biblio = work.biblio || {};
  const type = source?.type === 'journal' ? 'article' : source?.type === 'conference' ? 'inproceedings' : 'misc';
  if (type === 'article') fields.journal = cleanValue(source.display_name);
  if (type === 'inproceedings') fields.booktitle = cleanValue(source.display_name);
  if (type !== 'misc') {
    fields.volume = cleanValue(biblio.volume);
    fields.number = cleanValue(biblio.issue);
    fields.pages = biblio.first_page ? cleanValue([biblio.first_page, biblio.last_page].filter(Boolean).join('--')) : '';
  }
  return { type, key:citeKey(fields), fields };
}

const NOTICES = { retraction:'retracted', withdrawal:'retracted', removal:'retracted', 'expression_of_concern':'expression of concern', correction:'corrected', erratum:'corrected', corrigendum:'corrected' };

export function noticesOf(work) {
  return [...new Set((work['updated-by'] || []).map(item => NOTICES[String(item.type).toLowerCase().replace(/[- ]/g, '_')]).filter(Boolean))];
}

export const byDoi = async (doi, load = fetch) => (await getJson(`${CROSSREF}/${encodeURIComponent(doi)}`, load))?.message ?? null;

export async function byTitle(title, load = fetch) {
  const items = (await getJson(`${CROSSREF}?rows=5&query.bibliographic=${encodeURIComponent(title)}`, load))?.message?.items || [];
  return items.find(item => plainTitle(item.title?.[0]) === plainTitle(title)) ?? null;
}

export async function byArxiv(id, load = fetch) {
  return getJson(`${OPENALEX}/doi:10.48550/arXiv.${encodeURIComponent(id)}`, load);
}

// Papers on a topic, best match first.
export async function discover(query, load = fetch) {
  const reply = await getJson(`${OPENALEX}?per-page=10&search=${encodeURIComponent(query)}`, load);
  return (reply?.results || []).map(work => ({ ...fromOpenAlex(work), cited:work.cited_by_count ?? 0 }));
}

// Reads an arXiv id, DOI or title, and answers one BibTeX record, or null.
export async function findPaper(input, load = fetch) {
  const text = input.trim();
  const arxiv = /(?:arxiv[:./]|abs\/|pdf\/)?(\d{4}\.\d{4,5})(?:v\d+)?/i.exec(text);
  const doi = /10\.\d{4,9}\/\S+/.exec(text);
  if (doi) { const work = await byDoi(doi[0].replace(/[.,;]$/, ''), load); return work && fromCrossref(work); }
  if (arxiv) { const work = await byArxiv(arxiv[1], load); return work && { ...fromOpenAlex(work), fields:{ ...fromOpenAlex(work).fields, eprint:arxiv[1], archiveprefix:'arXiv' } }; }
  const work = await byTitle(text, load);
  return work && fromCrossref(work);
}

// One entry: `checked` matched, `update` has a safe replacement, `unavailable` the service failed, `skipped` nothing to
// look up, `unmatched` nothing found. Only `checked` and `update` mean the paper was seen.
export async function auditEntry(entry, load = fetch) {
  const { fields } = entry;
  if (fields.pubstate === 'preprint' || (!fields.doi && !fields.title)) return { key:entry.key, status:'skipped' };
  try {
    // arXiv DOIs are not in Crossref, so preprints are read from OpenAlex.
    const arxiv = fields.eprint || /^10\.48550\/arxiv\.(.+)$/i.exec(fields.doi || '')?.[1];
    if (arxiv) {
      const preprint = await byArxiv(arxiv, load);
      if (!preprint) return { key:entry.key, status:'unmatched', message:'No record found. This does not prove the entry wrong.' };
      return sameWork(fields, fromOpenAlex(preprint).fields)
        ? { key:entry.key, status:'checked', notices:[] }
        : { key:entry.key, status:'conflict', notices:[], message:`The record found differs: "${preprint.title}".` };
    }
    const work = fields.doi ? await byDoi(fields.doi, load) : await byTitle(fields.title, load);
    if (!work) return { key:entry.key, status:'unmatched', message:'No record found. This does not prove the entry wrong.' };
    const found = fromCrossref(work), notices = noticesOf(work);
    const same = sameWork(fields, found.fields);
    if (!same) return { key:entry.key, status:'conflict', notices, message:`The record found differs: "${found.fields.title}".` };
    const missing = ['doi', 'pages', 'volume', 'year'].filter(name => found.fields[name] && !fields[name]);
    return missing.length
      ? { key:entry.key, status:'update', notices, message:`The record adds ${missing.join(', ')}.`, additions:Object.fromEntries(missing.map(name => [name, found.fields[name]])) }
      : { key:entry.key, status:'checked', notices };
  } catch (error) {
    return { key:entry.key, status:'unavailable', message:error.message };
  }
}

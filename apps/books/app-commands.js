// Read commands other NakliOS apps call through the host's app Grants (nakliOS docs/app-contract.md,
// "Grants on the rail"). The host lists them as `books.<name>`. Every command reads; none writes the library.
// commands.json at the repo root declares the same set so the host lists them while Lorewell is closed;
// scripts/test-app-commands.mjs checks that the two match.
import { searchLexicalIndex } from './semantic-processing.js';

// The host refuses a result over 262,144 bytes (ETOOBIG). Stay below it with room for the envelope.
export const RESULT_BUDGET_BYTES = 240000;
export const EXCERPT_CHARS = 280;
export const PASSAGE_DEFAULT_CHARS = 4000;
export const PASSAGE_MAX_CHARS = 12000;

export const COMMAND_DEFINITIONS = [
  {
    name:'library.list',
    description:'List the works in the nBooks library with work id, title, authors and formats, sorted by title, paged.',
    scope:'read',
    input:{
      type:'object',
      properties:{
        offset:{ type:'integer', minimum:0, description:'Works to skip; default 0' },
        limit:{ type:'integer', minimum:1, maximum:200, description:'Works to return; default 50' },
        query:{ type:'string', description:'Optional filter on title or author' },
      },
    },
  },
  {
    name:'library.search',
    description:'Search the passages of every indexed book by keyword, plus meaning when the on-device encoder is loaded. Returns passage hits with work id, passage id, location and a short excerpt.',
    scope:'read',
    input:{
      type:'object',
      properties:{
        query:{ type:'string', minLength:2, description:'Words or a question to search for' },
        limit:{ type:'integer', minimum:1, maximum:50, description:'Hits to return; default 10' },
        workId:{ type:'string', description:'Optional: search one work only' },
      },
      required:['query'],
    },
  },
  {
    name:'passage.get',
    description:'Return the text of one passage, with neighbouring passages if asked, bounded in length, plus the citation fields: title, authors, chapter or page.',
    scope:'read',
    input:{
      type:'object',
      properties:{
        workId:{ type:'string', description:'Work id from library.list or library.search' },
        passageId:{ type:'string', description:'Passage id from library.search' },
        context:{ type:'integer', minimum:0, maximum:3, description:'Passages to add on each side; default 0' },
        maxChars:{ type:'integer', minimum:200, maximum:PASSAGE_MAX_CHARS, description:'Text length cap; default 4000' },
      },
      required:['workId', 'passageId'],
    },
  },
  {
    name:'reader.open',
    description:'Open one passage in the nBooks reader and bring nBooks to the front, so the person can read it in place.',
    scope:'read',
    // The host brings Lorewell's window forward when this call succeeds (nakliOS commands.json field `shows`).
    shows:true,
    input:{
      type:'object',
      properties:{
        workId:{ type:'string', description:'Work id from library.list or library.search' },
        passageId:{ type:'string', description:'Passage id from library.search' },
      },
      required:['workId', 'passageId'],
    },
  },
  {
    name:'annotation.list',
    description:'List the highlights, notes and bookmarks the person made in one work, or in every work, with the quoted text and location.',
    scope:'read',
    input:{
      type:'object',
      properties:{
        workId:{ type:'string', description:'Optional: one work only' },
        limit:{ type:'integer', minimum:1, maximum:200, description:'Annotations to return; default 50' },
      },
    },
  },
];

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new Error('The caller stopped waiting.');
}

function clampInt(value, { min, max, fallback }) {
  const number = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
  return Math.min(max, Math.max(min, number));
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// Drops items from the end of `result[key]` until the whole result fits the budget.
export function fitToBudget(result, key, budget = RESULT_BUDGET_BYTES) {
  const items = result[key];
  if (byteLength(result) <= budget) return result;
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength({ ...result, [key]:items.slice(0, mid) }) <= budget) low = mid;
    else high = mid - 1;
  }
  return { ...result, [key]:items.slice(0, low), truncated:true };
}

export function passageExcerpt(text, query = '', chars = EXCERPT_CHARS) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const lower = flat.toLocaleLowerCase();
  const found = String(query).toLocaleLowerCase().split(/\s+/).filter(Boolean)
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, found - Math.round(chars / 4));
  const end = Math.min(flat.length, start + chars);
  return (start ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

// The location a citation shows and a reader can jump to. `fraction` is the passage's position in the work.
export function passageLocation(passage, passageCount) {
  const engine = passage?.anchor?.engine || {};
  const location = {
    passageId:passage.passageId,
    order:passage.order,
    sectionIndex:passage.structure?.sectionIndex ?? null,
    chapter:passage.structure?.label || null,
    fraction:Number((passage.order / Math.max(1, passageCount)).toFixed(4)),
  };
  if (engine.kind === 'pdf-page' && Number.isFinite(engine.page)) location.page = engine.page;
  if (engine.cfi) location.cfi = engine.cfi;
  return location;
}

function workSummary(work) {
  return {
    workId:work.workId,
    title:work.title,
    authors:work.authors || [],
    formats:work.formats || [],
  };
}

// deps:
//   listWorks(): Promise<[{ workId, title, authors: string[], formats: string[] }]>
//   readPassages(workId): Promise<{ passages: [...] } | null>
//   readLexicalIndex(workId): Promise<index | null>
//   readAnnotations(workId): Promise<{ annotations: [...] } | null>
//   openPassage({ work, passage, passageCount, signal }) (optional): opens the reader at the passage; resolves when shown.
//   semanticSearch(query, { works, limit, signal }) (optional):
//     Promise<[{ workId, passageId, score, label?, kind? }]>; returns [] when the encoder is not loaded.
export function createLibraryCommands(deps) {
  async function worksById() {
    const works = await deps.listWorks();
    return new Map(works.map((work) => [work.workId, work]));
  }

  async function list(args = {}, { signal } = {}) {
    const offset = clampInt(args.offset, { min:0, max:1e9, fallback:0 });
    const limit = clampInt(args.limit, { min:1, max:200, fallback:50 });
    const needle = String(args.query || '').trim().toLocaleLowerCase();
    const works = (await deps.listWorks())
      .filter((work) => !needle || [work.title, ...(work.authors || [])]
        .join(' ').toLocaleLowerCase().includes(needle))
      .sort((left, right) => String(left.title).localeCompare(String(right.title)));
    abortIfNeeded(signal);
    return fitToBudget({
      total:works.length,
      offset,
      works:works.slice(offset, offset + limit).map(workSummary),
    }, 'works');
  }

  async function search(args = {}, { signal } = {}) {
    const query = String(args.query || '').trim();
    if (query.length < 2) throw new Error('library.search needs a query of at least 2 characters.');
    const limit = clampInt(args.limit, { min:1, max:50, fallback:10 });
    const byId = await worksById();
    const works = args.workId
      ? [byId.get(String(args.workId))].filter(Boolean)
      : Array.from(byId.values());
    if (args.workId && !works.length) throw new Error('No work with id ' + args.workId + '.');
    const passageRecords = new Map();
    const matches = [];
    let indexedWorks = 0;
    for (const work of works) {
      abortIfNeeded(signal);
      const [index, record] = await Promise.all([
        deps.readLexicalIndex(work.workId),
        deps.readPassages(work.workId),
      ]);
      if (!index || !record?.passages) continue;
      indexedWorks += 1;
      passageRecords.set(work.workId, record);
      for (const result of searchLexicalIndex(index, query).slice(0, Math.max(4, limit))) {
        const passage = record.passages[result.passageIndex];
        if (passage) matches.push({ work, passage, score:result.score, match:'keyword' });
      }
    }
    abortIfNeeded(signal);
    let semantic = false;
    if (deps.semanticSearch) {
      const hits = await deps.semanticSearch(query, { works, limit:limit * 2, signal });
      semantic = Array.isArray(hits) && hits.length > 0;
      for (const hit of hits || []) {
        const work = byId.get(hit.workId);
        let record = passageRecords.get(hit.workId);
        if (!record && work) {
          record = await deps.readPassages(hit.workId);
          if (record?.passages) passageRecords.set(hit.workId, record);
        }
        const passage = record?.passages?.find((candidate) => candidate.passageId === hit.passageId);
        if (work && passage) {
          matches.push({ work, passage, score:hit.score, match:'meaning', idea:hit.label || null });
        }
      }
    }
    abortIfNeeded(signal);
    matches.sort((left, right) => right.score - left.score);
    const seen = new Set();
    const hits = [];
    for (const match of matches) {
      const key = match.work.workId + ':' + match.passage.passageId;
      if (seen.has(key)) continue;
      seen.add(key);
      const passageCount = passageRecords.get(match.work.workId).passages.length;
      hits.push({
        workId:match.work.workId,
        title:match.work.title,
        authors:match.work.authors || [],
        location:passageLocation(match.passage, passageCount),
        excerpt:passageExcerpt(match.passage.text, query),
        score:Number(Number(match.score).toFixed(4)),
        match:match.match,
        ...(match.idea ? { idea:match.idea } : {}),
      });
      if (hits.length >= limit) break;
    }
    return fitToBudget({
      query,
      searchedWorks:works.length,
      indexedWorks,
      semantic,
      hits,
    }, 'hits');
  }

  async function passage(args = {}, { signal } = {}) {
    const workId = String(args.workId || '');
    const passageId = String(args.passageId || '');
    if (!workId || !passageId) throw new Error('passage.get needs workId and passageId.');
    const context = clampInt(args.context, { min:0, max:3, fallback:0 });
    const maxChars = clampInt(args.maxChars, {
      min:200, max:PASSAGE_MAX_CHARS, fallback:PASSAGE_DEFAULT_CHARS,
    });
    const work = (await worksById()).get(workId);
    if (!work) throw new Error('No work with id ' + workId + '.');
    const record = await deps.readPassages(workId);
    abortIfNeeded(signal);
    const passages = record?.passages || [];
    const index = passages.findIndex((candidate) => candidate.passageId === passageId);
    if (index < 0) throw new Error('No passage ' + passageId + ' in ' + work.title + '.');
    const before = passages.slice(Math.max(0, index - context), index);
    const after = passages.slice(index + 1, index + 1 + context);
    const target = passages[index];
    // The target passage comes first in the budget; neighbours fill what is left, nearest first.
    let text = String(target.text || '').slice(0, maxChars);
    let remaining = maxChars - text.length;
    const take = (row, side) => {
      if (remaining <= 0) return null;
      const raw = String(row.text || '');
      const piece = side === 'before' ? raw.slice(Math.max(0, raw.length - remaining)) : raw.slice(0, remaining);
      remaining -= piece.length;
      return { passageId:row.passageId, text:piece, truncated:piece.length < raw.length };
    };
    const contextBefore = [];
    const contextAfter = [];
    for (let step = 0; step < context; step++) {
      const prior = before[before.length - 1 - step];
      const next = after[step];
      if (prior) { const row = take(prior, 'before'); if (row) contextBefore.unshift(row); }
      if (next) { const row = take(next, 'after'); if (row) contextAfter.push(row); }
    }
    return {
      workId,
      title:work.title,
      authors:work.authors || [],
      formats:work.formats || [],
      location:passageLocation(target, passages.length),
      text,
      truncated:text.length < String(target.text || '').length,
      before:contextBefore,
      after:contextAfter,
      citation:{
        title:work.title,
        authors:work.authors || [],
        chapter:target.structure?.label || null,
        page:target.anchor?.engine?.kind === 'pdf-page' ? target.anchor.engine.page ?? null : null,
      },
    };
  }

  async function annotations(args = {}, { signal } = {}) {
    const limit = clampInt(args.limit, { min:1, max:200, fallback:50 });
    const byId = await worksById();
    const works = args.workId
      ? [byId.get(String(args.workId))].filter(Boolean)
      : Array.from(byId.values());
    if (args.workId && !works.length) throw new Error('No work with id ' + args.workId + '.');
    const rows = [];
    for (const work of works) {
      abortIfNeeded(signal);
      const record = await deps.readAnnotations(work.workId);
      for (const annotation of record?.annotations || []) {
        if (annotation.deletedAt) continue;
        rows.push({
          workId:work.workId,
          title:work.title,
          annotationId:annotation.annotationId,
          kind:annotation.kind,
          color:annotation.color || null,
          label:annotation.label || '',
          body:annotation.body || '',
          quote:annotation.target?.exact || null,
          passageId:annotation.target?.passageId || null,
          createdAt:annotation.createdAt || null,
          updatedAt:annotation.updatedAt || null,
        });
      }
    }
    rows.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    return fitToBudget({ total:rows.length, annotations:rows.slice(0, limit) }, 'annotations');
  }

  async function readerOpen(args = {}, { signal } = {}) {
    if (!deps.openPassage) throw new Error('The reader is unavailable here.');
    const workId = String(args.workId || '');
    const passageId = String(args.passageId || '');
    if (!workId || !passageId) throw new Error('reader.open needs workId and passageId.');
    const work = (await worksById()).get(workId);
    if (!work) throw new Error('No work with id ' + workId + '.');
    const passages = (await deps.readPassages(workId))?.passages || [];
    const target = passages.find((candidate) => candidate.passageId === passageId);
    if (!target) throw new Error('No passage ' + passageId + ' in ' + work.title + '.');
    abortIfNeeded(signal);
    await deps.openPassage({ work, passage:target, passageCount:passages.length, signal });
    return {
      opened:true,
      workId,
      title:work.title,
      location:passageLocation(target, passages.length),
    };
  }

  const handlers = {
    'library.list':list,
    'library.search':search,
    'passage.get':passage,
    'annotation.list':annotations,
    'reader.open':readerOpen,
  };
  return COMMAND_DEFINITIONS.map((definition) => ({
    ...definition,
    handler:handlers[definition.name],
  }));
}

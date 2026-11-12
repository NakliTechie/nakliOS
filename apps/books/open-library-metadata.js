export const OPEN_LIBRARY_PROVIDER = 'open-library';
export const OPEN_LIBRARY_SEARCH_ENDPOINT =
  'https://openlibrary.org/search.json';
export const OPEN_LIBRARY_RESULT_LIMIT = 5;
export const OPEN_LIBRARY_MIN_INTERVAL_MS = 1_000;

const openLibrarySessionCache = new Map();
let nextOpenLibraryRequestAt = 0;

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

async function waitForRequestSlot({
  signal,
  minIntervalMs,
  nowMs,
}) {
  const delay = Math.max(0, nextOpenLibraryRequestAt - nowMs());
  if (!delay || minIntervalMs <= 0) return;
  await new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      const error = new Error('Open Library metadata lookup was stopped.');
      error.name = 'AbortError';
      reject(error);
    };
    signal.addEventListener('abort', abort, { once:true });
    timer = setTimeout(ready, delay);
  });
}

function uniqueStrings(values = [], limit = 20) {
  return Array.from(new Set(
    values
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )).slice(0, limit);
}

function validIsbn10(value) {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  const sum = Array.from(value).reduce((total, character, index) =>
    total + (character === 'X' ? 10 : Number(character)) * (10 - index), 0);
  return sum % 11 === 0;
}

function validIsbn13(value) {
  if (!/^\d{13}$/.test(value)) return false;
  const sum = Array.from(value.slice(0, 12)).reduce((total, character, index) =>
    total + Number(character) * (index % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(value[12]);
}

export function normalizeIsbn(value) {
  const normalized = String(value || '')
    .toUpperCase()
    .replace(/[^\dX]/g, '');
  if (normalized.length === 10 && validIsbn10(normalized)) return normalized;
  if (normalized.length === 13 && validIsbn13(normalized)) return normalized;
  return null;
}

export function findIsbn(...values) {
  for (const raw of values.flat(Infinity)) {
    const text = String(raw || '');
    const patterns = [
      /(?<!\d)97[89](?:[\s-]*\d){10}(?!\d)/gi,
      /(?<!\d)\d(?:[\s-]*\d){8}[\s-]*[\dX](?![\dX])/gi,
    ];
    for (const pattern of patterns) {
      for (const candidate of text.match(pattern) || []) {
        const isbn = normalizeIsbn(candidate);
        if (isbn) return isbn;
      }
    }
  }
  return null;
}

export function manifestIsbn(manifest) {
  const identifiers = manifest?.editions?.[0]?.identifiers || {};
  return findIsbn(
    identifiers['isbn-13'],
    identifiers.isbn13,
    identifiers['isbn-10'],
    identifiers.isbn10,
    manifest?.assets?.map((asset) => asset.sourceFilename),
  );
}

export function openLibrarySearchUrl({
  isbn = null,
  title = '',
  authors = [],
} = {}) {
  const normalizedIsbn = normalizeIsbn(isbn);
  const url = new URL(OPEN_LIBRARY_SEARCH_ENDPOINT);
  if (normalizedIsbn) {
    url.searchParams.set('isbn', normalizedIsbn);
  } else {
    const normalizedTitle = String(title || '').trim();
    const normalizedAuthor = uniqueStrings(authors, 3).join(' ');
    if (!normalizedTitle) {
      throw new Error('Enter an ISBN or title before looking up metadata.');
    }
    url.searchParams.set('title', normalizedTitle);
    if (normalizedAuthor) url.searchParams.set('author', normalizedAuthor);
  }
  url.searchParams.set(
    'fields',
    [
      'key',
      'title',
      'author_name',
      'first_publish_year',
      'publisher',
      'language',
      'isbn',
      'cover_i',
    ].join(','),
  );
  url.searchParams.set('limit', String(OPEN_LIBRARY_RESULT_LIMIT));
  return url.toString();
}

function normalizeCandidate(document, requestedIsbn, fetchedAt) {
  const key = /^\/works\/OL\d+W$/.test(String(document?.key || ''))
    ? String(document.key) : null;
  const title = String(document?.title || '').trim().slice(0, 500);
  if (!key || !title) return null;
  const isbns = uniqueStrings(document.isbn || [], 24)
    .map(normalizeIsbn)
    .filter(Boolean);
  const exactIsbn = requestedIsbn && isbns.includes(requestedIsbn)
    ? requestedIsbn : null;
  const coverId = Number.isSafeInteger(Number(document.cover_i))
    && Number(document.cover_i) > 0 ? Number(document.cover_i) : null;
  return {
    provider:OPEN_LIBRARY_PROVIDER,
    providerRecordId:key.slice('/works/'.length),
    matchedBy:exactIsbn
      ? {
          type:exactIsbn.length === 13 ? 'isbn-13' : 'isbn-10',
          value:exactIsbn,
        }
      : { type:'title-author', value:title },
    fetchedAt,
    sourceUrl:'https://openlibrary.org' + key,
    title,
    authors:uniqueStrings(document.author_name || [], 12),
    firstPublishYear:Number.isSafeInteger(Number(document.first_publish_year))
      ? Number(document.first_publish_year) : null,
    publishers:uniqueStrings(document.publisher || [], 12),
    languages:uniqueStrings(document.language || [], 12),
    isbns,
    cover:coverId ? {
      coverId,
      url:'https://covers.openlibrary.org/b/id/' + coverId +
        '-M.jpg?default=false',
      sourceUrl:'https://openlibrary.org' + key,
      size:'M',
    } : null,
  };
}

export async function lookupOpenLibraryMetadata({
  isbn = null,
  title = '',
  authors = [],
  fetchImpl = globalThis.fetch,
  signal = null,
  timeoutMs = 12_000,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  minIntervalMs = OPEN_LIBRARY_MIN_INTERVAL_MS,
  cache = openLibrarySessionCache,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Metadata lookup is unavailable in this browser.');
  }
  const normalizedIsbn = normalizeIsbn(isbn);
  const url = openLibrarySearchUrl({
    isbn:normalizedIsbn,
    title,
    authors,
  });
  if (cache?.has(url)) return cloneJson(cache.get(url));
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener?.('abort', abort, { once:true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await waitForRequestSlot({
      signal:controller.signal,
      minIntervalMs,
      nowMs,
    });
    nextOpenLibraryRequestAt = nowMs() + Math.max(0, minIntervalMs);
    const response = await fetchImpl(url, {
      method:'GET',
      headers:{ Accept:'application/json' },
      signal:controller.signal,
      credentials:'omit',
      referrerPolicy:'no-referrer',
    });
    if (!response.ok) {
      throw new Error(
        'Open Library metadata lookup returned HTTP ' + response.status + '.',
      );
    }
    const payload = await response.json();
    const fetchedAt = now();
    const result = {
      provider:OPEN_LIBRARY_PROVIDER,
      query:{
        isbn:normalizedIsbn,
        title:normalizedIsbn ? null : String(title || '').trim(),
        authors:normalizedIsbn ? [] : uniqueStrings(authors, 3),
      },
      candidates:(Array.isArray(payload?.docs) ? payload.docs : [])
        .map((document) =>
          normalizeCandidate(document, normalizedIsbn, fetchedAt))
        .filter(Boolean)
        .slice(0, OPEN_LIBRARY_RESULT_LIMIT),
      fetchedAt,
    };
    if (cache) {
      cache.set(url, cloneJson(result));
      while (cache.size > 50) {
        cache.delete(cache.keys().next().value);
      }
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        signal?.aborted
          ? 'Open Library metadata lookup was stopped.'
          : 'Open Library metadata lookup timed out.',
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
  }
}

export function applyOpenLibrarySuggestion(
  manifest,
  candidate,
  now = () => new Date().toISOString(),
) {
  if (
    !manifest
    || candidate?.provider !== OPEN_LIBRARY_PROVIDER
    || !candidate.providerRecordId
  ) {
    return { manifest, changed:false };
  }
  const next = cloneJson(manifest);
  const fetchedAt = candidate.fetchedAt || now();
  const source = {
    provider:OPEN_LIBRARY_PROVIDER,
    providerRecordId:String(candidate.providerRecordId),
    matchedBy:cloneJson(candidate.matchedBy),
    fetchedAt,
    sourceUrl:String(candidate.sourceUrl || ''),
    fieldProvenance:{
      title:OPEN_LIBRARY_PROVIDER,
      authors:OPEN_LIBRARY_PROVIDER,
      publication:OPEN_LIBRARY_PROVIDER,
      identifiers:OPEN_LIBRARY_PROVIDER,
      cover:candidate.cover ? OPEN_LIBRARY_PROVIDER : null,
    },
    suggestion:{
      title:String(candidate.title || '').slice(0, 500),
      authors:uniqueStrings(candidate.authors || [], 12),
      firstPublishYear:Number(candidate.firstPublishYear) || null,
      publishers:uniqueStrings(candidate.publishers || [], 12),
      languages:uniqueStrings(candidate.languages || [], 12),
      isbns:uniqueStrings(candidate.isbns || [], 24),
      cover:cloneJson(candidate.cover),
    },
  };
  const sources = (next.metadataSources || []).filter((record) =>
    !(
      record.provider === source.provider
      && record.providerRecordId === source.providerRecordId
    ));
  sources.push(source);
  next.metadataSources = sources.slice(-12);

  const titleProvenance = next.metadataProvenance?.title;
  if (
    source.suggestion.title
    && (!next.title || titleProvenance === 'filename')
  ) {
    next.title = source.suggestion.title;
    next.metadataProvenance = {
      ...(next.metadataProvenance || {}),
      title:OPEN_LIBRARY_PROVIDER,
    };
  }
  if (
    source.suggestion.authors.length
    && !(next.authors || []).length
  ) {
    next.authors = source.suggestion.authors.map((name) => ({
      name,
      source:OPEN_LIBRARY_PROVIDER,
    }));
    next.metadataProvenance = {
      ...(next.metadataProvenance || {}),
      authors:OPEN_LIBRARY_PROVIDER,
    };
  }

  const edition = next.editions?.[0];
  if (edition) {
    edition.identifiers = { ...(edition.identifiers || {}) };
    for (const isbn of source.suggestion.isbns) {
      const key = isbn.length === 13 ? 'isbn-13' : 'isbn-10';
      edition.identifiers[key] = uniqueStrings([
        ...(edition.identifiers[key] || []),
        isbn,
      ]);
    }
    if (!edition.publisher && source.suggestion.publishers[0]) {
      edition.publisher = source.suggestion.publishers[0];
    }
    if (!edition.publicationYear && source.suggestion.firstPublishYear) {
      edition.publicationYear = source.suggestion.firstPublishYear;
    }
    if (!edition.language && source.suggestion.languages[0]) {
      edition.language = source.suggestion.languages[0];
    }
    edition.metadataProvenance = {
      ...(edition.metadataProvenance || {}),
      identifiers:OPEN_LIBRARY_PROVIDER,
      publisher:edition.publisher ? OPEN_LIBRARY_PROVIDER : null,
      publicationYear:edition.publicationYear ? OPEN_LIBRARY_PROVIDER : null,
      language:edition.language ? OPEN_LIBRARY_PROVIDER : null,
    };
    edition.updatedAt = fetchedAt;
  }
  next.updatedAt = fetchedAt;
  return { manifest:next, changed:true };
}

export function selectOpenLibraryCover(
  manifest,
  candidate,
  { path, mimeType, byteLength } = {},
  now = () => new Date().toISOString(),
) {
  if (
    !manifest
    || candidate?.provider !== OPEN_LIBRARY_PROVIDER
    || !candidate.cover?.coverId
    || !path
  ) return { manifest, changed:false };
  const next = cloneJson(manifest);
  next.selectedCover = {
    provider:OPEN_LIBRARY_PROVIDER,
    providerRecordId:String(candidate.providerRecordId),
    coverId:Number(candidate.cover.coverId),
    path:String(path),
    mimeType:String(mimeType || 'image/jpeg'),
    byteLength:Math.max(0, Number(byteLength) || 0),
    fetchedAt:now(),
    sourceUrl:String(candidate.cover.sourceUrl || candidate.sourceUrl || ''),
    size:String(candidate.cover.size || 'M'),
  };
  next.updatedAt = next.selectedCover.fetchedAt;
  return { manifest:next, changed:true };
}

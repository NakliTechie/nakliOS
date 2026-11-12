export const SEMANTIC_SCHEMA_VERSION = 1;
export const SEMANTIC_CATALOG_PATH = 'catalog/catalog.json';
export const SEMANTIC_VIEWS_PATH = 'catalog/views.json';
export const SEMANTIC_WORKS_PREFIX = 'catalog/works/';
export const SEMANTIC_ANNOTATIONS_PREFIX = 'annotations/';
export const PORTABLE_BUNDLE_VERSION = 1;

const RECORD_TYPE = 'books.work';
const CATALOG_TYPE = 'books.catalog';
const ANNOTATIONS_TYPE = 'books.annotations';
const LIBRARY_VIEWS_TYPE = 'books.library-views';
const PORTABLE_BUNDLE_TYPE = 'books.portable-library';
const LIBRARY_VIEW_SORTS = new Set(['recent', 'title', 'author']);
const LIBRARY_VIEW_READING_STATES = new Set([
  'all',
  'continue',
  'unread',
  'rated',
  'annotated',
]);

function isoNow(now) {
  return typeof now === 'function' ? now() : new Date().toISOString();
}

function uuidFallback() {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 14);
  return time + '-' + random;
}

export function createRecordId(kind, randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  const value = randomUUID ? randomUUID() : uuidFallback();
  return String(kind) + '_' + String(value).toLowerCase();
}

export function legacyBookIdFor(filename) {
  return String(filename)
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^a-zA-Z0-9-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'book';
}

function extensionOf(filename) {
  const match = String(filename || '').match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

function titleFromFilename(filename) {
  return String(filename || '').replace(/\.[a-z0-9]+$/i, '');
}

function authorRecords(author, source = 'legacy-sidecar') {
  const names = Array.isArray(author) ? author : [author];
  return names
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean)
    .map((name) => ({ name, source }));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function manifestPath(workId) {
  return SEMANTIC_WORKS_PREFIX + workId + '.json';
}

function normalizeViewStringList(value) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => typeof item === 'string' ? item.trim() : '')
      .filter(Boolean)
      .slice(0, 50),
  )).sort((left, right) => left.localeCompare(right));
}

function normalizeLibraryView(view) {
  if (
    !view
    || typeof view.viewId !== 'string'
    || !/^view_[a-zA-Z0-9_-]{1,240}$/.test(view.viewId)
    || typeof view.name !== 'string'
    || !view.name.trim()
    || view.name.trim().length > 120
  ) return null;
  const readingState = LIBRARY_VIEW_READING_STATES.has(
    view.filters?.readingState,
  ) ? view.filters.readingState : 'all';
  const sort = LIBRARY_VIEW_SORTS.has(view.sort) ? view.sort : 'recent';
  return {
    viewId:view.viewId,
    name:view.name.trim(),
    query:typeof view.query === 'string' ? view.query.trim().slice(0, 500) : '',
    filters:{
      readingState,
      shelves:normalizeViewStringList(view.filters?.shelves),
      tags:normalizeViewStringList(view.filters?.tags),
    },
    sort,
    createdAt:typeof view.createdAt === 'string' ? view.createdAt : null,
    updatedAt:typeof view.updatedAt === 'string' ? view.updatedAt : null,
  };
}

export function makeLibraryViewsRecord(
  { views = [], revision = 1 } = {},
  now = () => new Date().toISOString(),
) {
  const timestamp = isoNow(now);
  return {
    schemaVersion:SEMANTIC_SCHEMA_VERSION,
    recordType:LIBRARY_VIEWS_TYPE,
    revision:Math.max(1, Number(revision) || 1),
    views:views.map(normalizeLibraryView).filter(Boolean)
      .sort((left, right) =>
        left.name.localeCompare(right.name) || left.viewId.localeCompare(right.viewId)),
    updatedAt:timestamp,
  };
}

export function validateLibraryViewsRecord(record) {
  const errors = [];
  if (
    !record
    || record.schemaVersion !== SEMANTIC_SCHEMA_VERSION
    || record.recordType !== LIBRARY_VIEWS_TYPE
    || !Array.isArray(record.views)
  ) {
    return {
      valid:false,
      errors:[{
        code:'invalid-library-views-record',
        message:'The saved-library-views record is invalid or unsupported.',
      }],
    };
  }
  if (record.views.length > 250) {
    errors.push({
      code:'too-many-library-views',
      message:'A library may contain at most 250 saved views.',
    });
  }
  const ids = new Set();
  for (const view of record.views) {
    const normalized = normalizeLibraryView(view);
    if (!normalized || JSON.stringify(normalized) !== JSON.stringify({
      viewId:view.viewId,
      name:view.name,
      query:view.query || '',
      filters:{
        readingState:view.filters?.readingState || 'all',
        shelves:view.filters?.shelves || [],
        tags:view.filters?.tags || [],
      },
      sort:view.sort || 'recent',
      createdAt:view.createdAt || null,
      updatedAt:view.updatedAt || null,
    })) {
      errors.push({
        code:'invalid-library-view',
        viewId:view?.viewId || null,
        message:'A saved library view has unsafe or unsupported fields.',
      });
      continue;
    }
    if (ids.has(view.viewId)) {
      errors.push({
        code:'duplicate-library-view-id',
        viewId:view.viewId,
        message:'Saved view ' + view.viewId + ' appears more than once.',
      });
    }
    ids.add(view.viewId);
  }
  return { valid:errors.length === 0, errors };
}

export function upsertLibraryView(
  record,
  view,
  now = () => new Date().toISOString(),
  createId = createRecordId,
) {
  const timestamp = isoNow(now);
  const base = validateLibraryViewsRecord(record).valid
    ? cloneJson(record)
    : makeLibraryViewsRecord({}, () => timestamp);
  const viewId = view?.viewId || createId('view');
  const existing = base.views.find((candidate) => candidate.viewId === viewId);
  const normalized = normalizeLibraryView({
    ...view,
    viewId,
    createdAt:existing?.createdAt || timestamp,
    updatedAt:timestamp,
  });
  if (!normalized) throw new Error('Enter a valid saved-view name and filters.');
  const nextViews = base.views.filter((candidate) => candidate.viewId !== viewId);
  nextViews.push(normalized);
  nextViews.sort((left, right) =>
    left.name.localeCompare(right.name) || left.viewId.localeCompare(right.viewId));
  if (existing && jsonEqual(existing, normalized)) {
    return { record:base, view:existing, changed:false };
  }
  base.views = nextViews;
  base.revision = Math.max(1, Number(base.revision) || 1) + 1;
  base.updatedAt = timestamp;
  return { record:base, view:normalized, changed:true };
}

export function removeLibraryView(
  record,
  viewId,
  now = () => new Date().toISOString(),
) {
  if (!validateLibraryViewsRecord(record).valid) {
    return { record, changed:false };
  }
  const next = cloneJson(record);
  const length = next.views.length;
  next.views = next.views.filter((view) => view.viewId !== viewId);
  if (next.views.length === length) return { record, changed:false };
  next.revision = Math.max(1, Number(next.revision) || 1) + 1;
  next.updatedAt = isoNow(now);
  return { record:next, changed:true };
}

export function mergeLibraryViewsRecords(
  existingRecord,
  incomingRecord,
  now = () => new Date().toISOString(),
) {
  const existingValidation = validateLibraryViewsRecord(existingRecord);
  const incomingValidation = validateLibraryViewsRecord(incomingRecord);
  if (!existingValidation.valid || !incomingValidation.valid) {
    return {
      record:existingRecord,
      changed:false,
      conflicts:['A saved-library-views record is invalid.'],
    };
  }
  const byId = new Map(existingRecord.views.map((view) => [view.viewId, view]));
  const conflicts = [];
  const additions = [];
  for (const view of incomingRecord.views) {
    const known = byId.get(view.viewId);
    if (!known) additions.push(view);
    else if (!jsonEqual(known, view)) {
      conflicts.push('Saved view "' + view.name + '" has the same identity but different data.');
    }
  }
  if (conflicts.length || !additions.length) {
    return { record:existingRecord, changed:false, conflicts };
  }
  const timestamp = isoNow(now);
  const record = makeLibraryViewsRecord({
    views:existingRecord.views.concat(cloneJson(additions)),
    revision:Math.max(
      Number(existingRecord.revision) || 1,
      Number(incomingRecord.revision) || 1,
    ) + 1,
  }, () => timestamp);
  return { record, changed:true, conflicts:[] };
}

export function makeWorkManifest({
  filename,
  sidecar = null,
  now = () => new Date().toISOString(),
  createId = createRecordId,
}) {
  const createdAt = isoNow(now);
  const workId = createId('work');
  const editionId = createId('edition');
  const assetId = createId('asset');
  const legacyBookId = sidecar?.bookId || legacyBookIdFor(filename);
  const title = sidecar?.title || titleFromFilename(filename);
  const format = extensionOf(filename);

  return {
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    recordType: RECORD_TYPE,
    workId,
    title,
    authors: authorRecords(sidecar?.author),
    metadataProvenance: {
      title: sidecar?.title ? 'legacy-sidecar' : 'filename',
      authors: sidecar?.author ? 'legacy-sidecar' : null,
    },
    userMetadata: {
      rating: null,
      tags: [],
      shelves: [],
    },
    editions: [{
      editionId,
      language: null,
      identifiers: {},
      assetIds: [assetId],
      createdAt,
      updatedAt: createdAt,
    }],
    assets: [{
      assetId,
      editionId,
      sourcePath: 'library/' + filename,
      sourceFilename: filename,
      format,
      byteLength: null,
      fingerprint: null,
      fingerprintStatus: 'pending',
      availability: 'available',
      importedAt: createdAt,
      updatedAt: createdAt,
    }],
    legacy: {
      bookIds: [legacyBookId],
      sourceFilenames: [filename],
      sidecarPath: sidecar?.bookId ? 'notes/' + sidecar.bookId + '.json' : null,
    },
    createdAt,
    updatedAt: createdAt,
  };
}

export function updateWorkMetadata(manifest, sidecar, now = () => new Date().toISOString()) {
  if (!manifest || !sidecar) return { manifest, changed: false };
  const next = cloneJson(manifest);
  let changed = false;
  const title = typeof sidecar.title === 'string' ? sidecar.title.trim() : '';
  const authors = authorRecords(sidecar.author);
  if (title && next.title !== title && next.metadataProvenance?.title !== 'user') {
    next.title = title;
    next.metadataProvenance = {
      ...(next.metadataProvenance || {}),
      title: 'legacy-sidecar',
    };
    changed = true;
  }
  if (
    authors.length
    && !jsonEqual(next.authors, authors)
    && next.metadataProvenance?.authors !== 'user'
  ) {
    next.authors = authors;
    next.metadataProvenance = {
      ...(next.metadataProvenance || {}),
      authors: 'legacy-sidecar',
    };
    changed = true;
  }
  const legacyBookId = sidecar.bookId;
  if (legacyBookId && !next.legacy.bookIds.includes(legacyBookId)) {
    next.legacy.bookIds.push(legacyBookId);
    next.legacy.bookIds.sort();
    changed = true;
  }
  const sidecarPath = legacyBookId ? 'notes/' + legacyBookId + '.json' : null;
  if (sidecarPath && next.legacy.sidecarPath !== sidecarPath) {
    next.legacy.sidecarPath = sidecarPath;
    changed = true;
  }
  if (changed) next.updatedAt = isoNow(now);
  return { manifest: next, changed };
}

export function updateWorkDetails(
  manifest,
  { title, authors, tags, shelves, rating, isbn = undefined },
  now = () => new Date().toISOString(),
) {
  if (!manifest) return { manifest, changed: false };
  const next = cloneJson(manifest);
  const normalizedTitle = typeof title === 'string' ? title.trim() : next.title;
  const normalizedAuthors = (Array.isArray(authors) ? authors : [authors])
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean)
    .map((name) => ({ name, source: 'user' }));
  const normalizeList = (value) => Array.from(new Set(
    (Array.isArray(value) ? value : [value])
      .map((item) => typeof item === 'string' ? item.trim() : '')
      .filter(Boolean),
  )).sort((left, right) => left.localeCompare(right));
  const normalizedTags = normalizeList(tags);
  const normalizedShelves = normalizeList(shelves);
  const normalizedRating = rating == null || rating === ''
    ? null : Math.max(0, Math.min(5, Number(rating)));

  if (normalizedTitle) next.title = normalizedTitle;
  next.authors = normalizedAuthors;
  next.metadataProvenance = {
    ...(next.metadataProvenance || {}),
    title: 'user',
    authors: 'user',
  };
  next.userMetadata = {
    ...(next.userMetadata || {}),
    tags: normalizedTags,
    shelves: normalizedShelves,
    rating: Number.isFinite(normalizedRating) ? normalizedRating : null,
  };
  if (isbn !== undefined && next.editions?.[0]) {
    const normalizedIsbn = String(isbn || '')
      .toUpperCase()
      .replace(/[^\dX]/g, '');
    const edition = next.editions[0];
    const identifiers = { ...(edition.identifiers || {}) };
    delete identifiers['isbn-10'];
    delete identifiers['isbn-13'];
    if (normalizedIsbn.length === 10 || normalizedIsbn.length === 13) {
      identifiers[
        normalizedIsbn.length === 13 ? 'isbn-13' : 'isbn-10'
      ] = [normalizedIsbn];
    }
    edition.identifiers = identifiers;
    edition.metadataProvenance = {
      ...(edition.metadataProvenance || {}),
      identifiers:'user',
    };
    edition.updatedAt = isoNow(now);
  }
  const comparableBefore = {
    title: manifest.title,
    authors: manifest.authors || [],
    userMetadata: manifest.userMetadata || {},
    metadataProvenance: manifest.metadataProvenance || {},
    editions:manifest.editions || [],
  };
  const comparableAfter = {
    title: next.title,
    authors: next.authors,
    userMetadata: next.userMetadata,
    metadataProvenance: next.metadataProvenance,
    editions:next.editions || [],
  };
  if (jsonEqual(comparableBefore, comparableAfter)) {
    return { manifest, changed: false };
  }
  next.updatedAt = isoNow(now);
  return { manifest: next, changed: true };
}

function validConceptId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 500
    && !/[\u0000-\u001f]/.test(value);
}

export function updateConceptCuration(
  manifest,
  conceptId,
  { labelOverride = null, hidden = false, mergedInto = null } = {},
  now = () => new Date().toISOString(),
) {
  if (!manifest || !validConceptId(conceptId)) {
    return { manifest, changed:false };
  }
  const normalizedLabel = typeof labelOverride === 'string'
    ? labelOverride.trim().slice(0, 160) : '';
  const normalizedMergedInto = validConceptId(mergedInto)
    && mergedInto !== conceptId ? mergedInto : null;
  const next = cloneJson(manifest);
  const prior = next.userMetadata?.conceptCuration?.[conceptId] || null;
  const isDefault = !normalizedLabel && hidden !== true && !normalizedMergedInto;
  const nextEntry = isDefault ? null : {
    labelOverride:normalizedLabel || null,
    hidden:hidden === true,
    mergedInto:normalizedMergedInto,
    updatedAt:isoNow(now),
  };
  const comparablePrior = prior ? {
    labelOverride:prior.labelOverride || null,
    hidden:prior.hidden === true,
    mergedInto:prior.mergedInto || null,
  } : null;
  const comparableNext = nextEntry ? {
    labelOverride:nextEntry.labelOverride,
    hidden:nextEntry.hidden,
    mergedInto:nextEntry.mergedInto,
  } : null;
  if (jsonEqual(comparablePrior, comparableNext)) {
    return { manifest, changed:false };
  }
  next.userMetadata = {
    ...(next.userMetadata || {}),
    conceptCuration:{
      ...(next.userMetadata?.conceptCuration || {}),
    },
  };
  if (nextEntry) {
    next.userMetadata.conceptCuration[conceptId] = nextEntry;
  } else {
    delete next.userMetadata.conceptCuration[conceptId];
  }
  if (!Object.keys(next.userMetadata.conceptCuration).length) {
    delete next.userMetadata.conceptCuration;
  }
  next.updatedAt = isoNow(now);
  return { manifest:next, changed:true };
}

export function curateSemanticConcepts(
  concepts,
  manifest,
  { includeHidden = false, includeMerged = false } = {},
) {
  const source = Array.isArray(concepts) ? concepts : [];
  const knownIds = new Set(
    source.map((concept) => concept?.conceptId).filter(validConceptId),
  );
  const overrides = manifest?.userMetadata?.conceptCuration || {};
  const curated = source.map((concept) => {
    const next = cloneJson(concept);
    const override = overrides[next.conceptId] || null;
    const mergedInto = validConceptId(override?.mergedInto)
      && override.mergedInto !== next.conceptId
      && knownIds.has(override.mergedInto)
      ? override.mergedInto : null;
    next.userState = {
      ...(next.userState || {}),
      labelOverride:override?.labelOverride
        || next.userState?.labelOverride
        || null,
      hidden:override?.hidden === true || next.userState?.hidden === true,
      mergedInto,
      curationSource:override ? 'portable-manifest' : null,
    };
    return next;
  });
  const byId = new Map(curated.map((concept) => [concept.conceptId, concept]));
  for (const concept of curated) {
    const target = concept.userState?.mergedInto
      && byId.get(concept.userState.mergedInto);
    if (!target) continue;
    target.userState = {
      ...(target.userState || {}),
      mergedConceptIds:Array.from(new Set([
        ...(target.userState?.mergedConceptIds || []),
        concept.conceptId,
      ])).sort(),
    };
    const evidenceKeys = new Set(
      (target.evidence || []).map((evidence) =>
        String(evidence.passageId || '') + '\u001f' +
        String(evidence.quoteHash || '')),
    );
    target.evidence = (target.evidence || []).concat(
      (concept.evidence || []).filter((evidence) => {
        const key = String(evidence.passageId || '') + '\u001f' +
          String(evidence.quoteHash || '');
        if (evidenceKeys.has(key)) return false;
        evidenceKeys.add(key);
        return true;
      }).map(cloneJson),
    );
  }
  return curated.filter((concept) =>
    (includeHidden || !concept.userState?.hidden)
    && (includeMerged || !concept.userState?.mergedInto)
  );
}

export function updateAssetFingerprint(
  manifest,
  assetId,
  { fingerprint, byteLength },
  now = () => new Date().toISOString(),
) {
  const next = cloneJson(manifest);
  const asset = next.assets.find((candidate) => candidate.assetId === assetId);
  if (!asset) return { manifest, changed: false };
  const normalizedLength = Number.isFinite(Number(byteLength))
    ? Number(byteLength) : null;
  if (
    asset.fingerprint === fingerprint
    && asset.byteLength === normalizedLength
    && asset.fingerprintStatus === 'complete'
  ) return { manifest, changed: false };
  const updatedAt = isoNow(now);
  asset.fingerprint = fingerprint;
  asset.byteLength = normalizedLength;
  asset.fingerprintStatus = 'complete';
  asset.updatedAt = updatedAt;
  next.updatedAt = updatedAt;
  return { manifest: next, changed: true };
}

export function recoverRenamedAssetIdentity(
  previousManifest,
  discoveredManifest,
  {
    previousAssetId,
    currentFilename,
    fingerprint,
    byteLength,
  } = {},
  now = () => new Date().toISOString(),
) {
  const primary = normalizeManifest(previousManifest);
  const duplicate = normalizeManifest(discoveredManifest);
  if (
    !primary
    || !duplicate
    || primary.workId === duplicate.workId
    || !previousAssetId
    || !currentFilename
    || !fingerprint
  ) {
    throw new Error('Rename recovery requires two valid works and a strong fingerprint.');
  }
  const asset = primary.assets.find((candidate) =>
    candidate.assetId === previousAssetId);
  if (
    !asset
    || asset.availability !== 'missing'
    || asset.fingerprint !== fingerprint
  ) {
    throw new Error('The previous asset does not match the renamed source fingerprint.');
  }
  const timestamp = isoNow(now);
  const previousFilename = asset.sourceFilename;
  asset.sourceFilename = String(currentFilename);
  asset.sourcePath = 'library/' + String(currentFilename);
  asset.format = extensionOf(currentFilename) || asset.format;
  asset.byteLength = Number.isFinite(Number(byteLength))
    ? Number(byteLength) : asset.byteLength;
  asset.fingerprintStatus = 'complete';
  asset.availability = 'available';
  asset.updatedAt = timestamp;
  primary.legacy = {
    ...(primary.legacy || {}),
    sourceFilenames:unionStrings(
      primary.legacy?.sourceFilenames,
      [previousFilename, currentFilename],
    ),
  };
  primary.updatedAt = timestamp;

  duplicate.recordState = 'merged';
  duplicate.mergedInto = primary.workId;
  duplicate.mergedAt = timestamp;
  duplicate.mergeReason = 'strong-fingerprint-rename-recovery';
  duplicate.updatedAt = timestamp;
  return { primary, tombstone:duplicate };
}

export function markAssetTrashed(
  manifest,
  assetId,
  { trashId },
  now = () => new Date().toISOString(),
) {
  if (!manifest || !assetId || !trashId) {
    return { manifest, changed:false };
  }
  const next = cloneJson(manifest);
  const asset = next.assets.find((candidate) => candidate.assetId === assetId);
  if (!asset || asset.availability === 'removed') {
    return { manifest, changed:false };
  }
  if (asset.availability === 'trashed' && asset.trash?.trashId === trashId) {
    return { manifest, changed:false };
  }
  const timestamp = isoNow(now);
  asset.availability = 'trashed';
  asset.trash = {
    trashId:String(trashId),
    trashedAt:timestamp,
  };
  asset.updatedAt = timestamp;
  next.updatedAt = timestamp;
  return { manifest:next, changed:true };
}

export function restoreTrashedAsset(
  manifest,
  assetId,
  { trashId },
  now = () => new Date().toISOString(),
) {
  if (!manifest || !assetId || !trashId) {
    return { manifest, changed:false };
  }
  const next = cloneJson(manifest);
  const asset = next.assets.find((candidate) => candidate.assetId === assetId);
  if (
    !asset
    || asset.availability !== 'trashed'
    || asset.trash?.trashId !== trashId
  ) {
    return { manifest, changed:false };
  }
  const timestamp = isoNow(now);
  asset.availability = 'available';
  asset.trashHistory = (asset.trashHistory || []).concat([{
    ...asset.trash,
    restoredAt:timestamp,
  }]);
  delete asset.trash;
  asset.updatedAt = timestamp;
  next.updatedAt = timestamp;
  return { manifest:next, changed:true };
}

export function removeTrashedAsset(
  manifest,
  assetId,
  { trashId },
  now = () => new Date().toISOString(),
) {
  if (!manifest || !assetId || !trashId) {
    return { manifest, changed:false };
  }
  const next = cloneJson(manifest);
  const asset = next.assets.find((candidate) => candidate.assetId === assetId);
  if (
    !asset
    || asset.availability !== 'trashed'
    || asset.trash?.trashId !== trashId
  ) {
    return { manifest, changed:false };
  }
  const timestamp = isoNow(now);
  asset.availability = 'removed';
  asset.trashHistory = (asset.trashHistory || []).concat([{
    ...asset.trash,
    removedAt:timestamp,
  }]);
  delete asset.trash;
  asset.updatedAt = timestamp;
  next.updatedAt = timestamp;
  return { manifest:next, changed:true };
}

export async function sha256Fingerprint(value) {
  let buffer;
  if (value instanceof ArrayBuffer) buffer = value;
  else if (ArrayBuffer.isView(value)) {
    buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  } else {
    throw new Error('A binary value is required for asset fingerprinting.');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return 'sha256:' + Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
}

function normalizeManifest(manifest) {
  if (
    !manifest
    || manifest.schemaVersion !== SEMANTIC_SCHEMA_VERSION
    || manifest.recordType !== RECORD_TYPE
    || typeof manifest.workId !== 'string'
    || !manifest.workId
    || !Array.isArray(manifest.editions)
    || !Array.isArray(manifest.assets)
  ) return null;
  return cloneJson(manifest);
}

function catalogPayload(manifests) {
  const aliases = {
    legacyBookIds: {},
    sourceFilenames: {},
  };
  const works = manifests
    .filter((manifest) => manifest.recordState !== 'merged')
    .map((manifest) => {
      const sourceFilenames = manifest.assets
        .filter((asset) =>
          asset.availability === 'available' || asset.availability === 'missing')
        .map((asset) => asset.sourceFilename)
        .filter(Boolean)
        .sort();
      for (const filename of sourceFilenames) {
        aliases.sourceFilenames[filename] = manifest.workId;
      }
      for (const bookId of manifest.legacy?.bookIds || []) {
        aliases.legacyBookIds[bookId] = manifest.workId;
      }
      return {
        workId: manifest.workId,
        title: manifest.title,
        authors: cloneJson(manifest.authors || []),
        sourceFilenames,
        assetCount: manifest.assets.filter((asset) =>
          asset.availability === 'available' || asset.availability === 'missing').length,
        availableAssetCount: manifest.assets.filter((asset) => asset.availability === 'available').length,
        rating: manifest.userMetadata?.rating ?? null,
        tags: cloneJson(manifest.userMetadata?.tags || []),
        shelves: cloneJson(manifest.userMetadata?.shelves || []),
        manifestPath: manifestPath(manifest.workId),
        updatedAt: manifest.updatedAt,
      };
    })
    .sort((left, right) => left.workId.localeCompare(right.workId));
  for (const manifest of manifests) {
    if (manifest.recordState !== 'merged' || !manifest.mergedInto) continue;
    for (const filename of manifest.legacy?.sourceFilenames || []) {
      if (!aliases.sourceFilenames[filename]) {
        aliases.sourceFilenames[filename] = manifest.mergedInto;
      }
    }
    for (const bookId of manifest.legacy?.bookIds || []) {
      if (!aliases.legacyBookIds[bookId]) {
        aliases.legacyBookIds[bookId] = manifest.mergedInto;
      }
    }
  }
  return { works, aliases };
}

function unionStrings(left, right) {
  return Array.from(new Set(
    [...(left || []), ...(right || [])].filter(
      (value) => typeof value === 'string' && value,
    ),
  )).sort((a, b) => a.localeCompare(b));
}

export function mergeWorkManifests(
  primaryManifest,
  secondaryManifest,
  now = () => new Date().toISOString(),
) {
  const primary = normalizeManifest(primaryManifest);
  const secondary = normalizeManifest(secondaryManifest);
  if (!primary || !secondary) throw new Error('Both work manifests must be valid.');
  if (primary.workId === secondary.workId) {
    throw new Error('A work cannot be grouped with itself.');
  }
  if (primary.recordState === 'merged' || secondary.recordState === 'merged') {
    throw new Error('Split an existing grouped work before grouping it again.');
  }
  const primaryAssetIds = new Set(primary.assets.map((asset) => asset.assetId));
  if (secondary.assets.some((asset) => primaryAssetIds.has(asset.assetId))) {
    throw new Error('The works contain a duplicate asset identity.');
  }
  const primaryEditionIds = new Set(
    primary.editions.map((edition) => edition.editionId),
  );
  if (secondary.editions.some(
    (edition) => primaryEditionIds.has(edition.editionId),
  )) {
    throw new Error('The works contain a duplicate edition identity.');
  }
  const timestamp = isoNow(now);
  const merged = cloneJson(primary);
  merged.editions = merged.editions.concat(cloneJson(secondary.editions));
  merged.assets = merged.assets.concat(cloneJson(secondary.assets));
  merged.legacy = {
    ...(merged.legacy || {}),
    bookIds:unionStrings(merged.legacy?.bookIds, secondary.legacy?.bookIds),
    sourceFilenames:unionStrings(
      merged.legacy?.sourceFilenames,
      secondary.legacy?.sourceFilenames,
    ),
    sidecarPath:merged.legacy?.sidecarPath || secondary.legacy?.sidecarPath || null,
  };
  merged.userMetadata = {
    ...(merged.userMetadata || {}),
    rating:merged.userMetadata?.rating ?? secondary.userMetadata?.rating ?? null,
    tags:unionStrings(
      merged.userMetadata?.tags,
      secondary.userMetadata?.tags,
    ),
    shelves:unionStrings(
      merged.userMetadata?.shelves,
      secondary.userMetadata?.shelves,
    ),
    conceptCuration:{
      ...(secondary.userMetadata?.conceptCuration || {}),
      ...(merged.userMetadata?.conceptCuration || {}),
    },
  };
  if (!Object.keys(merged.userMetadata.conceptCuration).length) {
    delete merged.userMetadata.conceptCuration;
  }
  merged.grouping = {
    ...(merged.grouping || {}),
    mergedFrom:(merged.grouping?.mergedFrom || []).concat([{
      workId:secondary.workId,
      title:secondary.title,
      mergedAt:timestamp,
      reason:'user-confirmed-format-grouping',
    }]),
  };
  merged.updatedAt = timestamp;

  const tombstone = cloneJson(secondary);
  tombstone.recordState = 'merged';
  tombstone.mergedInto = primary.workId;
  tombstone.mergedAt = timestamp;
  tombstone.updatedAt = timestamp;
  return { merged, tombstone };
}

export function splitWorkManifests(
  groupedManifest,
  tombstoneManifest,
  now = () => new Date().toISOString(),
) {
  const grouped = normalizeManifest(groupedManifest);
  const tombstone = normalizeManifest(tombstoneManifest);
  if (
    !grouped
    || !tombstone
    || tombstone.recordState !== 'merged'
    || tombstone.mergedInto !== grouped.workId
  ) {
    throw new Error('These manifests do not describe a reversible grouped work.');
  }
  const timestamp = isoNow(now);
  const splitAssetIds = new Set(tombstone.assets.map((asset) => asset.assetId));
  const splitEditionIds = new Set(
    tombstone.editions.map((edition) => edition.editionId),
  );
  const primary = cloneJson(grouped);
  primary.assets = primary.assets.filter(
    (asset) => !splitAssetIds.has(asset.assetId),
  );
  primary.editions = primary.editions.filter(
    (edition) => !splitEditionIds.has(edition.editionId),
  );
  primary.grouping = {
    ...(primary.grouping || {}),
    mergedFrom:(primary.grouping?.mergedFrom || []).filter(
      (entry) => entry.workId !== tombstone.workId,
    ),
  };
  if (!primary.grouping.mergedFrom.length) delete primary.grouping;
  primary.updatedAt = timestamp;

  const restored = cloneJson(tombstone);
  delete restored.recordState;
  delete restored.mergedInto;
  delete restored.mergedAt;
  restored.updatedAt = timestamp;
  return { primary, restored };
}

export function rebuildCatalog(
  manifests,
  existingCatalog = null,
  now = () => new Date().toISOString(),
) {
  const payload = catalogPayload(manifests);
  const existingPayload = existingCatalog && {
    works: existingCatalog.works,
    aliases: existingCatalog.aliases,
  };
  const changed = (
    !existingCatalog
    || existingCatalog.schemaVersion !== SEMANTIC_SCHEMA_VERSION
    || existingCatalog.recordType !== CATALOG_TYPE
    || !jsonEqual(existingPayload, payload)
  );
  if (!changed) return { catalog: cloneJson(existingCatalog), changed: false };
  return {
    catalog: {
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      recordType: CATALOG_TYPE,
      revision: Math.max(0, Number(existingCatalog?.revision) || 0) + 1,
      works: payload.works,
      aliases: payload.aliases,
      updatedAt: isoNow(now),
    },
    changed: true,
  };
}

function normalizedGroupingText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function groupingKeyFor(manifest) {
  const title = normalizedGroupingText(manifest?.title);
  const authors = (manifest?.authors || [])
    .map((author) => normalizedGroupingText(author?.name))
    .filter(Boolean)
    .sort();
  return {
    title,
    authors,
    key: title + '\n' + authors.join('|'),
  };
}

export function validateSemanticLibrary({
  sourceFilenames = [],
  manifests = [],
  catalog = null,
  annotations = [],
} = {}) {
  const errors = [];
  const warnings = [];
  const validManifests = [];
  const workIds = new Set();
  const assetIds = new Set();
  const claimedSources = new Map();
  const sourceSet = new Set(
    sourceFilenames.filter((filename) => typeof filename === 'string' && filename),
  );

  manifests.forEach((candidate, index) => {
    const manifest = normalizeManifest(candidate);
    if (!manifest) {
      errors.push({
        code: 'invalid-work-manifest',
        message: 'Work manifest ' + (index + 1) + ' is invalid or uses an unsupported schema.',
      });
      return;
    }
    validManifests.push(manifest);
    if (workIds.has(manifest.workId)) {
      errors.push({
        code: 'duplicate-work-id',
        workId: manifest.workId,
        message: 'Work id ' + manifest.workId + ' appears more than once.',
      });
    }
    workIds.add(manifest.workId);
    if (manifest.recordState === 'merged') return;
    for (const asset of manifest.assets) {
      if (!asset?.assetId) {
        errors.push({
          code: 'missing-asset-id',
          workId: manifest.workId,
          message: 'A source asset in ' + manifest.title + ' has no identity.',
        });
      } else if (assetIds.has(asset.assetId)) {
        errors.push({
          code: 'duplicate-asset-id',
          assetId: asset.assetId,
          message: 'Asset id ' + asset.assetId + ' appears more than once.',
        });
      }
      if (asset?.assetId) assetIds.add(asset.assetId);
      if (asset?.availability === 'trashed' || asset?.availability === 'removed') {
        continue;
      }
      if (!asset?.sourceFilename) continue;
      const claims = claimedSources.get(asset.sourceFilename) || [];
      claims.push(manifest.workId);
      claimedSources.set(asset.sourceFilename, claims);
    }
  });

  for (const manifest of validManifests) {
    if (manifest.recordState !== 'merged') continue;
    if (
      !manifest.mergedInto
      || manifest.mergedInto === manifest.workId
      || !workIds.has(manifest.mergedInto)
    ) {
      errors.push({
        code:'invalid-work-merge-redirect',
        workId:manifest.workId,
        message:'Grouped work ' + manifest.workId +
          ' does not point to a valid active work.',
      });
    }
  }

  for (const [filename, claims] of claimedSources) {
    if (claims.length > 1) {
      errors.push({
        code: 'source-claimed-by-multiple-works',
        filename,
        workIds: claims,
        message: filename + ' is claimed by multiple works.',
      });
    }
    if (!sourceSet.has(filename)) {
      warnings.push({
        code: 'missing-source',
        filename,
        workId: claims[0],
        message: filename + ' is represented in portable metadata but its original is missing.',
      });
    }
  }
  for (const filename of sourceSet) {
    if (!claimedSources.has(filename)) {
      warnings.push({
        code: 'untracked-source',
        filename,
        message: filename + ' has no portable work manifest yet.',
      });
    }
  }

  for (const record of annotations) {
    if (!record || record.recordType !== ANNOTATIONS_TYPE || !record.workId) {
      errors.push({
        code: 'invalid-annotations-record',
        message: 'A portable annotations record is invalid.',
      });
    } else if (!workIds.has(record.workId)) {
      warnings.push({
        code: 'orphan-annotations',
        workId: record.workId,
        message: 'Annotations for ' + record.workId + ' have no matching work manifest.',
      });
    }
  }

  const fingerprintGroups = new Map();
  for (const manifest of validManifests) {
    if (manifest.recordState === 'merged') continue;
    for (const asset of manifest.assets) {
      if (
        !asset?.fingerprint
        || asset.fingerprintStatus !== 'complete'
        || asset.availability === 'trashed'
        || asset.availability === 'removed'
      ) continue;
      const rows = fingerprintGroups.get(asset.fingerprint) || [];
      rows.push({
        workId: manifest.workId,
        title: manifest.title,
        assetId: asset.assetId,
        filename: asset.sourceFilename,
      });
      fingerprintGroups.set(asset.fingerprint, rows);
    }
  }
  const exactDuplicates = Array.from(fingerprintGroups, ([fingerprint, assets]) => ({
    fingerprint,
    assets,
  })).filter((group) => group.assets.length > 1);
  for (const duplicate of exactDuplicates) {
    warnings.push({
      code: 'exact-duplicate-assets',
      fingerprint: duplicate.fingerprint,
      message: duplicate.assets.map((asset) => asset.filename).join(', ') +
        ' contain identical source bytes.',
    });
  }

  const groupingCandidates = new Map();
  for (const manifest of validManifests) {
    if (manifest.recordState === 'merged') continue;
    if (!manifest.assets.some((asset) =>
      asset.availability === 'available' || asset.availability === 'missing')) {
      continue;
    }
    const grouping = groupingKeyFor(manifest);
    if (!grouping.title) continue;
    const rows = groupingCandidates.get(grouping.key) || [];
    rows.push({
      workId: manifest.workId,
      title: manifest.title,
      authors: (manifest.authors || []).map((author) => author.name),
      formats: Array.from(new Set(
        manifest.assets.map((asset) => asset.format).filter(Boolean),
      )).sort(),
    });
    groupingCandidates.set(grouping.key, rows);
  }
  const groupingSuggestions = Array.from(groupingCandidates.values())
    .filter((works) => works.length > 1)
    .map((works) => ({
      confidence: works.every((work) => work.authors.length) ? 'likely' : 'possible',
      reason: works.every((work) => work.authors.length)
        ? 'matching normalized title and authors'
        : 'matching normalized title; author evidence is incomplete',
      works,
    }));

  const rebuilt = rebuildCatalog(
    validManifests,
    catalog,
    () => catalog?.updatedAt || new Date(0).toISOString(),
  );
  if (rebuilt.changed) {
    warnings.push({
      code: 'catalog-needs-rebuild',
      message: 'The rebuildable catalog does not match the canonical work manifests.',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    exactDuplicates,
    groupingSuggestions,
    catalogNeedsRebuild: rebuilt.changed,
    rebuiltCatalog: rebuilt.catalog,
    summary: {
      sources: sourceSet.size,
      works: validManifests.filter(
        (manifest) => manifest.recordState !== 'merged',
      ).length,
      assets: validManifests.reduce(
        (sum, manifest) => sum + (
          manifest.recordState === 'merged' ? 0 : manifest.assets.length
        ),
        0,
      ),
      annotationRecords: annotations.length,
    },
  };
}

function safeBundleFilename(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 500
    && !value.includes('/')
    && !value.includes('\\')
    && value !== '.'
    && value !== '..';
}

function containsUnsafeEchoEvaluationData(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) =>
    ['excerpt', 'sourceText', 'bookText', 'results'].includes(key)
    || containsUnsafeEchoEvaluationData(nested));
}

export function createPortableBundle({
  manifests = [],
  annotations = [],
  legacySidecars = [],
  libraryViews = null,
  echoCuration = null,
  echoEvaluations = null,
  assets = [],
  libraryLabel = null,
  now = () => new Date().toISOString(),
} = {}) {
  return {
    bundleVersion: PORTABLE_BUNDLE_VERSION,
    recordType: PORTABLE_BUNDLE_TYPE,
    semanticSchemaVersion: SEMANTIC_SCHEMA_VERSION,
    exportedAt: isoNow(now),
    libraryLabel: libraryLabel ? String(libraryLabel) : null,
    assets: cloneJson(assets),
    records: {
      works: cloneJson(manifests),
      annotations: cloneJson(annotations),
      legacySidecars: cloneJson(legacySidecars),
      ...(libraryViews ? { views:cloneJson(libraryViews) } : {}),
      ...(echoCuration ? { echoCuration:cloneJson(echoCuration) } : {}),
      ...(echoEvaluations ? { echoEvaluations:cloneJson(echoEvaluations) } : {}),
    },
    omittedRebuildableData: [
      'catalog/catalog.json',
      'passages/',
      'indexes/',
      'semantics/',
      'processing/',
      'covers/',
    ],
  };
}

export function validatePortableBundle(bundle) {
  const errors = [];
  const warnings = [];
  if (!bundle || bundle.recordType !== PORTABLE_BUNDLE_TYPE) {
    errors.push({
      code: 'invalid-bundle-type',
      message: 'This is not a Lorewell portable-library bundle.',
    });
  }
  if (bundle?.bundleVersion !== PORTABLE_BUNDLE_VERSION) {
    errors.push({
      code: 'unsupported-bundle-version',
      message: 'Bundle version ' + String(bundle?.bundleVersion) + ' is not supported.',
    });
  }
  if (bundle?.semanticSchemaVersion > SEMANTIC_SCHEMA_VERSION) {
    errors.push({
      code: 'future-semantic-schema',
      message: 'This bundle uses a newer semantic-library schema.',
    });
  }

  const works = Array.isArray(bundle?.records?.works) ? bundle.records.works : [];
  const annotations = Array.isArray(bundle?.records?.annotations)
    ? bundle.records.annotations : [];
  const legacySidecars = Array.isArray(bundle?.records?.legacySidecars)
    ? bundle.records.legacySidecars : [];
  const libraryViews = bundle?.records?.views || null;
  const echoCuration = bundle?.records?.echoCuration || null;
  const echoEvaluations = bundle?.records?.echoEvaluations || null;
  const assets = Array.isArray(bundle?.assets) ? bundle.assets : [];
  if (!Array.isArray(bundle?.records?.works)) {
    errors.push({ code: 'missing-work-records', message: 'The bundle has no work-record list.' });
  }
  if (!Array.isArray(bundle?.assets)) {
    errors.push({ code: 'missing-assets', message: 'The bundle has no source-asset list.' });
  }

  const filenames = new Set();
  for (const asset of assets) {
    if (!safeBundleFilename(asset?.filename)) {
      errors.push({
        code: 'unsafe-asset-filename',
        message: 'A bundled source has an unsafe filename.',
      });
      continue;
    }
    if (filenames.has(asset.filename)) {
      errors.push({
        code: 'duplicate-bundle-filename',
        filename: asset.filename,
        message: asset.filename + ' appears more than once in the bundle.',
      });
    }
    filenames.add(asset.filename);
    if (typeof asset.dataBase64 !== 'string' || !asset.dataBase64) {
      errors.push({
        code: 'missing-asset-data',
        filename: asset.filename,
        message: asset.filename + ' has no encoded original bytes.',
      });
    }
  }
  for (const sidecar of legacySidecars) {
    if (
      !sidecar
      || !safeBundleFilename(sidecar.sourceFilename)
      || typeof sidecar.bookId !== 'string'
      || !/^[a-zA-Z0-9_-]{1,240}$/.test(sidecar.bookId)
    ) {
      errors.push({
        code: 'unsafe-legacy-sidecar',
        message: 'A legacy reading-data record has an unsafe identity.',
      });
    }
  }
  if (libraryViews) {
    const viewValidation = validateLibraryViewsRecord(libraryViews);
    errors.push(...viewValidation.errors);
  }
  if (
    echoCuration
    && (
      echoCuration.recordType !== 'books.echo-curation'
      || typeof echoCuration.connectionFeedback !== 'object'
      || typeof echoCuration.workExclusions !== 'object'
    )
  ) {
    errors.push({
      code:'invalid-echo-curation',
      message:'The bundle contains an invalid Ideas & connections curation record.',
    });
  }
  if (
    echoEvaluations
    && (
      echoEvaluations.recordType !== 'books.echo-evaluations'
      || typeof echoEvaluations.connectionJudgments !== 'object'
      || typeof echoEvaluations.queryJudgments !== 'object'
    )
  ) {
    errors.push({
      code:'invalid-echo-evaluations',
      message:'The bundle contains an invalid connection-evaluation record.',
    });
  } else if (echoEvaluations) {
    const connectionLabels = new Set([
      'useful', 'obvious', 'weak', 'wrong', 'repetitive', 'spoiler-sensitive',
    ]);
    const queryLabels = new Set([
      'good', 'mixed', 'poor', 'duplicate', 'missing',
    ]);
    const connectionRows = Object.values(echoEvaluations.connectionJudgments || {});
    const queryRows = Object.values(echoEvaluations.queryJudgments || {});
    if (
      connectionRows.length > 10000
      || queryRows.length > 1000
      || connectionRows.some((row) =>
        !connectionLabels.has(row?.label)
        || typeof row?.linkId !== 'string'
        || String(row?.notes || '').length > 1200
        || containsUnsafeEchoEvaluationData(row))
      || queryRows.some((row) =>
        !queryLabels.has(row?.label)
        || String(row?.query || '').length > 120
        || String(row?.notes || '').length > 1200
        || containsUnsafeEchoEvaluationData(row))
    ) {
      errors.push({
        code:'unsafe-echo-evaluations',
        message:'Connection evaluations contain unsupported labels, source text, or oversized fields.',
      });
    }
  }

  const libraryValidation = validateSemanticLibrary({
    sourceFilenames: Array.from(filenames),
    manifests: works,
    annotations,
  });
  errors.push(...libraryValidation.errors);
  warnings.push(
    ...libraryValidation.warnings.filter(
      (warning) => warning.code !== 'catalog-needs-rebuild',
    ),
  );
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      works: works.length,
      assets: assets.length,
      annotationRecords: annotations.length,
      legacySidecars: legacySidecars.length,
      savedViews:libraryViews?.views?.length || 0,
      echoCuration:echoCuration ? 1 : 0,
      echoEvaluations:echoEvaluations ? 1 : 0,
    },
  };
}

export function reconcileSemanticLibrary({
  sourceFilenames = [],
  sidecars = [],
  existingManifests = [],
  existingCatalog = null,
  now = () => new Date().toISOString(),
  createId = createRecordId,
} = {}) {
  const availableSources = new Set(
    sourceFilenames.filter((value) => typeof value === 'string' && value),
  );
  const sidecarByFilename = new Map(
    sidecars
      .filter((sidecar) => sidecar && typeof sidecar.sourceFilename === 'string')
      .map((sidecar) => [sidecar.sourceFilename, sidecar]),
  );
  const manifests = existingManifests
    .map(normalizeManifest)
    .filter(Boolean);
  const changedWorkIds = new Set();
  const assetByFilename = new Map();

  for (const manifest of manifests) {
    if (manifest.recordState === 'merged') continue;
    for (const asset of manifest.assets) {
      if (
        asset?.sourceFilename
        && asset.availability !== 'trashed'
        && asset.availability !== 'removed'
        && !assetByFilename.has(asset.sourceFilename)
      ) {
        assetByFilename.set(asset.sourceFilename, { manifest, asset });
      }
    }
  }

  for (const filename of availableSources) {
    const known = assetByFilename.get(filename);
    if (!known) {
      const manifest = makeWorkManifest({
        filename,
        sidecar: sidecarByFilename.get(filename) || null,
        now,
        createId,
      });
      manifests.push(manifest);
      changedWorkIds.add(manifest.workId);
      assetByFilename.set(filename, { manifest, asset: manifest.assets[0] });
      continue;
    }
    if (known.asset.availability !== 'available') {
      known.asset.availability = 'available';
      known.asset.updatedAt = isoNow(now);
      known.manifest.updatedAt = known.asset.updatedAt;
      changedWorkIds.add(known.manifest.workId);
    }
    const metadataUpdate = updateWorkMetadata(
      known.manifest,
      sidecarByFilename.get(filename),
      now,
    );
    if (metadataUpdate.changed) {
      const index = manifests.indexOf(known.manifest);
      manifests[index] = metadataUpdate.manifest;
      changedWorkIds.add(metadataUpdate.manifest.workId);
      for (const asset of metadataUpdate.manifest.assets) {
        if (asset?.sourceFilename) {
          assetByFilename.set(asset.sourceFilename, {
            manifest: metadataUpdate.manifest,
            asset,
          });
        }
      }
    }
  }

  for (const manifest of manifests) {
    if (manifest.recordState === 'merged') continue;
    for (const asset of manifest.assets) {
      if (
        asset.availability !== 'removed'
        && asset.availability !== 'trashed'
        && !availableSources.has(asset.sourceFilename)
        && asset.availability !== 'missing'
      ) {
        asset.availability = 'missing';
        asset.updatedAt = isoNow(now);
        manifest.updatedAt = asset.updatedAt;
        changedWorkIds.add(manifest.workId);
      }
    }
  }

  const catalogResult = rebuildCatalog(manifests, existingCatalog, now);
  return {
    manifests,
    catalog: catalogResult.catalog,
    changedManifests: manifests.filter((manifest) => changedWorkIds.has(manifest.workId)),
    catalogChanged: catalogResult.changed,
  };
}

export function workForFilename(catalog, filename) {
  const workId = catalog?.aliases?.sourceFilenames?.[filename];
  if (!workId) return null;
  return catalog.works.find((work) => work.workId === workId) || null;
}

export function semanticManifestPath(workId) {
  return manifestPath(workId);
}

export function semanticAnnotationsPath(workId) {
  return SEMANTIC_ANNOTATIONS_PREFIX + workId + '.json';
}

export function mergePortableAnnotationRecords(
  primaryRecord,
  secondaryRecord,
  primaryWorkId,
  now = () => new Date().toISOString(),
) {
  const valid = (record) => (
    record
    && record.schemaVersion === SEMANTIC_SCHEMA_VERSION
    && record.recordType === ANNOTATIONS_TYPE
    && Array.isArray(record.annotations)
  );
  const base = valid(primaryRecord) ? cloneJson(primaryRecord) : {
    schemaVersion:SEMANTIC_SCHEMA_VERSION,
    recordType:ANNOTATIONS_TYPE,
    workId:primaryWorkId,
    revision:0,
    annotations:[],
    positions:[],
    preferences:[],
    legacy:{ bookIds:[] },
  };
  if (!valid(secondaryRecord)) {
    return { record:base, changed:false };
  }
  const mergeBy = (left, right, identity) => {
    const rows = new Map();
    for (const item of left || []) {
      const key = identity(item);
      if (key) rows.set(key, cloneJson(item));
    }
    for (const item of right || []) {
      const key = identity(item);
      if (key && !rows.has(key)) rows.set(key, cloneJson(item));
    }
    return Array.from(rows.values()).sort((a, b) =>
      String(identity(a)).localeCompare(String(identity(b))));
  };
  const next = cloneJson(base);
  next.workId = primaryWorkId;
  next.annotations = mergeBy(
    base.annotations,
    secondaryRecord.annotations,
    (item) => item?.annotationId,
  );
  next.positions = mergeBy(
    base.positions,
    secondaryRecord.positions,
    (item) => item?.positionId || item?.assetId,
  );
  next.preferences = mergeBy(
    base.preferences,
    secondaryRecord.preferences,
    (item) => item?.assetId,
  );
  next.legacy = {
    ...(base.legacy || {}),
    bookIds:unionStrings(
      base.legacy?.bookIds,
      secondaryRecord.legacy?.bookIds,
    ),
    groupedAnnotationWorkIds:unionStrings(
      base.legacy?.groupedAnnotationWorkIds,
      [secondaryRecord.workId],
    ),
  };
  const payloadBefore = {
    annotations:base.annotations || [],
    positions:base.positions || [],
    preferences:base.preferences || [],
    legacy:base.legacy || {},
    workId:base.workId,
  };
  const payloadAfter = {
    annotations:next.annotations,
    positions:next.positions,
    preferences:next.preferences,
    legacy:next.legacy,
    workId:next.workId,
  };
  if (jsonEqual(payloadBefore, payloadAfter)) {
    return { record:base, changed:false };
  }
  next.revision = Math.max(
    Number(base.revision) || 0,
    Number(secondaryRecord.revision) || 0,
  ) + 1;
  next.updatedAt = isoNow(now);
  return { record:next, changed:true };
}

export function splitPortableAnnotationRecords(
  groupedRecord,
  secondaryRecord,
  {
    primaryWorkId,
    secondaryWorkId,
    secondaryAssetIds = [],
    secondarySourceFilenames = [],
  },
  now = () => new Date().toISOString(),
) {
  if (!groupedRecord || groupedRecord.recordType !== ANNOTATIONS_TYPE) {
    return {
      primaryRecord:groupedRecord,
      secondaryRecord:secondaryRecord || null,
      changed:false,
    };
  }
  const assetIds = new Set(secondaryAssetIds);
  const filenames = new Set(secondarySourceFilenames);
  const belongsToSecondary = (item) => (
    assetIds.has(item?.assetId)
    || assetIds.has(item?.target?.assetId)
    || filenames.has(item?.target?.sourceFilename)
  );
  const movedAnnotations = (groupedRecord.annotations || []).filter(
    belongsToSecondary,
  );
  const movedPositions = (groupedRecord.positions || []).filter(
    belongsToSecondary,
  );
  const movedPreferences = (groupedRecord.preferences || []).filter(
    belongsToSecondary,
  );
  const timestamp = isoNow(now);
  const primary = cloneJson(groupedRecord);
  primary.workId = primaryWorkId;
  primary.annotations = (primary.annotations || []).filter(
    (item) => !belongsToSecondary(item),
  );
  primary.positions = (primary.positions || []).filter(
    (item) => !belongsToSecondary(item),
  );
  primary.preferences = (primary.preferences || []).filter(
    (item) => !belongsToSecondary(item),
  );
  primary.legacy = {
    ...(primary.legacy || {}),
    groupedAnnotationWorkIds:(primary.legacy?.groupedAnnotationWorkIds || [])
      .filter((workId) => workId !== secondaryWorkId),
  };
  primary.revision = Math.max(0, Number(primary.revision) || 0) + 1;
  primary.updatedAt = timestamp;

  const secondary = (
    secondaryRecord
    && secondaryRecord.recordType === ANNOTATIONS_TYPE
  ) ? cloneJson(secondaryRecord) : {
    schemaVersion:SEMANTIC_SCHEMA_VERSION,
    recordType:ANNOTATIONS_TYPE,
    revision:0,
    annotations:[],
    positions:[],
    preferences:[],
    legacy:{ bookIds:[] },
  };
  secondary.workId = secondaryWorkId;
  const overlay = (base, moved, identity) => {
    const rows = new Map(
      (base || []).map((item) => [identity(item), cloneJson(item)]),
    );
    for (const item of moved) rows.set(identity(item), cloneJson(item));
    return Array.from(rows.values()).filter(
      (item) => belongsToSecondary(item),
    ).sort((a, b) =>
      String(identity(a)).localeCompare(String(identity(b))));
  };
  secondary.annotations = overlay(
    secondary.annotations,
    movedAnnotations,
    (item) => item?.annotationId,
  );
  secondary.positions = overlay(
    secondary.positions,
    movedPositions,
    (item) => item?.positionId || item?.assetId,
  );
  secondary.preferences = overlay(
    secondary.preferences,
    movedPreferences,
    (item) => item?.assetId,
  );
  secondary.revision = Math.max(0, Number(secondary.revision) || 0) + 1;
  secondary.updatedAt = timestamp;
  return {
    primaryRecord:primary,
    secondaryRecord:secondary,
    changed:Boolean(
      movedAnnotations.length
      || movedPositions.length
      || movedPreferences.length
      || groupedRecord.legacy?.groupedAnnotationWorkIds?.includes(
        secondaryWorkId,
      )
    ),
  };
}

export function addPortableAnnotation(
  record,
  {
    workId,
    kind = 'highlight',
    label = '',
    body = '',
    color = 'yellow',
    target,
    conceptIds = [],
  },
  now = () => new Date().toISOString(),
  createId = createRecordId,
) {
  if (!workId || !target) throw new Error('A work and target are required for an annotation.');
  const timestamp = isoNow(now);
  const base = (
    record
    && record.schemaVersion === SEMANTIC_SCHEMA_VERSION
    && record.recordType === ANNOTATIONS_TYPE
    && record.workId === workId
  ) ? cloneJson(record) : {
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    recordType: ANNOTATIONS_TYPE,
    workId,
    revision: 0,
    annotations: [],
    positions: [],
    preferences: [],
    legacy: { bookIds: [] },
  };
  const annotation = {
    annotationId: createId('annotation'),
    kind,
    label:String(label || ''),
    body:String(body || ''),
    color:String(color || 'yellow'),
    target:cloneJson(target),
    conceptIds:Array.from(new Set(conceptIds.filter(Boolean))),
    createdAt:timestamp,
    updatedAt:timestamp,
    deletedAt:null,
  };
  base.annotations.push(annotation);
  base.revision = Math.max(0, Number(base.revision) || 0) + 1;
  base.updatedAt = timestamp;
  return { record:base, annotation };
}

export function updatePortableAnnotation(
  record,
  annotationId,
  changes,
  now = () => new Date().toISOString(),
) {
  if (!record?.annotations) return { record, changed:false };
  const next = cloneJson(record);
  const annotation = next.annotations.find((item) => item.annotationId === annotationId);
  if (!annotation) return { record, changed:false };
  const allowed = ['label', 'body', 'color', 'conceptIds'];
  let changed = false;
  for (const key of allowed) {
    if (!(key in changes)) continue;
    const value = key === 'conceptIds'
      ? Array.from(new Set((changes[key] || []).filter(Boolean)))
      : String(changes[key] ?? '');
    if (!jsonEqual(annotation[key], value)) {
      annotation[key] = value;
      changed = true;
    }
  }
  if (!changed) return { record, changed:false };
  annotation.updatedAt = isoNow(now);
  next.revision = Math.max(0, Number(next.revision) || 0) + 1;
  next.updatedAt = annotation.updatedAt;
  return { record:next, changed:true };
}

export function tombstonePortableAnnotation(
  record,
  annotationId,
  now = () => new Date().toISOString(),
) {
  if (!record?.annotations) return { record, changed:false };
  const next = cloneJson(record);
  const annotation = next.annotations.find((item) => item.annotationId === annotationId);
  if (!annotation || annotation.deletedAt) return { record, changed:false };
  const timestamp = isoNow(now);
  annotation.deletedAt = timestamp;
  annotation.updatedAt = timestamp;
  next.revision = Math.max(0, Number(next.revision) || 0) + 1;
  next.updatedAt = timestamp;
  return { record:next, changed:true };
}

function normalizeAnchorText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

export function reanchorPortableAnnotations(
  record,
  passages,
  now = () => new Date().toISOString(),
) {
  if (!record?.annotations || !Array.isArray(passages)) {
    return { record, changed:false, unresolved:[] };
  }
  const next = cloneJson(record);
  let changed = false;
  const unresolved = [];
  const passageById = new Map(passages.map((passage) => [passage.passageId, passage]));
  for (const annotation of next.annotations) {
    if (annotation.deletedAt || annotation.kind !== 'highlight' || !annotation.target?.exact) {
      continue;
    }
    const needle = normalizeAnchorText(annotation.target.exact);
    const current = passageById.get(annotation.target.passageId);
    if (current && normalizeAnchorText(current.text).includes(needle)) {
      if (annotation.anchorState !== 'resolved') {
        annotation.anchorState = 'resolved';
        changed = true;
      }
      continue;
    }
    const candidates = passages.filter((passage) =>
      normalizeAnchorText(passage.text).includes(needle));
    if (candidates.length === 1) {
      const previousPassageId = annotation.target.passageId || null;
      annotation.target.passageId = candidates[0].passageId;
      annotation.target.passageQuoteHash = candidates[0].anchor?.quoteHash || null;
      annotation.anchorState = 'resolved';
      annotation.anchorHistory = (annotation.anchorHistory || []).concat([{
        previousPassageId,
        passageId:candidates[0].passageId,
        reanchoredAt:isoNow(now),
      }]);
      annotation.updatedAt = annotation.anchorHistory.at(-1).reanchoredAt;
      changed = true;
    } else {
      if (annotation.anchorState !== 'unresolved') {
        annotation.anchorState = 'unresolved';
        annotation.updatedAt = isoNow(now);
        changed = true;
      }
      unresolved.push(annotation.annotationId);
    }
  }
  if (!changed) return { record, changed:false, unresolved };
  next.revision = Math.max(0, Number(next.revision) || 0) + 1;
  next.updatedAt = isoNow(now);
  return { record:next, changed:true, unresolved };
}

function legacySourceKey(bookId, kind, sourceId) {
  return [bookId, kind, sourceId || 'default'].join(':');
}

function portableTarget(asset, engine, position) {
  return {
    assetId: asset?.assetId || null,
    sourceFilename: asset?.sourceFilename || null,
    selectors: [{
      type: 'legacy-engine-position',
      engine: engine || asset?.format || null,
      value: cloneJson(position || {}),
    }],
  };
}

function upsertLegacyRecord({
  existingByKey,
  key,
  kind,
  createId,
  createdAt,
  bookId,
  fields,
}) {
  const existing = existingByKey.get(key);
  return {
    ...(existing || {}),
    annotationId: existing?.annotationId || createId('annotation'),
    kind,
    ...fields,
    legacySource: { key, bookId },
    createdAt: existing?.createdAt || createdAt,
    updatedAt: fields.updatedAt || existing?.updatedAt || createdAt,
  };
}

export function reconcileLegacyAnnotations({
  manifest,
  sidecars = [],
  existingRecord = null,
  now = () => new Date().toISOString(),
  createId = createRecordId,
} = {}) {
  if (!manifest?.workId) {
    throw new Error('A valid work manifest is required to migrate annotations.');
  }
  const existing = (
    existingRecord
    && existingRecord.schemaVersion === SEMANTIC_SCHEMA_VERSION
    && existingRecord.recordType === ANNOTATIONS_TYPE
    && existingRecord.workId === manifest.workId
  ) ? cloneJson(existingRecord) : null;
  const existingLegacy = new Map(
    (existing?.annotations || [])
      .filter((record) => record?.legacySource?.key)
      .map((record) => [record.legacySource.key, record]),
  );
  const incomingBookIds = new Set(
    sidecars
      .filter((sidecar) => sidecar?.sourceFilename)
      .map((sidecar) => sidecar.bookId || legacyBookIdFor(sidecar.sourceFilename)),
  );
  const untouchedAnnotations = (existing?.annotations || [])
    .filter((record) => (
      !record?.legacySource?.key
      || !incomingBookIds.has(record.legacySource.bookId)
    ));
  const untouchedPositions = (existing?.positions || [])
    .filter((record) => !incomingBookIds.has(record?.legacySource?.bookId));
  const untouchedPreferences = (existing?.preferences || [])
    .filter((record) => !incomingBookIds.has(record?.legacySource?.bookId));
  const migrated = [];
  const positions = [];
  const preferences = [];
  const migrationTime = isoNow(now);

  for (const sidecar of sidecars) {
    if (!sidecar || typeof sidecar.sourceFilename !== 'string') continue;
    const asset = manifest.assets.find(
      (candidate) => candidate.sourceFilename === sidecar.sourceFilename,
    );
    if (!asset) continue;
    const bookId = sidecar.bookId || legacyBookIdFor(sidecar.sourceFilename);
    const engine = sidecar.engine || asset.format || null;

    if (sidecar.position && typeof sidecar.position === 'object') {
      positions.push({
        positionId: 'position_' + asset.assetId,
        assetId: asset.assetId,
        target: portableTarget(asset, engine, sidecar.position),
        lastOpened: sidecar.lastOpened || null,
        legacySource: {
          key: legacySourceKey(bookId, 'position', asset.assetId),
          bookId,
        },
      });
    }

    if (sidecar.readerPrefs && typeof sidecar.readerPrefs === 'object') {
      preferences.push({
        assetId: asset.assetId,
        values: cloneJson(sidecar.readerPrefs),
        legacySource: {
          key: legacySourceKey(bookId, 'preferences', asset.assetId),
          bookId,
        },
      });
    }

    const bookmarks = Array.isArray(sidecar.bookmarks) ? sidecar.bookmarks : [];
    for (let index = 0; index < bookmarks.length; index++) {
      const bookmark = bookmarks[index] || {};
      const sourceId = bookmark.id || String(index);
      const key = legacySourceKey(bookId, 'bookmark', sourceId);
      migrated.push(upsertLegacyRecord({
        existingByKey: existingLegacy,
        key,
        kind: 'bookmark',
        createId,
        createdAt: bookmark.ts || migrationTime,
        bookId,
        fields: {
          label: typeof bookmark.label === 'string' ? bookmark.label : '',
          body: '',
          target: portableTarget(asset, engine, bookmark.position),
          updatedAt: bookmark.ts || migrationTime,
        },
      }));
    }

    if (typeof sidecar.note === 'string' && sidecar.note.trim()) {
      const key = legacySourceKey(bookId, 'book-note', asset.assetId);
      migrated.push(upsertLegacyRecord({
        existingByKey: existingLegacy,
        key,
        kind: 'note',
        createId,
        createdAt: migrationTime,
        bookId,
        fields: {
          label: 'Book note',
          body: sidecar.note,
          target: {
            assetId: asset.assetId,
            sourceFilename: asset.sourceFilename,
            selectors: [{ type: 'whole-work' }],
          },
        },
      }));
    }
  }

  const annotations = untouchedAnnotations
    .concat(migrated)
    .sort((left, right) => left.annotationId.localeCompare(right.annotationId));
  positions.push(...untouchedPositions);
  preferences.push(...untouchedPreferences);
  positions.sort((left, right) => left.assetId.localeCompare(right.assetId));
  preferences.sort((left, right) => left.assetId.localeCompare(right.assetId));
  const payload = {
    annotations,
    positions,
    preferences,
    legacy: {
      bookIds: Array.from(new Set(
        (existing?.legacy?.bookIds || []).concat(
          sidecars
            .filter((sidecar) => sidecar?.sourceFilename)
            .map((sidecar) => sidecar.bookId || legacyBookIdFor(sidecar.sourceFilename)),
        ),
      )).sort(),
    },
  };
  const existingPayload = existing && {
    annotations: existing.annotations || [],
    positions: existing.positions || [],
    preferences: existing.preferences || [],
    legacy: existing.legacy || { bookIds: [] },
  };
  if (existing && jsonEqual(existingPayload, payload)) {
    return { record: existing, changed: false };
  }
  return {
    record: {
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      recordType: ANNOTATIONS_TYPE,
      workId: manifest.workId,
      revision: Math.max(0, Number(existing?.revision) || 0) + 1,
      ...payload,
      updatedAt: migrationTime,
    },
    changed: true,
  };
}

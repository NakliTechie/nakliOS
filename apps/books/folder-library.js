export const FOLDER_LIBRARY_SCHEMA_VERSION = 1;
export const FOLDER_INVENTORY_SCHEMA_VERSION = 1;
export const FOLDER_SIDECAR_DIRECTORY = '.books';

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  FOLDER_SIDECAR_DIRECTORY,
  '.git',
  '.hg',
  '.svn',
  'node_modules',
]);

export function normaliseFolderRelativePath(input) {
  const value = String(input || '')
    .normalize('NFC')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
  if (
    !value
    || value.includes('\0')
    || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Invalid folder-library relative path');
  }
  return value;
}

export function folderPathCollisionKey(input) {
  return normaliseFolderRelativePath(input).toLowerCase();
}

export function detectFolderPathCollisions(records = []) {
  const pathsByKey = new Map();
  for (const record of records || []) {
    const relativePath = normaliseFolderRelativePath(
      record?.relativePath ?? record,
    );
    const collisionKey = folderPathCollisionKey(relativePath);
    const paths = pathsByKey.get(collisionKey) || new Set();
    paths.add(relativePath);
    pathsByKey.set(collisionKey, paths);
  }
  return Array.from(pathsByKey, ([collisionKey, paths]) => ({
    collisionKey,
    paths:Array.from(paths).sort(),
  }))
    .filter((collision) => collision.paths.length > 1)
    .sort((left, right) => left.collisionKey.localeCompare(right.collisionKey));
}

export function shouldSkipFolderEntry({
  name,
  relativePath = '',
  kind,
  excludedDirectories = DEFAULT_EXCLUDED_DIRECTORIES,
  includeHidden = false,
} = {}) {
  const entryName = String(name || '');
  if (!entryName) return true;
  if (
    kind === 'directory'
    && (
      excludedDirectories.has(entryName)
      || (!includeHidden && entryName.startsWith('.'))
    )
  ) return true;
  if (!includeHidden && kind === 'file' && entryName.startsWith('.')) return true;
  const path = String(relativePath || '').replace(/\\/g, '/');
  return path === FOLDER_SIDECAR_DIRECTORY
    || path.startsWith(FOLDER_SIDECAR_DIRECTORY + '/');
}

export function makeFolderLibraryManifest({
  libraryId,
  rootName,
  now = () => new Date().toISOString(),
} = {}) {
  if (!libraryId) throw new Error('Folder library requires a stable libraryId');
  const timestamp = now();
  return {
    schemaVersion:FOLDER_LIBRARY_SCHEMA_VERSION,
    recordType:'books.folder-library',
    libraryId:String(libraryId),
    rootName:String(rootName || 'Lorewell'),
    sidecarDirectory:FOLDER_SIDECAR_DIRECTORY,
    sourcePolicy:'read-in-place',
    canonicalMetadata:'sidecar',
    createdAt:timestamp,
    updatedAt:timestamp,
  };
}

export function folderInventorySignature(record) {
  return [
    normaliseFolderRelativePath(record.relativePath),
    String(record.kind || 'file'),
    Number(record.byteLength) || 0,
    Number(record.lastModified) || 0,
  ].join('|');
}

export function makeFolderInventoryRecord({
  relativePath,
  byteLength,
  lastModified,
  format,
  mediaType = null,
  fingerprint = null,
  fingerprintStatus = 'pending',
  lastSeenGeneration = 0,
} = {}) {
  return {
    relativePath:normaliseFolderRelativePath(relativePath),
    kind:'file',
    format:String(format || '').toLowerCase(),
    mediaType:mediaType ? String(mediaType) : null,
    byteLength:Math.max(0, Number(byteLength) || 0),
    lastModified:Math.max(0, Number(lastModified) || 0),
    fingerprint:fingerprint ? String(fingerprint) : null,
    fingerprintStatus:fingerprint ? 'complete' : String(fingerprintStatus || 'pending'),
    lastSeenGeneration:Math.max(0, Number(lastSeenGeneration) || 0),
  };
}

export function reconcileFolderInventory({
  previous = null,
  observed = [],
  generation,
  now = () => new Date().toISOString(),
} = {}) {
  const nextGeneration = Math.max(
    1,
    Number(generation)
      || ((Number(previous?.generation) || 0) + 1),
  );
  const priorByPath = new Map(
    (previous?.files || []).map((record) => [
      normaliseFolderRelativePath(record.relativePath),
      record,
    ]),
  );
  const priorMissingByPath = new Map(
    (previous?.missing || []).map((record) => [
      normaliseFolderRelativePath(record.relativePath),
      record,
    ]),
  );
  const seen = new Set();
  const files = [];
  const added = [];
  const changed = [];
  const unchanged = [];
  const normalizedObserved = observed.map((raw) => makeFolderInventoryRecord({
    ...raw,
    lastSeenGeneration:nextGeneration,
  }));
  const collisions = detectFolderPathCollisions(normalizedObserved);

  for (const current of normalizedObserved) {
    if (seen.has(current.relativePath)) continue;
    seen.add(current.relativePath);
    const prior = priorByPath.get(current.relativePath);
    if (!prior) {
      files.push(current);
      added.push(current.relativePath);
      continue;
    }
    if (folderInventorySignature(prior) === folderInventorySignature(current)) {
      const stable = {
        ...current,
        fingerprint:prior.fingerprint || null,
        fingerprintStatus:prior.fingerprint
          ? 'complete'
          : (prior.fingerprintStatus || 'pending'),
      };
      files.push(stable);
      unchanged.push(current.relativePath);
      continue;
    }
    files.push({
      ...current,
      previousFingerprint:prior.fingerprint || null,
      fingerprint:null,
      fingerprintStatus:'pending',
    });
    changed.push(current.relativePath);
  }

  const missing = [];
  for (const [relativePath, prior] of priorByPath) {
    if (seen.has(relativePath)) continue;
    missing.push({
      relativePath,
      fingerprint:prior.fingerprint || null,
      firstMissingGeneration:prior.firstMissingGeneration || nextGeneration,
      lastSeenGeneration:Number(prior.lastSeenGeneration) || 0,
    });
  }
  for (const [relativePath, prior] of priorMissingByPath) {
    if (
      seen.has(relativePath)
      || missing.some((record) => record.relativePath === relativePath)
    ) continue;
    missing.push({
      relativePath,
      fingerprint:prior.fingerprint || null,
      firstMissingGeneration:
        prior.firstMissingGeneration || nextGeneration,
      lastSeenGeneration:Number(prior.lastSeenGeneration) || 0,
    });
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  missing.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const scannedAt = now();
  return {
    inventory:{
      schemaVersion:FOLDER_INVENTORY_SCHEMA_VERSION,
      recordType:'books.folder-inventory',
      generation:nextGeneration,
      scannedAt,
      completed:true,
      files,
      missing,
      collisions,
      counts:{
        total:files.length,
        added:added.length,
        changed:changed.length,
        unchanged:unchanged.length,
        missing:missing.length,
        collisions:collisions.length,
      },
    },
    diff:{ added, changed, unchanged, missing },
  };
}

export function renameCandidates({ inventory, fingerprints = new Map() } = {}) {
  const missingByFingerprint = new Map();
  for (const record of inventory?.missing || []) {
    if (!record.fingerprint) continue;
    const rows = missingByFingerprint.get(record.fingerprint) || [];
    rows.push(record.relativePath);
    missingByFingerprint.set(record.fingerprint, rows);
  }
  const candidates = [];
  for (const record of inventory?.files || []) {
    const fingerprint = record.fingerprint
      || fingerprints.get(record.relativePath)
      || null;
    if (!fingerprint) continue;
    for (const previousPath of missingByFingerprint.get(fingerprint) || []) {
      candidates.push({
        fingerprint,
        previousPath,
        currentPath:record.relativePath,
      });
    }
  }
  return candidates.sort((left, right) =>
    left.previousPath.localeCompare(right.previousPath)
      || left.currentPath.localeCompare(right.currentPath));
}

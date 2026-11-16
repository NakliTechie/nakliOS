// Batch rename and find-and-replace in tags (parity row T5).
//
// Both are planning functions: they take the selected track records and
// return what would change, so the confirm dialog can show every row before
// anything is written. Tag patches go to `saveTagsToHandle` in
// app/tags/save.mjs; file renames go to `renameOnDisk` below.
//
// Pure except `renameOnDisk`, which calls the File System Access API.

export const RENAME_TOKENS = Object.freeze(['artist', 'album', 'albumartist', 'title', 'track', 'disc', 'year', 'genre']);

/** Tag fields find-and-replace may change: the text fields the tag writer accepts. */
export const REPLACE_FIELDS = Object.freeze(['title', 'artist', 'album', 'albumArtist', 'genre']);

export class RenameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RenameError';
    this.code = code;
  }
}

// Characters Windows, macOS or Linux refuse in a file name, plus controls.
// oxlint-disable-next-line no-control-regex -- matches C0 controls and DEL on purpose: filesystems reject them in names
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_NAME_BYTES = 255;

/**
 * Make text safe as one file name on every common filesystem: illegal
 * characters become `_`, trailing dots and spaces go (Windows drops them),
 * reserved device names get a leading `_`, and the name is cut to 255 UTF-8
 * bytes without splitting a character.
 */
export function sanitiseFileName(name) {
  let out = String(name ?? '').replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (RESERVED.test(out)) out = `_${out}`;
  const encoder = new TextEncoder();
  while (encoder.encode(out).length > MAX_NAME_BYTES) out = [...out].slice(0, -1).join('');
  return out;
}

const pad = (value, width) => String(value).padStart(width, '0');

const finiteText = value => (Number.isFinite(value) ? String(value) : '');

/** Each rename token and how it reads from a library record. */
const TOKEN_VALUES = {
  artist: record => record.artist ?? '',
  album: record => record.album ?? '',
  albumartist: record => record.albumArtist ?? record.artist ?? '',
  title: record => record.title ?? '',
  track: record => (Number.isFinite(record.trackNo) ? pad(record.trackNo, Math.max(2, String(record.trackTotal ?? '').length)) : ''),
  disc: record => finiteText(record.discNo),
  year: record => finiteText(record.year),
  genre: record => record.genre ?? '',
};

function tokenValue(token, record) {
  return Object.hasOwn(TOKEN_VALUES, token) ? TOKEN_VALUES[token](record) : null;
}

/**
 * Check a rename pattern: it must use at least one token, and every `%name%`
 * must be a known token. Throws RenameError naming the first unknown token.
 */
export function validatePattern(pattern) {
  const text = String(pattern ?? '');
  const used = [...text.matchAll(/%([a-z]+)%/gi)].map(match => match[1].toLowerCase());
  if (!used.length) throw new RenameError('ERR_NAKLIAMP_RENAME_PATTERN', 'The pattern uses no token such as %title%.');
  const unknown = used.find(token => !RENAME_TOKENS.includes(token));
  if (unknown) throw new RenameError('ERR_NAKLIAMP_RENAME_PATTERN', `Unknown token %${unknown}% in the pattern.`);
  return used;
}

/**
 * The base name (no extension) a pattern gives for one record. Tokens with no
 * value become empty, then separators left dangling at either end or doubled
 * in the middle are tidied: "%artist% - %title%" with no artist gives "Title".
 * Token values are sanitised before they are joined, so a "/" in a title
 * never creates a folder.
 */
export function formatName(pattern, record) {
  validatePattern(pattern);
  // Odd indices are tokens, even ones the literal text between them.
  const parts = String(pattern).split(/(%[a-z]+%)/i);
  const values = parts.map((part, index) => (index % 2
    ? String(tokenValue(part.slice(1, -1).toLowerCase(), record)).replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim()
    : part));
  const separatorOnly = text => /^[\s\-_.,]*$/.test(text);
  // An empty token takes its separator with it: the one before it, or the
  // one after it when nothing non-empty came before.
  let seenValue = false;
  for (let index = 1; index < parts.length; index += 2) {
    if (values[index]) { seenValue = true; continue; }
    if (seenValue && separatorOnly(values[index - 1])) values[index - 1] = '';
    else if (!seenValue && separatorOnly(values[index + 1] ?? '')) values[index + 1] = '';
  }
  return sanitiseFileName(values.join('').replace(/^[\s\-_.,]+|[\s\-_,]+$/g, ''));
}

const dirOf = path => String(path).split('/').slice(0, -1).join('/');
const baseOf = path => String(path).split('/').pop();
const extensionOf = name => (/(\.[^.]+)$/.exec(name)?.[1] ?? '');

/**
 * Plan a batch rename. Returns one row per record:
 * `{ id, path, from, to, status }` where `status` is
 * - `rename`: will be renamed from `from` to `to`;
 * - `same`: the name already matches;
 * - `empty`: the pattern gives no name for this record (no tags);
 * - `virtual`: a cue-sheet track, which is part of another file;
 * - `conflict`: another file in the same folder has or would get this name
 *   (case-insensitive, as macOS and Windows compare names).
 * The extension is always kept.
 */
export function planRename(records, pattern) {
  validatePattern(pattern);
  const rows = records.map(record => {
    const from = baseOf(record.path);
    if (record.virtual) return { id: record.id, path: record.path, from, to: from, status: 'virtual' };
    const stem = formatName(pattern, record);
    if (!stem) return { id: record.id, path: record.path, from, to: from, status: 'empty' };
    const to = sanitiseFileName(`${stem}${extensionOf(from)}`);
    return { id: record.id, path: record.path, from, to, status: to === from ? 'same' : 'rename' };
  });

  // Names that stay in each folder: files not renamed keep theirs.
  const key = row => `${dirOf(row.path)}/${row.to.toLowerCase()}`;
  const counts = new Map();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  for (const row of rows) if (row.status === 'rename' && counts.get(key(row)) > 1) row.status = 'conflict';
  return rows;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Plan find-and-replace over tag fields.
 * Options: `{ find, replace = '', fields = REPLACE_FIELDS, regex = false,
 * caseSensitive = false }`. With `regex`, `replace` may use `$1` groups.
 * Returns `[{ id, patch, before }]` for records that change only: `patch`
 * holds the new values (an empty result becomes null, clearing the field),
 * `before` the old ones, for the confirm diff.
 * Throws RenameError for an empty find, a bad regex or an unknown field.
 */
function findReplaceError(message) {
  return new RenameError('ERR_NAKLIAMP_REPLACE_INVALID', message);
}

function compileFind(find, regex, caseSensitive) {
  try {
    return new RegExp(regex ? find : escapeRegExp(find), caseSensitive ? 'gu' : 'giu');
  } catch (error) {
    throw findReplaceError(`The search pattern is not a valid regular expression: ${error.message}`);
  }
}

/** Apply the replacement to one record; returns `{ patch, before }` for changed fields. */
function replaceInRecord(record, fields, pattern, replacement) {
  const patch = {};
  const before = {};
  for (const field of fields) {
    const old = record[field];
    if (typeof old !== 'string' || !old) continue;
    pattern.lastIndex = 0;
    const next = old.replace(pattern, replacement).replace(/\s+/g, ' ').trim();
    if (next !== old) { patch[field] = next || null; before[field] = old; }
  }
  return { patch, before };
}

export function planFindReplace(records, { find, replace = '', fields = REPLACE_FIELDS, regex = false, caseSensitive = false } = {}) {
  if (typeof find !== 'string' || !find) throw findReplaceError('Nothing to find: the search text is empty.');
  const unknown = fields.find(field => !REPLACE_FIELDS.includes(field));
  if (unknown) throw findReplaceError(`Find and replace cannot change the field ${unknown}.`);
  const pattern = compileFind(find, regex, caseSensitive);
  // Plain text must insert literally: a "$" in the replacement is not a group.
  const replacement = regex ? String(replace) : () => String(replace);

  const plans = [];
  for (const record of records) {
    const { patch, before } = replaceInRecord(record, fields, pattern, replacement);
    if (Object.keys(patch).length) plans.push({ id: record.id, patch, before });
  }
  return plans;
}

/** True when this browser can rename a file through its handle. */
export function canRenameOnDisk(handle) {
  return typeof handle?.move === 'function';
}

/**
 * Rename a file on disk through its FileSystemFileHandle. Uses
 * `handle.move(newName)` (Chromium only). Refuses, by name:
 * - a browser without `move` (`ERR_NAKLIAMP_RENAME_UNSUPPORTED`);
 * - a name that is not already safe (`ERR_NAKLIAMP_RENAME_INVALID`);
 * - a name another file in `parent` already has, when `parent` (the file's
 *   directory handle) is given (`ERR_NAKLIAMP_RENAME_EXISTS`).
 * Returns the new name. The caller rescans, so the index follows the file.
 */
export async function renameOnDisk(handle, newName, { parent = null } = {}) {
  if (!canRenameOnDisk(handle)) {
    throw new RenameError('ERR_NAKLIAMP_RENAME_UNSUPPORTED',
      'This browser cannot rename files. Renaming needs a Chromium browser, such as Chrome or Edge.');
  }
  if (!newName || sanitiseFileName(newName) !== newName) {
    throw new RenameError('ERR_NAKLIAMP_RENAME_INVALID', `Not a safe file name: ${newName}`);
  }
  if (handle.name === newName) return newName;
  if (parent && handle.name?.toLowerCase() !== newName.toLowerCase()) {
    let exists = false;
    try { await parent.getFileHandle(newName); exists = true; } catch { exists = false; }
    if (exists) throw new RenameError('ERR_NAKLIAMP_RENAME_EXISTS', `A file named ${newName} is already in that folder.`);
  }
  await handle.move(newName);
  return newName;
}

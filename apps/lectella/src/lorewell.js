// Lorewell (NakliOS app id `books`, the person's book library) answers read commands that Lectella calls through
// the host: search passages, read a passage, list books. Books stay in Lorewell; Lectella keeps only a reference
// (work id and location) and reads the passage when it needs it. The host asks the person once before Lectella may
// call Lorewell (nakliOS app Grants, PR #139), and records every call in History.

export const LOREWELL = 'books';

/** What each host or Lorewell code means for the person, in words they can act on. */
const ADVICE = {
  ENOGRANT: 'nResearch is not allowed to use nBooks. To allow it, open NakliOS Settings → AI, forget the nBooks decision for nResearch, and try again.',
  ENOENT: 'nBooks does not offer this yet. Update nBooks, or open it once so NakliOS learns its commands.',
  ELAUNCH: 'nBooks did not open to answer. Open nBooks once, then try again.',
  ETIMEOUT: 'nBooks did not answer in time. Try again.',
  EDENIED: 'The request to nBooks was not allowed.',
  ENOTFOUND: 'nBooks no longer has that book or passage.',
  EEMPTY: 'Your nBooks library has no books yet.',
};

export class LorewellError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(ADVICE[/** @type {keyof typeof ADVICE} */ (code)] ? `${ADVICE[/** @type {keyof typeof ADVICE} */ (code)]}${message && !ADVICE[/** @type {keyof typeof ADVICE} */ (code)].includes(message) ? ` (${message})` : ''}` : message || code);
    this.code = code;
  }
}

/** Whether this host can carry a call to Lorewell at all. @param {any} naklios */
export const lorewellReachable = (naklios) => !!(naklios?.capabilities?.hosted && typeof naklios?.experimental_commands?.call === 'function');

/**
 * Call one Lorewell command. Answers its result, or throws a LorewellError with advice for the person.
 * @param {any} naklios @param {string} name without the `books.` prefix @param {object} args
 */
export async function callLorewell(naklios, name, args) {
  if (!lorewellReachable(naklios)) throw new LorewellError('EHOST', 'nBooks is reachable only when nResearch runs inside NakliOS.');
  let out;
  try {
    out = await naklios.experimental_commands.call(`${LOREWELL}.${name}`, args);
  } catch (e) {
    const msg = String(/** @type {any} */ (e)?.message ?? e);
    const code = /^([A-Z]{4,})\b/.exec(msg)?.[1] ?? (/timeout/i.test(msg) ? 'ETIMEOUT' : 'EFAIL');
    throw new LorewellError(code, msg);
  }
  if (!out || out.ok === false) {
    // Lorewell's own errors arrive as EFAIL with its message: "No work with id …", "No passage … in …".
    const msg = String(out?.message ?? 'nBooks did not answer');
    const code = /\bNo (work|passage)\b/.test(msg) ? 'ENOTFOUND' : (/^([A-Z]{4,}):/.exec(msg)?.[1] ?? out?.code ?? 'EFAIL');
    throw new LorewellError(code, msg.replace(/^[A-Z]{4,}:\s*/, ''));
  }
  return out.result;
}

/** The citation label for a Lorewell passage: "Title, Author, Chapter 3". @param {{ title?: string, author?: string, label?: string }} p */
export const citeLabel = (p) => [p.title, p.author, p.label].filter(Boolean).join(', ');

/**
 * Lorewell's interface (Books app-commands.js): works have a `workId`, passages a `passageId`; a location carries
 * `chapter` and, for PDFs, `page`. Lectella keeps `work` = workId and `location` = passageId.
 * @typedef {{ work: string, location: string, title: string, author: string, label: string, excerpt: string }} Hit
 */

/** "Chapter 3" or "p. 41" from a Lorewell location or citation. @param {any} loc */
const whereIn = (loc) => (loc?.chapter ? String(loc.chapter) : Number.isFinite(loc?.page) ? `p. ${loc.page}` : '');

/** @param {any} naklios @param {string} query @param {number} [limit] @returns {Promise<Hit[]>} */
export async function searchLorewell(naklios, query, limit = 10) {
  const out = await callLorewell(naklios, 'library.search', { query, limit });
  return (out?.hits ?? []).map((/** @type {any} */ h) => ({
    work: String(h.workId),
    location: String(h.location?.passageId ?? ''),
    title: String(h.title ?? 'Untitled book'),
    author: (h.authors ?? []).join(', '),
    label: whereIn(h.location),
    excerpt: String(h.excerpt ?? ''),
  }));
}

/** The text of one Lorewell passage, with its neighbours when `context` > 0. @param {any} naklios @param {string} work @param {string} location */
export async function readLorewell(naklios, work, location, { chars = 4000, context = 0 } = {}) {
  const p = await callLorewell(naklios, 'passage.get', { workId: work, passageId: location, maxChars: Math.max(200, Math.min(12000, chars)), context });
  const text = [...(p?.before ?? []).map((/** @type {any} */ r) => r.text), String(p?.text ?? ''), ...(p?.after ?? []).map((/** @type {any} */ r) => r.text)].filter(Boolean).join('\n\n');
  return { text, title: String(p?.citation?.title ?? p?.title ?? ''), author: (p?.citation?.authors ?? p?.authors ?? []).join(', '), label: whereIn(p?.citation ?? p?.location) };
}

/**
 * Open Lorewell's reader at a passage. NakliOS brings Lorewell's window forward (the command declares "shows").
 * @param {any} naklios @param {string} work @param {string} location
 */
export const openInLorewell = (naklios, work, location) => callLorewell(naklios, 'reader.open', { workId: work, passageId: location });

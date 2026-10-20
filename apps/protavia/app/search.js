// Finding a target in the Protein Data Bank.
//
// The Protein Data Bank (rcsb.org) is the public archive of experimentally determined protein
// structures. Without this, you have to already know that ubiquitin is 1UBQ, which is a lot to ask
// of anyone who has not memorised four-character codes.
//
// Two of its endpoints are used, both public, both without a key, and both sending
// `access-control-allow-origin: *` so a page can call them directly:
//   - search.rcsb.org ranks entries against free text and returns identifiers only.
//   - data.rcsb.org answers one GraphQL query with the titles and sizes for a batch of them.
//
// This is a search over a public archive, so the query text goes to rcsb.org. Nothing about the
// user's own structures is sent anywhere; those are read from disk and stay in the browser.

const SEARCH_URL = 'https://search.rcsb.org/rcsbsearch/v2/query';
const DATA_URL = 'https://data.rcsb.org/graphql';

/** A four-character entry identifier, which is what the archive calls an entry: 1ubq, 7xyz. */
export function looksLikeEntryId(text) {
  return /^[0-9][0-9a-z]{3}$/i.test(text.trim());
}

async function identifiersFor(text, limit) {
  const response = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: { type: 'terminal', service: 'full_text', parameters: { value: text } },
      return_type: 'entry',
      request_options: {
        paginate: { start: 0, rows: limit },
        results_verbosity: 'minimal',
      },
    }),
  });

  // The archive answers 204 with no body when nothing matches, which is not an error.
  if (response.status === 204) return [];
  if (!response.ok) throw new Error(`rcsb.org search returned ${response.status}.`);

  const body = await response.json();
  return (body.result_set || []).map((r) => r.identifier);
}

async function detailsFor(ids) {
  if (ids.length === 0) return [];

  // `polymer_entity_count` counts distinct molecules, not chains: entry 168L is one protein
  // present five times, and reporting that as "1 chain" would contradict what the app says the
  // moment the structure is open. `deposited_polymer_entity_instance_count` is the chain count,
  // and the modelled monomer count is the residue total, both matching what this app computes.
  const query = `{entries(entry_ids:[${ids.map((i) => `"${i}"`).join(',')}]){` +
    'rcsb_id struct{title} rcsb_entry_info{' +
    'deposited_polymer_entity_instance_count deposited_modeled_polymer_monomer_count}}}';

  const response = await fetch(`${DATA_URL}?query=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error(`rcsb.org returned ${response.status} for the entry details.`);

  const body = await response.json();
  const byId = new Map();
  for (const entry of body?.data?.entries || []) {
    byId.set(entry.rcsb_id, {
      id: entry.rcsb_id,
      title: entry.struct?.title || '',
      chains: entry.rcsb_entry_info?.deposited_polymer_entity_instance_count ?? null,
      residues: entry.rcsb_entry_info?.deposited_modeled_polymer_monomer_count ?? null,
    });
  }

  // Keep the archive's ranking, and keep an entry even if its details could not be read.
  return ids.map((id) => byId.get(id) || { id, title: '', chains: null, residues: null });
}

/**
 * Search the archive by free text.
 *
 * @param {string} text what to look for, for example "lysozyme" or "insulin receptor"
 * @param {{limit?: number}} options
 * @returns {Promise<Array<{id: string, title: string, chains: number|null, residues: number|null}>>}
 */
export async function searchTargets(text, { limit = 8 } = {}) {
  const trimmed = text.trim();
  if (trimmed.length < 2) return [];
  return detailsFor(await identifiersFor(trimmed, limit));
}

/** Titles for a fixed set of entries, used for the starter targets. */
export async function describe(ids) {
  return detailsFor(ids);
}

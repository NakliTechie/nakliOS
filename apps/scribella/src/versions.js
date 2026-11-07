// Saved versions of a project: a copy of its text files with a label, under the hidden `.scribella/versions/` folder.
// Restoring first saves what is there now, so a restore can always be undone.
const FOLDER = '.scribella/versions';

export async function listVersions(store, root) {
  const path = `${root}/${FOLDER}/index.json`;
  if (!await store.exists(path)) return [];
  try { return JSON.parse(await store.read(path)); } catch (_) { return []; }
}

export async function saveVersion(store, root, texts, label, now = Date.now()) {
  const versions = await listVersions(store, root);
  const id = String(now);
  await store.write(`${root}/${FOLDER}/${id}.json`, JSON.stringify(texts));
  const entry = { id, label:label || 'Saved version', at:now, files:Object.keys(texts).length };
  await store.write(`${root}/${FOLDER}/index.json`, JSON.stringify([entry, ...versions]));
  return entry;
}

export const readVersion = async (store, root, id) => JSON.parse(await store.read(`${root}/${FOLDER}/${id}.json`));

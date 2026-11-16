// licences.mjs — the Licences screen (N27): every licence NakliAmp ships, readable in the app.
//
// LGPL-2.1 section 6 and the MPL ask for a notice a person can find. In a single-file
// build the texts sit in inert `<script type="application/vnd.nakliamp.licence">` blocks;
// this screen prints them. On the hosted page it lists the licence files beside the app and
// fetches each one from this site when the person opens it.

import { h, injectCss } from './dialog.mjs';

export const REPOSITORY = 'https://github.com/NakliTechie/nakliamp';
export const LICENCE_BLOCK_TYPE = 'application/vnd.nakliamp.licence';

/** The licence files of the hosted page, with what each covers. */
export const LICENCE_FILES = Object.freeze([
  ['nakliamp-licence', 'NakliAmp (MIT)', 'LICENSE'],
  ['reel-licence', 'Reel media engine', 'engine/LICENSE-reel.txt'],
  ['mediabunny-licence', 'Mediabunny demuxer (MPL-2.0)', 'vendor/mediabunny/LICENSE-MPL-2.0.txt'],
  ['music-metadata-licences', 'music-metadata and its dependencies', 'vendor/music-metadata/LICENSES.txt'],
  ['butterchurn-licence', 'Butterchurn visualiser (MIT)', 'vendor/butterchurn/LICENSE-MIT.txt'],
  ['butterchurn-presets-licence', 'Butterchurn presets (MIT)', 'vendor/butterchurn/LICENSE-presets-MIT.txt'],
  ['webamp-licence', 'Webamp classic skin face (MIT)', 'vendor/webamp/LICENSE-MIT.txt'],
  ['webamp-bundled-licences', 'Libraries inside the Webamp bundle', 'vendor/webamp/LICENSES-bundled.txt'],
]);

const BLOCK_TITLES = Object.freeze({
  ...Object.fromEntries(LICENCE_FILES.map(([id, title]) => [id, title])),
  'libav-lgpl-licence': 'libav.js and FFmpeg (LGPL-2.1)',
  'libav-lgpl-notice': 'libav.js corresponding source',
});

/**
 * The licences to list: `[{ id, title, text?, path? }]`. Embedded blocks (single-file
 * builds) come with their text; otherwise the hosted files come with a path to fetch.
 */
export function licenceEntries(doc = globalThis.document) {
  const blocks = [...(doc?.querySelectorAll?.(`script[type="${LICENCE_BLOCK_TYPE}"]`) ?? [])];
  if (blocks.length) return blocks.map(block => ({ id: block.id, title: BLOCK_TITLES[block.id] ?? block.id, text: block.textContent.trim() }));
  return LICENCE_FILES.map(([id, title, path]) => ({ id, title, path }));
}

const CSS = `
.nk-lic details{border-top:1px solid var(--line);padding:8px 0}
.nk-lic summary{cursor:pointer;font-weight:600}
.nk-lic pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 var(--mono,monospace);max-height:320px;overflow:auto;margin:8px 0 0;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2)}
`;

export function mountLicences(root, { fetch: fetchFn = globalThis.fetch?.bind(globalThis), base = null } = {}) {
  injectCss('licences', CSS);
  const where = base ?? root.ownerDocument?.baseURI ?? '';
  const entry = item => {
    const pre = h('pre', { tabindex: '0', textContent: item.text ?? 'Open to load this licence.' });
    const details = h('details', {}, h('summary', { textContent: item.title }), pre);
    if (item.path) {
      details.addEventListener('toggle', async () => {
        if (!details.open || pre.dataset.loaded) return;
        pre.dataset.loaded = '1';
        try {
          const res = await fetchFn(new URL(item.path, where).href);
          if (!res.ok) throw new Error(String(res.status));
          pre.textContent = (await res.text()).trim();
        } catch {
          pre.textContent = `${item.path} is not on this server. It is in the NakliAmp repository: ${REPOSITORY}/blob/main/${item.path}`;
        }
      }, { once: false });
    }
    return details;
  };
  root.append(h('div', { className: 'nk-lic' },
    h('p', { textContent: `NakliAmp is MIT licensed. It carries the libraries below under their own licences. Source: ${REPOSITORY}` }),
    licenceEntries(root.ownerDocument).map(entry)));
  return { update() {}, destroy() {} };
}

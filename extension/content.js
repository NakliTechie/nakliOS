// Tells the NakliOS desktop page that the companion extension is installed, and its id, so the page
// can call chrome.runtime.sendMessage(id, …). Runs in the top frame of naklios.dev (and the dev hosts)
// only. The id is not a secret: the extension's checks decide what a caller may do.
const announce = () => window.postMessage({ type: 'nakli-browser:extension', id: chrome.runtime.id, version: chrome.runtime.getManifest().version }, location.origin);
window.addEventListener('message', e => {
  if (e.source === window && e.data && e.data.type === 'nakli-browser:ping') announce();
});
announce();

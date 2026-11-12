// page.html: the full-tab fallback (layout C). When the person blocks third-party cookies, a site
// framed under the desktop is signed out; a site framed by an extension page that is the whole tab
// keeps its cookies. Only the extension opens this page (it is not web-accessible), so the address in
// its query is the extension's own.
import { parseSiteUrl, originPattern } from './lib.mjs';

const gate = text => { document.getElementById('gate').hidden = false; document.getElementById('gate-text').textContent = text; };
const url = parseSiteUrl(new URLSearchParams(location.search).get('u'));
if (window.top !== window) gate('This page opens only as its own tab.');
else if (!url) gate('No address.');
else {
  const ok = await chrome.permissions.contains({ origins: [originPattern(url)] });
  if (!ok) gate(`The extension has no access to ${url.hostname}. Open it from the NakliOS Browser first.`);
  else {
    const r = await chrome.runtime.sendMessage({ type: 'page:ready' });
    if (!r || !r.ok) gate(`The extension could not prepare this tab (${r ? r.error : 'no answer'}).`);
    else {
      document.title = url.hostname;
      const site = document.getElementById('site');
      site.hidden = false;
      site.src = url.href;
      // A site whose service worker answers the navigation (X does) keeps its framing headers, because
      // Chrome's header rules do not touch service-worker responses. Chrome then shows its refused-frame
      // page. Give the tab to the site itself: a normal tab is top-level, so the sign-in still holds.
      site.addEventListener('load', async () => {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: (await chrome.tabs.getCurrent()).id });
        if (frames.some(f => f.parentFrameId === 0 && f.errorOccurred)) location.replace(url.href);
      });
    }
  }
}

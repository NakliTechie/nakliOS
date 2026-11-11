// frame.html: the extension page the NakliOS desktop frames. It checks that the desktop framed it
// directly, redeems the one-time token for the site URL, asks for host permission on a click when
// needed, and frames the site. It relays location and signed-in state to the desktop, and takes
// back / forward / reload / navigate commands from it.
import { checkAncestors, parseSiteUrl } from './lib.mjs';

const DEV = chrome.runtime.getManifest().name.includes('(dev)');
const $ = id => document.getElementById(id);
const site = $('site');
let parentOrigin = null;
let sessionId = null;   // the redeemed token, used to route background messages to this frame
let current = null;     // the URL the inner frame last committed
const back = [], fwd = [];
let pending = false;    // the next commit answers our own load (it may be a redirect): replace, do not push

function showGate(text, { grant = false, url = null, note = '' } = {}) {
  site.hidden = true;
  $('gate').hidden = false;
  $('gate-text').textContent = text;
  $('grant').hidden = !grant;
  const nt = $('newtab');
  nt.hidden = !url;
  if (url) nt.href = url;
  $('gate-note').textContent = note;
}

function tell(type, data = {}) {
  if (parentOrigin) window.parent.postMessage({ type, ...data }, parentOrigin);
}

async function cookieCount(url) {
  const r = await chrome.runtime.sendMessage({ type: 'frame:cookie-count', url });
  return r && r.ok ? r.count : null;
}

function load(url, { push = true } = {}) {
  if (push && current) { back.push(current); fwd.length = 0; }
  current = url;
  pending = true;
  $('gate').hidden = true;
  site.hidden = false;
  site.src = url;
  report();
}

async function report() {
  if (!current) return;
  tell('nakli-browser:location', { url: current, canBack: back.length > 0, canForward: fwd.length > 0, cookies: await cookieCount(current) });
}

async function start() {
  const anc = checkAncestors(location.ancestorOrigins, { dev: DEV });
  if (!anc.ok) { showGate(`This page only opens inside the NakliOS desktop (${anc.reason}).`); return; }
  parentOrigin = location.ancestorOrigins[0];
  const token = new URLSearchParams(location.hash.slice(1)).get('t');
  if (!token) { showGate('No open request.'); return; }
  const r = await chrome.runtime.sendMessage({ type: 'frame:redeem', token });
  if (!r || !r.ok) { showGate(`This open request is no longer valid (${r ? r.error : 'no answer'}). Open the address again from the toolbar.`); tell('nakli-browser:error', { error: r ? r.error : 'no-answer' }); return; }
  sessionId = token;
  const url = r.url;
  if (r.granted) { load(url, { push: false }); return; }
  const host = new URL(url).hostname;
  showGate(`Open ${host} with your Chrome sign-in? Chrome asks once for this site.`, {
    grant: true, url,
    note: 'NakliOS sees only the address and whether you are signed in, never the page or your cookies.',
  });
  $('grant').onclick = async () => {
    const ok = await chrome.permissions.request({ origins: [r.pattern] });
    if (ok) load(url, { push: false });
    else showGate(`Chrome did not grant access to ${host}.`, { url });
  };
}

// Commands from the desktop window's toolbar.
window.addEventListener('message', e => {
  if (e.source !== window.parent || e.origin !== parentOrigin) return;
  const m = e.data || {};
  if (m.type === 'nakli-browser:navigate') {
    const u = parseSiteUrl(m.url);
    if (!u) return tell('nakli-browser:error', { error: 'bad-url' });
    chrome.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] }).then(granted => {
      if (granted) load(u.href);
      else tell('nakli-browser:needs-open', { url: u.href }); // a new host goes back through the desktop's open flow
    });
  } else if (m.type === 'nakli-browser:back' && back.length) {
    fwd.push(current); current = back.pop(); pending = true; site.src = current; report();
  } else if (m.type === 'nakli-browser:forward' && fwd.length) {
    back.push(current); current = fwd.pop(); pending = true; site.src = current; report();
  } else if (m.type === 'nakli-browser:open-full' && current) {
    chrome.runtime.sendMessage({ type: 'frame:open-full', url: current }).then(r => { if (!r || !r.ok) tell('nakli-browser:error', { error: r ? r.error : 'no-answer' }); });
  } else if (m.type === 'nakli-browser:reload' && current) {
    pending = true; site.src = current; report();
  }
});

// Navigations inside the site, seen by the background through webNavigation.
chrome.runtime.onMessage.addListener(m => {
  if (!m || m.sessionId !== sessionId) return;
  if (m.type === 'bg:committed') {
    if (pending) pending = false;
    else if (m.url !== current) { if (current) back.push(current); fwd.length = 0; }
    current = m.url; report();
  } else if (m.type === 'bg:signin-opened') {
    tell('nakli-browser:signin', { host: new URL(m.url).hostname });
  } else if (m.type === 'bg:signin-closed') {
    pending = true; site.src = current; report();
  }
});

start();

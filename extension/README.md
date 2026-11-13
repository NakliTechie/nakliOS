# NakliOS Browser extension

The companion extension for the NakliOS Browser window: it lets NakliOS show a site inside a desktop window for light browsing, without your sign-ins.

## Install (developer mode, until it is in the Chrome Web Store)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this `extension/` folder.
3. Open NakliOS (https://naklios.dev, or a local serve on `127.0.0.1`), then **Browser** in the Think & Research folder.
4. Type an address. The first time you open a site, the window asks once; Chrome then asks you to allow the extension for that site.

Settings → Browser in NakliOS lists the sites you allowed, with **Remove** for each.

## How it works

- The NakliOS desktop page asks the extension to open an address. The extension answers only the desktop itself: the top frame of the tab, at `/`, on `naklios.dev` (the dev build also trusts `127.0.0.1` and `localhost`).
- It gives the desktop a one-time token bound to that tab and adds Chrome session rules **for that tab only** that remove `X-Frame-Options` and `Content-Security-Policy` from framed responses that carry a framing header. Other tabs keep every site's framing protection. The rules go when the window closes, the tab closes, or the desktop reloads.
- The desktop frames `frame.html`, an extension page. It checks that the desktop framed it directly and redeems the token, then shows the site in a `credentialless` iframe: Chrome sends no cookies and gives the page throwaway storage, so you are never signed in inside the window.
- To use your account on a site, click **Open in Chrome**: the site opens in a normal tab with your usual sign-in. Version 0.1 carried sign-ins into the window; it was cut back on 2026-11-13, because signed-in pages broke inside frames (Kaggle crashed, and GitHub, Gmail and X needed a separate tab anyway).

## Privacy

Nothing leaves your browser. The extension sends no data anywhere and has no server. It never reads cookies or page content. It keeps the one-time tokens in Chrome's session storage and a list of hosts you opened (host and time, no full address, last 200) in its local storage. NakliOS records the host of each open in its History. See `PRIVACY.md`.

## Limits

- Chrome only. Other browsers open addresses in a new tab.
- Removing CSP on a framed response also removes that page's script protections inside the NakliOS tab. This is the cost of a header API that cannot edit one directive.
- Sites that need an account, or that store state between visits, work only through **Open in Chrome**.
- NakliOS apps mirrored on `naklios.dev` share the desktop's origin and can run code in it, so the sender check does not separate them from the desktop. They are first-party code; third-party apps run at an opaque origin and cannot reach the extension.

## Files

`manifest.json` (dev build) · `manifest.store.json` (store build; `node scripts/build-browser-extension.mjs <dir>` writes it out) · `background.js` · `lib.mjs` (the decisions, node-tested by `scripts/test-browser-extension*.mjs`) · `frame.html`/`frame.js` · `content.js` (tells the desktop the extension's id).

Licence: same as the nakliOS repository.

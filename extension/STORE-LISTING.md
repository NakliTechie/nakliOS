# Chrome Web Store listing (draft; publishing is the owner's step)

**Name:** NakliOS Browser

**Summary (132 characters max):** Open sites inside the NakliOS desktop with the sign-ins you already have in Chrome. Nothing leaves your browser.

**Description:**

NakliOS is a desktop that runs in a browser tab at naklios.dev. This extension adds a Browser window to it: type an address and the site opens inside the desktop, signed in with your existing Chrome session.

To let a site show inside the NakliOS window, the extension removes the site's X-Frame-Options and Content-Security-Policy headers, only inside the NakliOS tab and only while a Browser window is open. Every other tab keeps each site's framing protection.

- Host access is asked per site, the first time you open it.
- Sign-in pages that refuse frames open in a popup.
- No data leaves your browser: no server, no analytics, no cookie values read.

**Single purpose (for review):** show sites the person chooses inside the NakliOS desktop window, signed in with their existing Chrome session.

**Permission justifications:**
- `declarativeNetRequestWithHostAccess`: remove framing headers in the NakliOS tab only, for sites the person allowed.
- `webNavigation`: follow the framed site's navigations (address bar, back and forward), open sign-in pages in a popup, and remove the header rules when the NakliOS tab navigates away.
- `cookies`: count (never read) a site's cookies to show signed in or out.
- `storage`: keep one-time tokens and the list of opened hosts.
- Optional host access `https://*/*`: asked per site at first use.

**Privacy policy:** PRIVACY.md (publish its text at a public URL before submitting).

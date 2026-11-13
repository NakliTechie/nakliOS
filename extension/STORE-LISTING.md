# Chrome Web Store listing (draft; publishing is the owner's step)

**Name:** NakliOS Browser

**Summary (132 characters max):** Read sites inside the NakliOS desktop, without your sign-ins. Nothing leaves your browser.

**Description:**

NakliOS is a desktop that runs in a browser tab at naklios.dev. This extension adds a Browser window to it: type an address and the site shows inside the desktop for light browsing. It is never signed in there; Open in Chrome takes the site to a normal tab when you need your account.

To let a site show inside the NakliOS window, the extension removes the site's X-Frame-Options and Content-Security-Policy headers, only inside the NakliOS tab and only while a Browser window is open. Every other tab keeps each site's framing protection.

- Host access is asked per site, the first time you open it.
- Sites show in a credentialless frame: no cookies are sent.
- No data leaves your browser: no server, no analytics, no cookies read.

**Single purpose (for review):** show sites the person chooses inside the NakliOS desktop window, for light browsing without their sign-ins.

**Permission justifications:**
- `declarativeNetRequestWithHostAccess`: remove framing headers in the NakliOS tab only, for sites the person allowed.
- `webNavigation`: follow the framed site's navigations (address bar, back and forward) and remove the header rules when the NakliOS tab navigates away.
- `storage`: keep one-time tokens and the list of opened hosts.
- Optional host access `https://*/*`: asked per site at first use.

**Privacy policy:** PRIVACY.md (publish its text at a public URL before submitting).

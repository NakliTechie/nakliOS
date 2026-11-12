# NakliOS Browser extension: privacy

- **No data leaves your browser.** The extension makes no network request of its own and has no server or analytics.
- **Cookies:** it never reads cookie values. For the site shown in the NakliOS window it reads how many cookies Chrome holds, to show "signed in" or "signed out".
- **Pages:** it never reads page content. Sites load in their own origin inside an extension frame.
- **Stored:** one-time open tokens in Chrome's session storage (cleared when Chrome closes); the host and time of each open, last 200, in the extension's local storage. No full addresses.
- **Headers:** inside the NakliOS tab only, and only while a Browser window is open, it removes the `X-Frame-Options` and `Content-Security-Policy` headers from framed responses that carry a framing header, so the site can show in the window.
- **Permissions:** host access is asked per site, the first time you open it, and removable in NakliOS Settings → Browser or in `chrome://extensions`.

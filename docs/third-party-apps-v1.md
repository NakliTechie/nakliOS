# NakliOS third-party app manifest v1

This standard lets a person add a web app to their own NakliOS profile without
asking for a built-in catalog change. It is deliberately less privileged than
the first-party app and mirror process.

The v1 schema identifier is:

```text
https://naklios.dev/app-manifest/v1
```

## Minimal manifest

```json
{
  "schema": "https://naklios.dev/app-manifest/v1",
  "id": "com.example.my-app",
  "name": "My App",
  "version": "1.0.0",
  "url": "https://example.com/app/",
  "description": "A short, plain-language explanation.",
  "icon": "◇",
  "tags": ["tool"],
  "permissions": [],
  "display": "window"
}
```

All fields are required except `description`, `icon`, `tags`, `permissions`,
and `display`, which default to an empty value, `◇`, an empty list, an empty
list, and `window` respectively. Unknown fields are rejected in v1.

| Field | Contract |
|---|---|
| `schema` | Exact v1 schema identifier above. |
| `id` | Stable lowercase slug or reverse-domain id, at most 80 characters. |
| `name` | Human-readable name, 1–60 characters. |
| `version` | Numeric version such as `1.0.0` (pre-release suffixes allowed), at most 64 characters. |
| `url` | Absolute HTTPS app URL. HTTP is allowed only for localhost development. URL credentials are rejected. |
| `description` | Plain text, at most 240 characters. |
| `icon` | Plain text/glyph, 1–8 Unicode characters; markup is rejected. |
| `tags` | Up to 12 lowercase slugs. |
| `permissions` | Zero or more permissions listed below. |
| `display` | `window` for a NakliOS window or `tab` for the canonical browser tab. |

Keep a manifest at a stable HTTPS URL with CORS allowing `https://naklios.dev`
if you want the Update button to work. A pasted manifest can be replaced by
pasting its stable `id` again, but it has no remote update source.

## Security and identity

The reviewed logical identity combines `id` with the app URL origin. NakliOS
assigns each fresh installation a random 128-bit profile-local id for layout,
permissions, and its storage namespace. Same-origin updates retain that
installation id; an origin change receives a new one. Windowed third-party apps
always receive a sandbox without `allow-same-origin`, even if their URL happens
to share the NakliOS origin. This gives the document an opaque origin. There is
no manifest field for system-app status, a mirror URL, extra sandbox tokens, or
host-native code.

The install review names the app origin, manifest source, display mode, and
requested permissions. Changing the app origin, manifest source, or permission
set requires another explicit review. An origin change creates a new
app-storage namespace; permissions are not inherited. A permission change
revokes any earlier runtime storage grant.

Installation is profile-local. It does not sync through Folder or Crate and
does not modify the first-party catalog. Uninstall removes the registration,
layout references, and host permission decision. It never deletes data at the
app origin or under Folder/Crate.

## Permissions

v1 supports two optional permissions:

- `storage` — the app may ask for its own `apps/<installed-id>/` namespace in
  the user's currently connected NakliOS Folder or Crate. The manifest request
  does not grant access: NakliOS asks again on first use. Apps that omit this
  permission receive `naklios.capabilities.fs === false`, even when storage is
  connected.
- `inference` — the app may ask to use the shared on-device LocalMind text
  model. The manifest request does not grant access: NakliOS asks again on
  first use. The app receives streamed text only, never the worker, model
  memory, another app's prompts, host tools, files, or credentials.

Both permissions require `display:"window"` because a normal top-level tab has
no NakliOS bridge. A window manifest opens in the opaque hosted window, where
the separate first-use grants apply.

No permission grants access to another app, NakliOS state, credentials, the
parent DOM, arbitrary local files, or a same-origin execution context.

## Lifecycle, theme, storage, and inference API

For cooperative behavior, load the current SDK from NakliOS:

```html
<script src="https://naklios.dev/sdk/naklios.js"></script>
```

An app should:

1. render a useful standalone experience when the SDK is absent;
2. call `naklios.ready()` when its usable shell is visible;
3. apply `naklios.theme.current` and subscribe with
   `naklios.theme.onChange(...)`;
4. use `naklios.beforeClose(...)` for pending saves;
5. use only `naklios.fs.*` for hosted durable storage, after checking
   `naklios.capabilities.fs`;
6. keep Browser, Folder, and Crate visibly separate, with no implicit copy,
   deletion, rebind, or migration.
7. call `naklios.ai.chat.completions.create(...)` only after checking
   `naklios.capabilities.ai`, show queued/loading/generating state, provide
   cancellation, and require an explicit user action before replacing content.
   Do not ask for provider keys or assume prompts stay on-device; NakliOS owns
   provider selection and per-destination consent. Read `aiLocal` and
   `aiModelLabel` when the UI needs to describe the active boundary.
8. call `naklios.ai.images.generate(...)` only after checking
   `naklios.capabilities.aiImages`. Image generation has its own host consent
   decision. Read `aiImageLocal` and `aiImageModelLabel` before claiming that an
   image prompt or output stays on-device.

See the full [cooperative app contract](app-contract.md) for message shapes,
backend-affine filesystem operations, remote-change subscriptions, and
conflict behavior.

Because the opaque sandbox intentionally removes origin storage, a windowed
third-party app must not depend on its own cookies, localStorage, IndexedDB, or
service worker while hosted. Choose `display:"tab"` when that origin state or
an authentication flow is essential.

## Accessibility and acceptance

Before publishing a manifest, verify:

- the app has one clear page title and keyboard-reachable controls;
- focus is visible, dialogs name themselves, and Escape safely cancels;
- status/error changes use an appropriate live region;
- text and controls remain usable at 200% zoom and in a narrow window;
- reduced-motion and the supplied light/dark theme are respected;
- the standalone URL still works without NakliOS;
- the hosted app emits `ready`, handles a theme change, and completes or
  acknowledges pending save work before close;
- no-storage, no-inference, and denied-permission paths are usable and honest;
- reconnect and backend-switch flows do not silently merge locations.

For installation conformance, test that malformed/oversized manifests fail,
the review shows the effective origin and permissions, the iframe sandbox
lacks `allow-same-origin`, storage is app-scoped, origin/permission changes
re-consent, and uninstall leaves app data untouched.

## Updates

NakliOS does not auto-update personal registrations. The user clicks Update,
NakliOS fetches the remembered manifest with credentials omitted, validates it
again, and shows the same review before replacing the registration. Redirects
are rejected, responses are capped at 32 KiB, and a changed manifest `id` is
refused as an update.

Publishers should keep old app URLs functional long enough for users to review
an update. Version numbers are displayed but do not override user consent or
act as a security signature.

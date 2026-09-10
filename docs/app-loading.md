# App loading, mirrors, and launch diagnostics

NakliOS keeps standalone app repositories authoritative. Cross-origin, sandboxed
iframes are the default; a copy under `apps/<id>/` is an exceptional deployment
artifact, not a fork.

## Placement decision

Use the smallest trust level that works:

1. **Cross-origin sandbox (default):** for standalone web apps that work through
   normal browser APIs or the `naklios.*` bridge.
2. **Same-origin mirror:** only when a first-party app needs a capability that
   cannot work in the sandbox, such as a browser picker requiring same-origin
   integration. Performance alone is not a reason to remove the sandbox.
3. **System app:** only for host-critical surfaces maintained in the NakliOS
   repository, such as Files and Notes.
4. **New tab / Basic mode:** for apps that cannot safely or reliably run in an
   iframe.

**Future escape hatch.** A same-origin mirror still runs inside an iframe. If a
required capability remains broken because of the iframe browsing context
itself — including storage, filesystem, permissions, or cross-origin-isolation
constraints — vendor a reviewed snapshot into NakliOS and run it as a
host-owned app. Make this decision per app after a reproducible failure. Record
the upstream source, pinned revision, local changes, and refresh procedure so
the vendored copy does not become an untraceable fork.

## Vendoring an app: the manifest-declared mirror is the way

When placement lands on **same-origin mirror** (level 2 above), declare it in
`apps/manifest.json` and let `sync-mirrors` fetch it. Do not hand-copy files into
`apps/<id>/`: the checked-in copy is never the source, so the next scheduled sync
overwrites the edit. Three mirrors carry lock drift today for exactly that reason.

Four things the sync will not catch for you:

1. **Declare every file the app loads, not just `index.html`.** `validate-mirrors`
   compares declared files against their lock hashes, so an under-declared manifest
   is green while the mirrored app 404s on load. Walk the import graph — including
   `new URL('./worker.mjs', import.meta.url)` — and include a `LICENSE` or vendor
   notice when upstream ships one, because mirroring redistributes the app.
   *(NakliAmp, 2026-09-10: 6 files declared, 22 actually required.)*

2. **Use a relative `embedUrl` (`./apps/<id>/`).** The absolute
   `https://naklios.dev/apps/<id>/` form resolves the same in production but makes a
   LOCAL serve embed production, so the thing you are about to ship is the one thing
   you cannot test. Reading such a frame from the host throws a cross-origin
   `SecurityError` — which is how the last five absolute entries were found.

3. **Verify in the host before committing.** Serve locally with COI headers
   (`node scripts/serve-coi.mjs`), open the app through the desktop, and check: iframe
   `sandbox` is `null`, `showDirectoryPicker` is present if the app needs it, zero 4xx in
   `performance.getEntriesByType('resource')`, and no horizontal overflow at a ~978px
   window. A default NakliOS window is far narrower than a browser tab, and that gap is
   where mirrored apps break — NakliAmp had 166px of overflow and a trapped full-screen
   mode that were both invisible at full width.

4. **A private source needs `MIRROR_SYNC_TOKEN`.** The workflow's default
   `github.token` is scoped to this repo, so GitHub answers 404 — not 403 — for a private
   source and the mirror is skipped. Since 2026-09-10 that skip is annotated, reported as a
   job output the workflow fails on, and fatal under `--strict`; before then it was a
   `console.warn` on a green run, and one mirror sat stale for two weeks.

If the app was capped to `maxMode:'basic'` *because* a cross-origin iframe blocked
`showDirectoryPicker()`, lift the cap once it is mirrored — same-origin removes the block.
`scripts/test-immersive-apps.mjs` derives that rule from the manifest, so a newly mirrored
app is required to drop its cap and an unmirrored one is required to keep it.

Every mirror is declared in `apps/manifest.json`, resolved to an immutable
upstream commit in `apps/manifest.lock.json`, and hash-checked. Run:

```sh
node scripts/validate-mirrors.mjs
node scripts/audit-app-inventory.mjs
```

The second command also rejects catalog/URL drift, undeclared on-disk apps, and
extra files left in a mirrored directory. The scheduled sync workflow opens a
reviewable pull request; it never treats the checked-in copy as the source.

## Measuring launch readiness

Each open window records process-local `load`, cooperative `naklios:ready`, and
fallback-reveal timings. App Info shows these values. For repeatable inspection,
the console API returns a frozen, content-free snapshot:

```js
nakliOS.launchDiagnostics()
```

The current warning thresholds are:

- browser `load` later than 4 seconds;
- cooperative `ready` later than 8 seconds;
- skeleton fallback at 15 seconds.

These are investigation triggers, not automatic mirror criteria. Test cold loads
with the browser cache disabled and warm loads separately. A slow cross-origin
app should first reduce its critical assets, emit `naklios:ready` when usable,
and use a useful loading shell. Mirroring is considered only if a required
capability cannot otherwise work.

The immutable snapshot contains app id/name, origin plus pathname (never query
strings or fragments), sandbox state, timings, and a coarse status. It never
records credentials, document contents, or persistent user identifiers. When a
cooperative app reports ready within budget, a later browser `load` event does
not reclassify that usable launch as slow.

## Source-side automation

Source repositories may dispatch the NakliOS `Sync app mirrors` workflow after a
release. Dispatch needs a narrowly scoped repository secret. If it is absent,
the source workflow succeeds with a visible explanation and NakliOS discovers
the release through its six-hour scheduled sync. Credential and repository
permission changes are always manual stop-lines.

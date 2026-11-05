# Exact-file handoff v1

NakliOS `Open with` is an explicit, one-file capability. It is not a shared
clipboard, an implicit copy, or permission to browse another app's namespace.

## User flow

1. The user chooses **Edit in Editor** on a text or source-code file in Files.
2. NakliOS names the source app, file, backend, and write-back behavior in a
   styled confirmation dialog.
3. On approval, NakliOS opens Editor and gives that window an opaque token for
   exactly the selected path.
4. Editor reads and writes through `naklios.files.read(token)` and
   `naklios.files.write(token, data)`. It never receives Folder handles, Crate
   credentials, the source namespace, or a general filesystem path grant.

The grant is released when Editor closes. It also fails closed if the original
Folder/Crate object disconnects or is replaced; the user must reopen the file
from Files. Text handoffs are limited to 2 MB.

## App API

The source asks the host to open one of its own app-relative files:

```js
await naklios.files.openWith('editor', 'drafts/example.md');
```

The target accepts grants and uses only their opaque tokens:

```js
naklios.files.onOpen(async grant => {
  const file = await naklios.files.read(grant.token);
  // file: { data, name, path, sourceAppId, backend }
  renderEditor(file.data);

  await naklios.files.write(grant.token, editedText);
  naklios.files.release(grant.token);
});
```

The host derives both source and target identities from iframe windows it
created. App-supplied IDs never establish authority.

## Send to (v2)

An app declares what it takes in `commands.json`:

```json
{ "accepts": [{ "action": "import", "label": "Add to Notes", "extensions": [".md", ".txt"] }] }
```

`naklios.files.experimental_targets(path)` lists the apps that take a file, and Files builds its menu from the
answer. `action: "edit"` is the write-back grant above, which only Editor holds. `action: "import"` is a copy:
`naklios.files.experimental_sendTo(appId, paths)` asks the person, then gives the target one read-only token per
file, up to 10 files of 64 MB. `onOpen` delivers each grant with `kind: "send"` and `type`; `read(token)` answers
`{ bytes, name, path, type, sourceAppId, backend }`; a write is refused. Only same-origin apps receive tokens.
Extensions are the match because Folder and Crate keep no MIME type.

## Recovery rule

Editor keeps a separate Browser recovery record per project path or granted
file. A failed save or crash in one tab cannot restore, accept, or overwrite
another tab. Canonical content is shown first; a newer recovery is offered as
an explicit Restore or Discard decision for that file only.

## Deliberate limits

- v1 has one approved handler: the bundled Editor.
- Binary/image/media handoffs are out of scope.
- Grants are not persisted across Editor window lifetimes.
- Files are linked in place; there is no silent import, copy, or migration.
- A future handler registry must retain the same exact-file and explicit-user
  boundaries.

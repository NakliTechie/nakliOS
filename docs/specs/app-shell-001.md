# NakliOS app shell standard (app-shell-001)

Status: APPROVED by Chirag on 2026-11-17 with the recommended answers to D1-D6. Layer 1 in build. Owner: the office-shell session.
First adopters: Pellucia (slides, `~/Code/pellucia`), Reckon (spreadsheet, `naklios-universe/Reckon`),
Draft (documents, `naklios-universe/Draft`).

This standard fixes where things sit and which keys do what in every NakliOS app. It does not set a look.
The look stays with each app's Unity sentence and its direction in `DIRECTIONS.md` (Calm, Dense or Mono),
checked by `DESIGN-DOCTRINE.md` and the `typeui-fundamentals` accessibility floor. Commands keep the
"two doors, one core" rule: every control dispatches a command that `commands.json` also publishes to agents.

The standard has one base layout for every app and one profile for document apps. The document profile
follows the Microsoft Office layout, because Chirag asked for it and because most people already know it.

## 1. Why

Chirag's report (2026-11-17): button placement and shortcuts differ between the office apps, and saving and
opening a file is not intuitive. The survey in section 9 confirms it:

- Reckon has no File menu, no Open, no Save as and no New. Draft has no Save or Save as button and keeps its
  file actions in a "Documents" card on a left rail. Pellucia has a File menu but no Save as and no Recent.
- Each app saves differently: Pellucia writes a file through a picker every time, Reckon autosaves one
  workbook into a chosen folder, and Draft autosaves a library of documents into a chosen folder.
- `Mod+K` opens the command palette in Pellucia and Reckon, inserts a link in Draft, and inserts a link in
  Office. `Mod+Shift+S` opens the slide sorter in Pellucia and does nothing in the other two.
- Font controls sit in a right panel (Pellucia), a toolbar row (Reckon) and a rail plus a card (Draft).

## 2. Base layout for every NakliOS app

Every app draws the same five regions, top to bottom. An app may leave a region empty, but it never moves a
region or puts its job somewhere else.

| Region | Height | Holds |
|---|---|---|
| Title row | 36 px | Left: Quick Access (Save, Undo, Redo). Centre: document name, unsaved dot, save location. Right: the app's one primary action (Present, Play, Ask) and the help button. |
| Command row | 32 px | Tabs: **File** first, then **Home**, then the app's tabs. A tool with one job may show one toolbar instead of tabs. |
| Ribbon | 40 px, collapsible | The active tab's groups, left to right, separated by space. `Mod+F1` collapses it to the command row. |
| Workspace | rest | Optional left pane (navigation: slides, outline, sheets), the canvas, optional right pane (the Format pane). |
| Status bar | 24 px | Left: save state and messages. Middle: counts for the selection. Right: view switches, zoom, version. |

Rules for every region:

- The File tab opens the **Backstage**: a full-window page that covers the workspace (section 4). It is not a
  drop-down menu, because New, Open and Recent need room for a file list.
- Panes open and close from the View tab and from their status-bar switch. Right panes are task panes: one at a
  time, with a title and a close button, 320 px wide by default.
- Dialogs use `<dialog>`, a title that names the action, and buttons at the bottom right. The primary button is
  rightmost; Cancel sits to its left; `Esc` cancels and `Enter` runs the primary button. The unsaved-changes
  dialog always reads **Save**, **Don't save**, **Cancel**.
- Every control carries a tooltip with its label and its shortcut, for example "Bold (Ctrl+B)", with "Cmd" on a Mac.
- Light canvas by default. The shell follows the NakliOS theme when hosted and never follows the system dark mode
  by itself.
- Phone width (under 600 px): the ribbon folds into a "More" sheet, Quick Access keeps Save, Undo and Redo, and
  panes open as bottom sheets.

Tool apps without documents (NakliAmp, viewers, players) use the title row, a single toolbar in the command row and
the status bar. They keep the base keymap rows that apply to them (section 5.1).

## 3. Document profile: the Office layout

Document apps (slides, spreadsheet, documents, and later Paginella and Scribella) follow the matching Office app:
Draft follows Word, Reckon follows Excel, Pellucia follows PowerPoint.

### 3.1 Tabs

| App | Tabs, in order |
|---|---|
| All three | File, Home, Insert, … , Review, View |
| Draft | File, Home, Insert, Layout, References, Review, View |
| Reckon | File, Home, Insert, Formulas, Data, Review, View |
| Pellucia | File, Home, Insert, Design, Animations, Slide Show, Review, View |

AI features sit in the tab where their job belongs, plus the title-row primary action when the app has one
(Ask in Reckon). There is no separate AI tab.

### 3.2 Home tab groups (Office order)

| Group | Draft (Word) | Reckon (Excel) | Pellucia (PowerPoint) |
|---|---|---|---|
| Clipboard | Paste ▾, Cut, Copy, Format Painter | same | same |
| Slides | — | — | New Slide ▾, Layout ▾, Reset |
| Font | Family, Size, Grow, Shrink, Clear formatting; B, I, U, Strike, Sub, Super; Highlight, Font colour | Family, Size, Grow, Shrink; B, I, U; Borders ▾, Fill colour, Font colour | Family, Size, Grow, Shrink, Clear formatting; B, I, U, Strike; Font colour, Highlight |
| Paragraph / Alignment | Bullets, Numbering, Outdent, Indent; Left, Centre, Right, Justify; Line spacing | Top, Middle, Bottom; Left, Centre, Right; Wrap, Merge ▾ | Bullets, Numbering, Outdent, Indent; Left, Centre, Right, Justify; Line spacing, Align text ▾ |
| Number | — | Format ▾, Percent, Decimals −/+ | — |
| Styles | Style gallery | Conditional format, Table, Cell styles | — |
| Drawing | — | — | Shapes, Arrange ▾ |
| Editing | Find, Replace, Select ▾ | AutoSum, Sort and filter ▾, Find ▾ | Find, Replace, Select ▾ |

Clipboard, Font and Paragraph keep the same position and the same button order in all three apps, so a person
who learns one finds the others. Font family and size controls show the current value and accept typing.

### 3.3 Quick Access

Save, Undo, Redo, in that order, at the left of the title row. Save shows a spinner while saving and a tick for
two seconds after. Undo and Redo dim when there is nothing to undo or redo.

## 4. Save and open model

One model for every document app. It removes the three different models in section 9.4.

### 4.1 Where a document lives (its home)

| Home | When | How it saves |
|---|---|---|
| NakliOS storage | Hosted. The default for new documents. | `naklios.fs.write` to `apps/<id>/documents/<name>.<ext>`; the host backs it with Browser, Folder or Crate. |
| This computer | The person picked "This computer…" in Save as, or opened a file from disk. | The File System Access handle, kept in IndexedDB; a download when the browser has no save picker. |
| This browser | Standalone, no file picked yet. | OPFS through the same small adapter as `naklios.fs`, so the code path is one. |
| Not saved yet | A new document before its first save. | A recovery copy only (4.4). |

A document opened from Draft's or Reckon's existing chosen folder keeps that folder as its home, so no person
loses a folder they set up. The folder appears as a location on the Open page.

### 4.2 The commands

- **Save** (`Mod+S`, Quick Access): a document with a home saves there now. A document with no home runs Save as.
- **Save as** (`Mod+Shift+S`): one dialog with a Name field and a Location choice: NakliOS storage (default when
  hosted), This browser (standalone default) or This computer… (the save picker). The new copy becomes the home.
- **Open** (`Mod+O`): the Backstage Open page lists Recent first, then the files of this app's types in NakliOS
  storage (or This browser), then a "Browse this computer…" button.
- **New** (`Mod+Alt+N`, and `Mod+N` where the browser allows it): the Backstage New page with Blank first, then the
  app's templates. One document per window; an unsaved document asks Save, Don't save, Cancel first.
- **Export**: the Backstage Export page lists the formats (PDF, PPTX, XLSX, DOCX, CSV, Markdown and so on). Export
  writes a copy and never changes the home.
- **Print** (`Mod+P`): the app's print view, then the browser's print dialog.
- **Recent**: the 12 last-opened documents for this app, with name, location and time. Stored by the shell in
  IndexedDB, per app, because file handles cannot go in localStorage.

### 4.3 What the person always sees

- The title row shows the document name. A click renames it, which renames the file at its home.
- An unsaved dot (●) appears beside the name while changes are not yet at the home.
- The title row, beside the name (where Office shows "Saved to this PC"), shows one of: "Saved to NakliOS storage, 14:02", "Saving…", "Saved to this computer
  (report.draft.json)", or "Not saved yet. A recovery copy is kept in this browser."
- `document.title` and `naklios.title` read `● Name — App` while unsaved and `Name — App` once saved.

### 4.4 AutoSave and recovery

- A document with a home saves itself 1 s after the last change, through `naklios.fs.autosave`, which already
  reports the unsaved state to the host and flushes on hide and close. Office calls this AutoSave; the shell shows
  it as an "AutoSave" switch in the title row, on by default.
- A new document gets its home in the default store (NakliOS storage, or this browser standalone) on its first
  change, under a name not yet taken ("Untitled document", "Untitled document 2"), so an untouched new document
  leaves no file behind and a changed one is never only in memory.
- Crash recovery stays with each app in layer 1, because all three first adopters already keep recovery copies.
  The shell takes it over only when an app without its own recovery adopts the shell.
- A save that fails keeps the unsaved dot, shows the reason in the status bar and leaves the recovery copy in place.

## 5. Standard keymap

`Mod` is Cmd on a Mac and Ctrl elsewhere. The shell owns the keys in 5.1 and 5.2 and dispatches them to the app's
commands; an app may not bind them to anything else. Keys outside these tables follow the matching Office app
(Word, Excel or PowerPoint) where Office has one.

### 5.1 Core keys, every app

| Keys | Command | Note |
|---|---|---|
| `Mod+S` | Save | |
| `Mod+Shift+S` | Save as | Pellucia's slide sorter moves to the View tab and `Mod+Alt+S`. |
| `Mod+O` | Open | |
| `Mod+Alt+N`, `Mod+N` | New | Chrome keeps `Mod+N` in a normal tab; it works in an installed app window. |
| `Mod+P` | Print | |
| `Mod+Z` | Undo | |
| `Mod+Y`, `Mod+Shift+Z` | Redo | |
| `Mod+X`, `Mod+C`, `Mod+V` | Cut, Copy, Paste | |
| `Mod+Shift+V` | Paste special (values or plain text) | |
| `Mod+A` | Select all | |
| `Mod+F` | Find | |
| `Mod+H` | Replace | `Ctrl+H` on a Mac, because macOS keeps `Cmd+H`. |
| `Mod+Shift+P`, `Alt+Q` | Search commands (the palette) | Office's "Tell me" key is `Alt+Q`. |
| `Mod+F1` | Collapse or expand the ribbon | |
| `F1`, `?` outside text | Help and the shortcut list | |
| `F6`, `Shift+F6` | Move focus between regions | |
| `Esc` | Close the Backstage, a pane or a dialog | |

### 5.2 Formatting keys, every app that formats text

| Keys | Command |
|---|---|
| `Mod+B`, `Mod+I`, `Mod+U` | Bold, Italic, Underline (on the selection, inside or outside text editing) |
| `Mod+K` | Insert link |
| `Mod+Shift+.`, `Mod+Shift+,` | Grow font, Shrink font (Office's `Ctrl+Shift+>` and `<`) |
| `Mod+Space` | Clear character formatting (Word and PowerPoint; Reckon keeps Excel's column select) |
| `Mod+L`, `Mod+E`, `Mod+R`, `Mod+J` | Align left, centre, right, justify (Draft and Pellucia; Reckon keeps Excel's `Mod+E` flash fill) |
| `Mod+Shift+L`, `Mod+Shift+7` | Bullets, numbering (Word's `Ctrl+Shift+L` and Google's `Mod+Shift+7`) |
| `Mod+=`, `Mod+Shift+=` | Subscript, superscript |

### 5.3 Moves the survey requires

| App | Today | Moves to |
|---|---|---|
| Pellucia | `Mod+K` palette | `Mod+Shift+P`; `Mod+K` becomes Insert link |
| Pellucia | `Mod+Shift+S` slide sorter | `Mod+Alt+S` |
| Pellucia | `Mod+=` / `Mod+-` zoom | `Mod+Alt+=` / `Mod+Alt+-` (Reckon's zoom keys) |
| Pellucia | `Mod+B/I/U` only while editing text | applies to the selected text boxes too |
| Reckon | `Mod+K` palette | `Mod+Shift+P`; `Mod+K` becomes Insert link |
| Reckon | `Mod+S` flushes autosave | Save (4.2) |
| Reckon | `Mod+Shift+F` draft formula | unchanged; Excel has no binding |
| Draft | `Mod+Shift+L` align left, `Mod+Shift+E` centre | `Mod+L`, `Mod+E`; `Mod+Shift+L` becomes bullets |
| Draft | `Mod+.` superscript, `Mod+,` subscript | `Mod+Shift+=`, `Mod+=` (Word's keys) |
| Draft | `Mod+Shift+H` highlight | unchanged (Word's highlight has no default key) |
| Draft | `Mod+Shift+R` Sidecar rewrite | unchanged |

## 6. The shared module

### 6.1 What it is

One file, `sdk/app-shell.js` in the nakliOS repo, served at `https://naklios.dev/sdk/app-shell.js`. Each app
inlines it between markers, the same way it inlines the SDK:

```
/* naklios-app-shell:begin ver=1 sha256=… */
(function () { … })();
/* naklios-app-shell:end */
```

`scripts/vendor-naklios-sdk.mjs` gains `--name app-shell`, so each app's daily vendor workflow refreshes both
blocks. Draft's workflow already re-runs `product-check --write`, which updates its CSP hashes.

The module draws the regions, the Backstage, the dialogs, Quick Access and the status bar; owns the keymap in
sections 5.1 and 5.2; and runs the save and open model in section 4. It installs its CSS through a constructed
stylesheet (`adoptedStyleSheets`), so Draft's hash-only CSP needs no `unsafe-inline`. Every colour, font and space
comes from CSS custom properties (`--shell-canvas`, `--shell-ink`, `--shell-accent`, `--shell-line`,
`--shell-font`, `--shell-space`) that each app maps to its own tokens, so the direction of each app survives.

### 6.2 What an app gives it

```js
const shell = naklishell.mount({
  app: { id: 'draft', name: 'Draft', ext: '.draft.json',
         opens: ['.draft.json', '.md', '.txt', '.docx'] },
  doc: {
    blank(),                    // replace the editor contents with a new document
    templates: [{ id, label, make() }],
    serialize(),                // → Blob in the native format
    load(file, info),           // open a File; info.home says where it came from
    exports: [{ id: 'docx', label: 'Word document (.docx)', ext: '.docx', make() }],
    print(),
  },
  run(name, args),              // the app's existing command bus; the shell never edits the document itself
  state(),                      // { canUndo, canRedo, bold, italic, underline, font, size, align, … }
  tabs: [                       // groups list command names; the shell draws the controls
    { id: 'home', label: 'Home', groups: [
      { id: 'clipboard', label: 'Clipboard', items: ['edit.paste', 'edit.cut', 'edit.copy', 'format.painter'] },
      { id: 'font', label: 'Font', items: ['format.font', 'format.size', 'format.bold', /* … */] } ] },
  ],
  controls: { 'format.font': { kind: 'select', options: () => [...] } },
});
shell.changed();               // after every edit: unsaved dot, autosave timer, recovery copy
shell.refresh();               // after a selection change: re-read state() for toggles and values
```

### 6.3 Commands and the agent surface

- Each app's `commands.json` stays its agent surface. File commands take one name in every app:
  `file.new`, `file.open`, `file.save`, `file.save_as`, `file.export`, `file.print`, `file.recent`. The shell
  implements them and hands the app's existing handlers only `serialize`, `load` and `blank`.
- Old names (`deck.save`, `deck.open`, Draft's `document.*`) stay as aliases for one release, because the voice
  assistant and Anvil call them by name today.
- Each command in `commands.json` gains its `shortcut` from section 5, so the keymap and the agent surface are one
  list.
- A check script, `scripts/check-app-shell.mjs` in nakliOS, fails CI when an app's `commands.json` lacks a standard
  command, binds a core key to another command, or misses a shortcut the standard assigns.

## 7. Build layers

Each layer ships on its own and leaves every app working.

1. **File, save and keys.** The module with the title row, Quick Access, the Backstage (New, Open, Save, Save as,
   Export, Print, Recent), the save and open model, the core keymap, the title and unsaved dot, and the status-bar
   save state. The apps keep their current toolbars under the new title row for now.
2. **Home tab.** The command row with File and Home; the Clipboard, Font and Paragraph groups; formatting keys
   (5.2). Font controls move out of Pellucia's Format panel, Reckon's toolbar row and Draft's rail into Home. The
   Format panel stays for shape and slide properties.
3. **Remaining tabs.** Each app's other controls move into its Office tabs (3.1); the old rail, menu bar and
   toolbar go; the check script (6.3) joins each app's CI.

Checks per layer: each app's own test suite, `check-app-shell.mjs` from layer 3, and a live check in Chrome over
the CDP daemon in NakliOS and standalone: Save, Save as, Open from Recent, a reload with unsaved changes, and every
key in 5.1.

## 8. Decisions for Chirag

| # | Question | Recommendation |
|---|---|---|
| D1 | Ribbon form: one-line simplified ribbon (Office for the web's default) or the classic three-row ribbon with group labels | One-line ribbon, because it costs 40 px instead of about 95 px and suits Draft's Calm direction; group labels show in tooltips. |
| D2 | Standalone home: this browser plus "This computer…" files, or keep Draft's and Reckon's folder pickers as the default | This browser plus files, with existing folders still opening; NakliOS storage is the main path since apps ship as NakliOS mirrors. |
| D3 | Command palette key: `Mod+Shift+P` (and `Alt+Q`), freeing `Mod+K` for Insert link as in Office | Yes. |
| D4 | New on `Mod+Alt+N` because Chrome keeps `Mod+N` in a tab | Yes. |
| D5 | File commands renamed to `file.*` in every app, old names kept as aliases for one release | Yes. |
| D6 | Where the spec and module live: the nakliOS repo (`docs/specs/`, `sdk/app-shell.js`) | Yes, beside the SDK the apps already vendor. |

## 9. Survey (2026-11-17)

Sources: three read-only surveys of the source trees. Line references are in each app's repo.

### 9.1 Layout today

| | Pellucia | Reckon | Draft |
|---|---|---|---|
| Top of window | Menu bar (File, Edit, Insert, Slide, Arrange, View, Present, Review, AI), deck name, dot, Undo, Redo, New Slide, tools, Present | Name box, formula bar, Ask | Status line (title, counts, saved state, version) |
| Commands | Menus plus a tool strip | One toolbar row, 9 groups, "More" overflow (`ui/toolbar.mjs:400-416`; four empty separators from a duplicated group list) | 44 px vertical rail on the left (`ui/rail.mjs`) |
| Format controls | Right Format panel (`src/ui.js:1566-1601`) | Toolbar row | Rail (B, I, U, H1-H4, lists) plus the Format card |
| Status bar | Yes, with zoom and view switches | Yes, with sheet tabs above | No; the top status line instead |

### 9.2 File actions today

| Action | Pellucia | Reckon | Draft | Standard |
|---|---|---|---|---|
| New | File menu, `Mod+Alt+N` | none | Documents card | Backstage, `Mod+Alt+N` |
| Open | File menu, `Mod+O` | "Open folder" link in the empty state only | Documents card "Open a file…" | Backstage, `Mod+O` |
| Save | File menu, `Mod+S` (picker each time standalone) | none; `Mod+S` flushes autosave | none (autosave only) | Quick Access, `Mod+S` |
| Save as | none | none | none | Backstage, `Mod+Shift+S` |
| Export | File menu, `Mod+Shift+E`, 8 formats | Export ▾ in toolbar, 5 formats | Documents card "Download as", 4 formats | Backstage Export |
| Print | via export to PDF | `Mod+P` while the grid has focus | rail button; browser's own `Mod+P` | Backstage, `Mod+P` |
| Recent | none | none | the store's document list | Backstage Open, 12 entries |
| Recovery | IndexedDB copies, File > Recover | version history | "Kept in this browser" | 4.4 |

### 9.3 Clipboard, undo, font

| | Pellucia | Reckon | Draft |
|---|---|---|---|
| Cut, Copy, Paste buttons | Edit menu | context menu only | none |
| Undo, Redo buttons | top bar | toolbar | none (keys and palette) |
| Font family | Format panel | toolbar (sans, serif, mono) | none |
| Font size | Format panel, px | toolbar | Format card, 5 sizes |
| B, I, U | Format panel; keys only while editing text | toolbar and keys | rail and keys |
| Colour, highlight | Format panel | text colour, fill | Format card |
| Alignment | Format panel; no keys | toolbar; no keys | Format card; `Mod+Shift+L/E/J`, `Mod+Alt+R` |

### 9.4 Save and open model today

| | Pellucia | Reckon | Draft |
|---|---|---|---|
| Hosted | `naklios.fs` into `apps/pellucia/decks/` | `naklios.fs` only after the person chooses "Keep workbooks in NakliOS storage" | does not use `naklios.fs` |
| Standalone | a new save picker every Save, else a download | one workbook in a chosen folder (`showDirectoryPicker`), else OPFS, else IndexedDB | a library in a chosen folder, else OPFS, else IndexedDB |
| AutoSave | recovery copy only | yes, 150 ms | yes, 500 ms |
| File name in window title | no | no | in NakliOS only (`Draft — name •`) |
| Unsaved indicator | dot beside the deck name | none; "saved 14:02" in the status bar | status line text |

### 9.5 Shortcut gaps against section 5

| Keys | Pellucia | Reckon | Draft |
|---|---|---|---|
| `Mod+N` / `Mod+Alt+N` | `Mod+Alt+N` | none | none |
| `Mod+O` | Open | none (browser) | none (browser) |
| `Mod+S` | Save | autosave flush | none (browser) |
| `Mod+Shift+S` | slide sorter | none | none |
| `Mod+P` | none | grid focus only | browser only |
| `Mod+H` | none | none | none |
| `Mod+K` | palette | palette | link |
| `Mod+B/I/U` | text editing only | yes | yes |
| `Mod+L/E/R/J` | none | `Mod+E` flash fill | `Mod+Shift+…` variants |
| `Mod+Shift+P` | none | none | palette |
| `Mod+Z`, `Mod+Y`, `Mod+Shift+Z`, `Mod+X/C/V`, `Mod+F` | yes | yes | yes |

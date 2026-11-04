# How NakliOS opens apps

NakliOS has one way to open apps. Basic mode, which opened most web apps in browser tabs, was retired on
2026-11-04: it worked against the point of a desktop in the browser, and the windowed experience covers every
case it served.

## The rule

- **System apps** (Files, Notes, Calendar, Anvil, Dish, Pi and the rest) open in NakliOS windows.
- **Host-native classics** (Minesweeper, Solitaire and the other built-ins) open as inline windows.
- **Every other app** opens in a NakliOS window, inherits the theme, shows App Info, and may use the
  cooperative SDK.
- **An app that cannot run inside a window** opens at its canonical URL in a new tab. The catalog marks it with
  `opensInNewTab:true` (it needs a top-level page, for example a folder picker blocked in a cross-origin frame)
  or `iframeable:false` (it refuses to be framed). NakliOS does not weaken its sandbox or pretend such an app
  embeds.

## Compatibility

- A profile that had saved Basic drops that preference once, on its next visit; nothing else changes.
- Opening an app in a window or in a tab never migrates, copies, deletes, or rebinds app data.
- Cross-origin apps stay sandboxed whenever they are embedded. Opening one never grants same-origin privilege.
- The desktop no longer offers the `mode.get` and `mode.set` agent commands, and `state.json` no longer
  carries a mode.

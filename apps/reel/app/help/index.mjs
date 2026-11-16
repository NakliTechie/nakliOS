/* Reel feature module: help. Contract: docs/build/reel-v1-contract.md.
 * No DOM access at module top level, so Node can import COMMANDS for commands.json.
 *
 * `?` (or the help button) opens a keyboard help sheet. The sheet is built from
 * ctx.registry.list() each time it opens, so it always shows the keys the registry
 * actually binds, grouped by command namespace ("playback", "subtitle", ...).
 * The helpers below are pure and exported so scripts/verify-commands.mjs can check
 * that every key the sheet lists comes from the registry. */

export const COMMANDS = [
  { name: 'help.show', label: 'Keyboard shortcuts', scope: 'write', readTwin: 'state.read',
    description: 'Open or close the keyboard help sheet; with no input it toggles. Returns whether the sheet is open and the shortcuts it lists.',
    input: { type: 'object', properties: { open: { type: 'boolean', description: 'true opens, false closes' } }, required: [] },
    shortcuts: [{ key: '?' }] },
];

export const STRINGS = {
  'help.title': 'Keyboard shortcuts',
  'help.button': 'Keyboard shortcuts',
  'help.close': 'Close',
  'help.empty': 'No keyboard shortcuts are registered.',
  'help.licences': 'Licences and source',
  'help.footer': 'Every action here is also a command in commands.json, so agents see the same list.',
  'help.group.playback': 'Playback',
  'help.group.frame': 'Frame',
  'help.group.loop': 'Loop',
  'help.group.chapter': 'Chapters',
  'help.group.audio': 'Audio',
  'help.group.subtitle': 'Subtitles',
  'help.group.view': 'Picture and view',
  'help.group.queue': 'Queue',
  'help.group.media': 'File',
  'help.group.help': 'Help',
  'help.key.space': 'Space',
  'help.key.arrowleft': 'Left arrow',
  'help.key.arrowright': 'Right arrow',
  'help.key.arrowup': 'Up arrow',
  'help.key.arrowdown': 'Down arrow',
  'help.key.pageup': 'Page Up',
  'help.key.pagedown': 'Page Down',
  'help.key.escape': 'Esc',
  'help.key.enter': 'Enter',
  'help.key.home': 'Home',
  'help.key.end': 'End',
  'help.key.shift': 'Shift',
  'help.key.alt': 'Alt',
  'help.on': 'on',
  'help.off': 'off',
};

const GLYPHS = {
  space: 'Space', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓',
  pageup: 'PgUp', pagedown: 'PgDn', escape: 'Esc', enter: 'Enter', home: 'Home', end: 'End',
};
const MINUS = '−';

/* Namespace order on the sheet; namespaces not listed follow in first-seen order. */
const GROUP_ORDER = ['playback', 'frame', 'loop', 'chapter', 'audio', 'subtitle', 'view', 'queue', 'media', 'help'];

/* Every shortcut in a definition list, as { key, name, label, input, group }. */
export function shortcutRows(definitions) {
  const rows = [];
  for (const def of definitions) {
    for (const shortcut of def.shortcuts || []) {
      rows.push({ key: shortcut.key, name: def.name, label: def.label, input: shortcut.input || {}, group: def.name.split('.')[0] });
    }
  }
  return rows;
}

/* Rows grouped by namespace in sheet order: [{ group, rows }]. */
export function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.group)) groups.set(row.group, []);
    groups.get(row.group).push(row);
  }
  const rank = group => {
    const index = GROUP_ORDER.indexOf(group);
    return index === -1 ? GROUP_ORDER.length : index;
  };
  return [...groups.entries()]
    .map(([group, list], seen) => ({ group, rows: list, seen }))
    .sort((a, b) => rank(a.group) - rank(b.group) || a.seen - b.seen)
    .map(({ group, rows: list }) => ({ group, rows: list }));
}

/* Parts of a key spec for display: [{ part, glyph }], e.g. "shift+n" -> Shift, N. */
export function keyParts(spec) {
  const pieces = spec.split('+');
  const key = pieces.pop() || '+';
  const parts = pieces.map(mod => ({ part: mod, glyph: mod[0].toUpperCase() + mod.slice(1) }));
  parts.push({ part: key, glyph: GLYPHS[key] || (key.length === 1 ? key.toUpperCase() : key) });
  return parts;
}

function signed(value) {
  if (value > 0) return `+${value}`;
  if (value < 0) return `${MINUS}${Math.abs(value)}`;
  return '0';
}

/* Short text for a shortcut's fixed input, e.g. { seconds: -10 } -> "−10 s". */
export function describeInput(input, words = { on: 'on', off: 'off' }) {
  const out = [];
  for (const [name, value] of Object.entries(input || {})) {
    if (typeof value === 'number') {
      const unit = /ms$/i.test(name) ? ' ms'
        : (name === 'seconds' || /S$/.test(name)) ? ' s'
        : name === 'rate' ? '×' : '';
      const relative = name === 'seconds' || /delta|step|direction|by/i.test(name);
      out.push(`${relative ? signed(value) : value}${unit}`);
    } else if (typeof value === 'boolean') {
      out.push(value ? words.on : words.off);
    } else if (typeof value === 'string') {
      out.push(value);
    }
  }
  return out.join(' ');
}

export function install(ctx) {
  const { t } = ctx;
  let dialog = null;
  let returnFocus = null;

  ctx.addStyle(`
    .help-sheet{background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:var(--radius);padding:0;max-width:min(560px,calc(100vw - 32px));width:100%;max-height:min(80vh,720px)}
    .help-sheet::backdrop{background:rgba(0,0,0,.6)}
    .help-sheet header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--surface)}
    .help-sheet h2{font-size:15px;font-weight:600;margin:0}
    .help-sheet header button{font-size:12px;color:var(--dim);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
    .help-sheet .help-body{padding:8px 20px 16px}
    .help-sheet h3{font-size:11px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px}
    .help-sheet dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}
    .help-sheet dt{white-space:nowrap}
    .help-sheet dd{margin:0;font-size:13px}
    .help-sheet kbd{display:inline-block;min-width:22px;text-align:center;font:12px/1.6 ui-monospace,monospace;border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;padding:0 6px;background:var(--surface-2)}
    .help-sheet kbd + kbd{margin-left:4px}
    .help-sheet .help-input{color:var(--dim);margin-left:6px}
    .help-sheet footer{padding:0 20px 16px;font-size:12px;color:var(--faint);display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline}
    .help-sheet footer p{margin:0;flex:1 1 240px}
    .help-sheet footer a{color:var(--dim)}
    .help-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
    .help-button{font-size:13px;font-weight:600;min-width:28px;height:28px;border-radius:8px;color:var(--dim)}
  `);

  function keyLabel(part) {
    const named = t(`help.key.${part.part}`);
    return named === `help.key.${part.part}` ? part.glyph : named;
  }

  function groupTitle(group) {
    const title = t(`help.group.${group}`);
    return title === `help.group.${group}` ? group[0].toUpperCase() + group.slice(1) : title;
  }

  function currentRows() {
    return shortcutRows(ctx.registry.list());
  }

  function render(body) {
    body.replaceChildren();
    const rows = currentRows();
    if (!rows.length) {
      const p = document.createElement('p');
      p.textContent = t('help.empty');
      body.append(p);
      return;
    }
    const words = { on: t('help.on'), off: t('help.off') };
    for (const { group, rows: list } of groupRows(rows)) {
      const heading = document.createElement('h3');
      heading.textContent = groupTitle(group);
      const dl = document.createElement('dl');
      for (const row of list) {
        const dt = document.createElement('dt');
        dt.dataset.key = row.key;
        dt.dataset.command = row.name;
        for (const part of keyParts(row.key)) {
          const kbd = document.createElement('kbd');
          const visible = document.createElement('span');
          visible.setAttribute('aria-hidden', 'true');
          visible.textContent = part.glyph;
          const spoken = document.createElement('span');
          spoken.className = 'help-sr';
          spoken.textContent = keyLabel(part);
          kbd.append(visible, spoken);
          dt.append(kbd);
        }
        const dd = document.createElement('dd');
        dd.textContent = row.label;
        const detail = describeInput(row.input, words);
        if (detail) {
          const span = document.createElement('span');
          span.className = 'help-input';
          span.textContent = detail;
          dd.append(span);
        }
        dl.append(dt, dd);
      }
      body.append(heading, dl);
    }
  }

  function build() {
    const el = document.createElement('dialog');
    el.className = 'help-sheet';
    el.id = 'help-sheet';
    el.setAttribute('aria-labelledby', 'help-sheet-title');
    const header = document.createElement('header');
    const title = document.createElement('h2');
    title.id = 'help-sheet-title';
    title.textContent = t('help.title');
    const close = document.createElement('button');
    close.type = 'button';
    close.dataset.command = 'help.show';
    close.textContent = t('help.close');
    close.addEventListener('click', () => { ctx.registry.run('help.show', { open: false }); });
    header.append(title, close);
    const body = document.createElement('div');
    body.className = 'help-body';
    const footer = document.createElement('footer');
    const footerText = document.createElement('p');
    footerText.textContent = t('help.footer');
    const licences = document.createElement('a');
    licences.href = 'licences.html';
    licences.target = '_blank';
    licences.rel = 'noopener';
    licences.dataset.help = 'licences';
    licences.textContent = t('help.licences');
    footer.append(footerText, licences);
    el.append(header, body, footer);

    // Esc fires "cancel" on a modal dialog; route it through the command so state stays in one place.
    el.addEventListener('cancel', event => {
      event.preventDefault();
      ctx.registry.run('help.show', { open: false });
    });
    // Keep player shortcuts from acting behind the sheet; `?` closes it again.
    el.addEventListener('keydown', event => {
      if (event.key === '?') {
        event.preventDefault();
        ctx.registry.run('help.show', { open: false });
      }
      if (event.key !== 'Tab' && event.key !== 'Escape') event.stopPropagation();
    });
    // A click on the backdrop lands on the dialog element itself.
    el.addEventListener('click', event => {
      if (event.target === el) ctx.registry.run('help.show', { open: false });
    });
    ctx.mounts.dialogs.append(el);
    return el;
  }

  function isOpen() { return !!dialog?.open; }

  function openSheet() {
    if (isOpen()) return;
    dialog ||= build();
    render(dialog.querySelector('.help-body'));
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // showModal makes the rest of the page inert, so Tab stays inside the sheet.
    dialog.showModal();
    dialog.querySelector('header button').focus();
  }

  function closeSheet() {
    if (!isOpen()) return;
    dialog.close();
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  ctx.registry.handle('help.show', ({ open }) => {
    const want = typeof open === 'boolean' ? open : !isOpen();
    if (want) openSheet(); else closeSheet();
    ctx.store.ui.help = { open: isOpen() };
    return {
      open: isOpen(),
      shortcuts: currentRows().map(({ key, name, input }) => ({ key, name, input })),
    };
  });

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'help-button';
  button.dataset.command = 'help.show';
  button.setAttribute('aria-label', t('help.button'));
  button.title = t('help.button');
  button.setAttribute('aria-haspopup', 'dialog');
  button.textContent = '?';
  button.addEventListener('click', () => { ctx.registry.run('help.show', {}); });
  ctx.mounts.controlsRight.append(button);

  ctx.on('ui:media-cleared', () => closeSheet());
}

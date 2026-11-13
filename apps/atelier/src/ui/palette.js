// Command palette (L72), Ctrl+K or Cmd+K: search by task with synonyms (search_commands), then run the
// result through the panel's own control, so it sends exactly what the panel would: a tool result picks the
// tool, a develop slider result focuses that slider, a command result clicks the control that sends it.

import { h } from './dom.js';

// The visible element for a result, or null. Prefers a control whose text names the result's label.
export function findControl(doc, r) {
  let sel;
  if (r.kind === 'parameter') sel = `[data-command="set_develop"][data-param="${r.param}"]`;
  else if (r.kind === 'tool') sel = `[data-tool="${r.tool}"]`;
  else if (r.command) sel = `[data-command="${r.command}"]`;
  const byLabel = r.kind === 'control' ? [...doc.querySelectorAll('[data-view-label]')].filter((el) => el.dataset.viewLabel === r.label) : [];
  if (byLabel.length) return byLabel[0];
  if (!sel) return null;
  const all = [...doc.querySelectorAll(sel)];
  const lw = r.label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const score = (el) => { const t = `${el.textContent} ${el.getAttribute('aria-label') || ''} ${el.title || ''}`.toLowerCase(); return lw.filter((w) => t.includes(w)).length; };
  return all.sort((a, b) => score(b) - score(a))[0] || null;
}

export function createPalette(ui) {
  const input = h('input', { type: 'text', placeholder: 'What do you want to do? (remove object, white balance, background blur…)', 'aria-label': 'Search commands by task', dataset: { command: 'search_commands' } });
  const list = h('ul', { class: 'palette-list', role: 'listbox' });
  const dlg = h('dialog', { class: 'dlg palette', 'aria-label': 'Command palette' }, input, list, h('p', { class: 'hint' }, 'Enter runs the highlighted result through its panel control. Esc closes.'));
  document.body.append(dlg);
  let results = []; let at = 0; let seq = 0;

  async function search() {
    const my = ++seq; const q = input.value.trim();
    if (!q) { results = []; draw(); return; }
    const r = await ui.read('search_commands', { query: q, limit: 12 });
    if (my !== seq) return;
    results = r.status === 'ok' ? r.result.results : []; at = 0; draw();
  }
  function draw() {
    list.replaceChildren(...results.map((r, i) => h('li', { role: 'option', 'aria-selected': String(i === at), class: i === at ? 'on' : null, onclick: () => { at = i; run(); } },
      h('span', {}, r.label), h('span', { class: 'dim' }, r.person ? 'you do this yourself' : r.kind === 'tool' ? `${r.mode[0].toUpperCase()}${r.mode.slice(1)} tool` : r.kind === 'parameter' ? 'Develop setting' : ''))));
    if (!results.length && input.value.trim()) list.append(h('li', { class: 'dim' }, 'No command matches that task.'));
  }
  async function ensureMode(mode) {
    if (ui.ctx.view.mode === mode) return;
    document.querySelector(`button.mode[data-mode="${mode}"]`)?.click();
    await new Promise((r) => setTimeout(r, 60));
  }
  async function run() {
    const r = results[at]; if (!r) return;
    dlg.close();
    if (r.person) { ui.say(`${r.label}: ${r.person}.`); return; }
    if (r.kind === 'tool') { await ensureMode(r.mode); ui.setTool(r.tool); ui.say(`${r.label} selected.`); return; }
    if (r.kind === 'parameter') await ensureMode('develop');
    // a control inside a closed section counts as reachable: its sections open before the visibility check
    const reach = () => { const el = findControl(document, r); for (let p = el?.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true; return el; };
    let el = reach();
    if (!el?.offsetParent) { for (const m of [ui.ctx.view.mode === 'develop' ? 'composite' : 'develop']) { await ensureMode(m); el = reach(); } }
    if (!el?.offsetParent) { ui.say(`${r.label} has no control on screen right now. Open a photo or switch mode, then try again.`); return; }
    el.scrollIntoView({ block: 'nearest' });
    el.classList.add('palette-flash'); setTimeout(() => el.classList.remove('palette-flash'), 1200);
    if (el.tagName === 'DETAILS') { el.open = true; el.querySelector('summary')?.focus(); } else if (el.tagName === 'BUTTON' || el.tagName === 'SUMMARY') el.click(); else el.focus();
    ui.say(`${r.label}.`);
  }

  input.addEventListener('input', () => search().catch(() => {}));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); at = Math.min(results.length - 1, at + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); at = Math.max(0, at - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(); }
  });
  addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); }
  }, true);
  function open() { if (!dlg.open) dlg.showModal(); input.select(); search().catch(() => {}); }
  return { open, run, get results() { return results; }, input };
}

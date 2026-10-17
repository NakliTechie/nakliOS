// window-rig — the developer-gated window.rig door (C4).
//
// window.rig is OFF BY DEFAULT (hard rule / §6: "Developer setting, off by
// default. No exceptions."). installWindowRig only attaches the surface when
// `enabled` is true; when off, window.rig is left undefined. The surface is the
// governed agent face. Approval stays in the operator UI, never on this surface.

/**
 * @param {object} opts
 * @param {object} [opts.target]   the global to attach to (defaults to window)
 * @param {boolean} opts.enabled   the developer setting
 * @param {object}  opts.face      a createAgentFace(...) result
 * @returns {function} an uninstall function that removes window.rig
 */
export function installWindowRig({ target, enabled, face }) {
  const g = target || (typeof window !== 'undefined' ? window : undefined);
  if (!g) return () => {};
  const remove = () => { try { delete g.rig; } catch (_) { g.rig = undefined; } };
  if (!enabled) { remove(); return remove; }
  g.rig = {
    invoke: (name, input) => face.invoke(name, input),
    reject: (id) => face.reject(id),
    pending: () => face.pendingProposals(),
    search: (q) => face.searchCommands(q),
    describe: (n) => face.describeCommand(n),
    tools: () => face.toolSchemas(),
    grant: () => face.grant.describe(),
  };
  return remove;
}

// A tab-scoped, explicit developer opt-in. Apps and the desktop share this
// control; remounts resolve the current face rather than retaining old grants.
export function wireWindowRig({ getFace, target = window, container = target.document.body }) {
  const key = 'naklios.agent.enabled';
  const doc = target.document;
  const panel = doc.createElement('details');
  panel.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:10020;background:#20212a;color:white;padding:8px;border-radius:8px;font:12px system-ui;max-width:320px';
  const label = doc.createElement('summary'); label.textContent = 'Developer agent tools'; panel.append(label);
  const toggle = doc.createElement('input'); toggle.type = 'checkbox';
  const option = doc.createElement('label'); option.append(toggle, doc.createTextNode(' Enable agent tools in this tab'));
  panel.append(option);
  const description = doc.createElement('p'); description.textContent = 'Enables declared tools over this workspace or connected store. Destructive requests wait here for your review.'; panel.append(description);
  const review = doc.createElement('button'); review.textContent = 'Review pending requests'; panel.append(review);
  const proposals = doc.createElement('div'); panel.append(proposals); container.append(panel);
  const current = () => { const face=getFace(); if(!face) throw new Error('Workspace is still loading'); return face; };
  const proxy = {
    invoke: (...a) => current().invoke(...a), reject: (...a) => current().reject(...a),
    pendingProposals: () => current().pendingProposals(), searchCommands: q => current().searchCommands(q),
    describeCommand: n => current().describeCommand(n), toolSchemas: () => current().toolSchemas(),
    get grant() { return current().grant; },
  };
  const refresh = () => {
    let enabled = false; try { enabled = target.sessionStorage.getItem(key) === 'true'; } catch (_) {}
    toggle.checked = enabled;
    installWindowRig({ target, enabled, face: proxy });
  };
  toggle.addEventListener('change', event => {
    if (!event.isTrusted) { refresh(); return; }
    try { target.sessionStorage.setItem(key, String(toggle.checked)); } catch (_) { toggle.checked = false; }
    refresh(); proposals.replaceChildren();
  });
  review.addEventListener('click', () => {
    proposals.replaceChildren();
    const ownerFace = getFace();
    if(!ownerFace) { proposals.textContent='Workspace is still loading'; return; }
    for (const id of ownerFace.pendingProposals()) {
      const row = doc.createElement('div');
      const detail = ownerFace.proposal?.(id);
      row.textContent = detail ? `${detail.name}: ${JSON.stringify(detail.input)}` : id;
      for (const action of ['Accept', 'Reject']) {
        const button = doc.createElement('button'); button.textContent = action;
        button.addEventListener('click', async event => {
          if (!event.isTrusted || !toggle.checked || getFace() !== ownerFace) return;
          button.disabled = true;
          try {
            const result = action === 'Accept' ? await ownerFace.accept(id) : ownerFace.reject(id);
            row.textContent = JSON.stringify(result);
          } catch (error) { row.textContent = String(error.message || error); }
        });
        row.append(button);
      }
      proposals.append(row);
    }
  });
  target.addEventListener('storage', event => { if (event.key === key) refresh(); });
  refresh();
  return { refresh, panel };
}

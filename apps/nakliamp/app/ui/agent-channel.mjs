// agent-channel.mjs — the person's switch for the `nakliamp` BroadcastChannel (N9).
//
// The channel lets another tab or window of this site read and drive NakliAmp. On
// naklios.dev every NakliOS app shares that site, so the channel is off until the person
// turns it on here, for this tab only. On, it answers read commands. To let another tab
// change the player, the person makes a pairing code here and pastes it into that tab;
// the code is never stored and stops working when the person makes a new one, turns the
// channel off or closes the tab. Destructive commands and turning on network services are
// never accepted on the channel.
//
// ctx.agentChannel: { state() -> { on, available, code, instance }, set(on), pair(fresh),
//                     onChange(fn) -> off }.

import { h, injectCss, nextId } from './dialog.mjs';

const CSS = `
.nk-chan p{margin:0 0 10px;line-height:1.5}
.nk-chan .code{font:600 18px/1.3 var(--mono,monospace);letter-spacing:.06em;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2);user-select:all;overflow-wrap:anywhere}
.nk-chan .row{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px}
.nk-chan label.switch{display:flex;gap:8px;align-items:center;font-weight:600;margin:4px 0 10px}
`;

/** The status line for a channel state. Pure. */
export function channelStatusText(state) {
  if (!state?.available) return 'This browser has no BroadcastChannel, so the channel cannot open.';
  if (!state.on) return 'Off. No other tab can read or control NakliAmp.';
  if (!state.code) return 'On, read only. Other tabs of this site can read what is playing, the queue and the library, and change nothing.';
  return 'On and paired. A tab that holds this code can also change playback, the queue and playlists. Destructive changes and network services stay in NakliAmp.';
}

export function mountAgentChannel(root, ctx) {
  injectCss('agent-channel', CSS);
  const api = ctx.agentChannel;
  const id = nextId('chan');
  const box = h('input', { type: 'checkbox', role: 'switch', id: `${id}-on` });
  const status = h('p', { role: 'status', 'aria-live': 'polite' });
  const code = h('p', { className: 'code', id: `${id}-code`, 'aria-label': 'Pairing code', hidden: true });
  const pair = h('button', { type: 'button', className: 'nk-btn primary', textContent: 'Make a pairing code' });
  const copy = h('button', { type: 'button', className: 'nk-btn', textContent: 'Copy code', hidden: true });
  const unpair = h('button', { type: 'button', className: 'nk-btn', textContent: 'Back to read only', hidden: true });

  function render() {
    const state = api?.state?.() ?? { available: false, on: false, code: null };
    box.checked = Boolean(state.on);
    box.disabled = !state.available;
    status.textContent = channelStatusText(state);
    code.hidden = !state.code;
    code.textContent = state.code ?? '';
    pair.hidden = !state.on;
    pair.textContent = state.code ? 'Make a new code' : 'Make a pairing code';
    copy.hidden = !state.code;
    unpair.hidden = !state.code;
  }

  box.addEventListener('change', () => { api?.set(box.checked); });
  pair.addEventListener('click', () => { api?.pair(true); });
  unpair.addEventListener('click', () => { api?.pair(false); });
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(api.state().code); status.textContent = 'Copied. Paste it into the other tab.'; } catch { status.textContent = 'Copy was refused. Select the code and copy it by hand.'; }
  });
  const off = api?.onChange?.(render);

  root.append(h('div', { className: 'nk-chan' },
    h('p', { textContent: 'The agent channel lets another tab or window of this site read NakliAmp, and with a pairing code control it. Every app on this site can use the channel once it is on, so turn it on only while you need it.' }),
    h('label', { className: 'switch', htmlFor: box.id }, box, 'Agent channel for this tab'),
    status,
    code,
    h('div', { className: 'row' }, pair, copy, unpair),
    h('p', { className: 'hint', textContent: 'The code lives only in this tab. It stops working when you make a new one, turn the channel off or close the tab. The other tab signs each command with it (HMAC-SHA256, docs/agent-face.md), so the code never crosses the channel.' })));
  render();
  return { update: render, destroy: () => { if (typeof off === 'function') off(); } };
}

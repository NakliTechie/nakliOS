/* Reel feature module: rung. Contract: docs/build/reel-v1-contract.md.
 * No DOM access at module top level, so Node can import COMMANDS for commands.json.
 *
 * The engine's software audio rung (AC-3, E-AC-3, DTS) asks before downloading any
 * decoder over the host's size threshold by calling config.requestDownload. This
 * module answers that call with a consent dialog, and tells the person when the
 * engine routes audio through the rung or refuses an audio track by name. */

export const COMMANDS = [];

export const STRINGS = {
  'rung.consent.title': 'Download an audio decoder?',
  'rung.consent.body': 'This file needs {name} to play its sound. It is a one-time download of {size} from this site, and it runs on your device.',
  'rung.consent.licence': 'Licence: {licence}',
  'rung.consent.accept': 'Download',
  'rung.consent.decline': 'Not now',
  'rung.size.mb': '{value} MB',
  'rung.route.software': 'Playing {codec} audio with the software decoder',
  'rung.route.softwareDetail': 'Your browser has no built-in decoder for this format, so Reel decodes it on this device.',
  'rung.refused': '{codec} audio cannot play here; the video plays without sound',
};

const STYLE = `
.rung-consent{max-width:min(28rem,calc(100vw - 32px));border:1px solid var(--line,#444);border-radius:10px;
  padding:20px;background:var(--panel,#1b1b1f);color:var(--text,#eee)}
.rung-consent::backdrop{background:rgba(0,0,0,.55)}
.rung-consent h2{margin:0 0 10px;font-size:1.05rem}
.rung-consent p{margin:0 0 10px;line-height:1.45}
.rung-consent .rung-licence{opacity:.8;font-size:.9em}
.rung-consent .rung-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.rung-consent button:focus-visible{outline:2px solid var(--accent,#7aa2ff);outline-offset:2px}
`;

function formatSize(t, bytes) {
  return t('rung.size.mb', { value: (bytes / (1024 * 1024)).toFixed(1) });
}

function createConsentDialog(ctx) {
  const { t } = ctx;
  let queue = Promise.resolve();

  function ask(info) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'rung-consent';
      dialog.setAttribute('aria-labelledby', 'rung-consent-title');
      dialog.setAttribute('aria-describedby', 'rung-consent-body');

      const heading = document.createElement('h2');
      heading.id = 'rung-consent-title';
      heading.textContent = t('rung.consent.title');
      const body = document.createElement('p');
      body.id = 'rung-consent-body';
      body.textContent = t('rung.consent.body', {
        name: String(info?.name || ''),
        size: formatSize(t, Number(info?.bytes) || 0),
      });
      const licence = document.createElement('p');
      licence.className = 'rung-licence';
      licence.textContent = t('rung.consent.licence', { licence: String(info?.licence || '') });

      const actions = document.createElement('div');
      actions.className = 'rung-actions';
      const decline = document.createElement('button');
      decline.type = 'button';
      decline.textContent = t('rung.consent.decline');
      decline.setAttribute('aria-label', t('rung.consent.decline'));
      const accept = document.createElement('button');
      accept.type = 'button';
      accept.textContent = t('rung.consent.accept');
      accept.setAttribute('aria-label', t('rung.consent.accept'));
      actions.append(decline, accept);
      dialog.append(heading, body, licence, actions);

      const previousFocus = document.activeElement;
      let settled = false;
      function finish(answer) {
        if (settled) return;
        settled = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true });
        resolve(answer);
      }
      accept.addEventListener('click', () => finish(true));
      decline.addEventListener('click', () => finish(false));
      // Escape cancels the dialog: treat it as a decline.
      dialog.addEventListener('cancel', event => {
        event.preventDefault();
        finish(false);
      });
      dialog.addEventListener('close', () => finish(false));
      // Keys stay inside the dialog, so the player's shortcuts do not fire behind it (V66). Escape
      // still cancels: the browser fires `cancel` from the default action, not from bubbling.
      dialog.addEventListener('keydown', event => event.stopPropagation());

      (ctx.mounts.dialogs || document.body).append(dialog);
      try {
        dialog.showModal();
      } catch (_) {
        dialog.setAttribute('open', '');
      }
      accept.focus();
    });
  }

  // One dialog at a time, in request order.
  return info => {
    const answer = queue.then(() => ask(info));
    queue = answer.catch(() => false);
    return answer;
  };
}

export function install(ctx) {
  ctx.addStyle(STYLE);
  const ask = createConsentDialog(ctx);
  // Development hook (?dev=1 only): checks open the consent dialog without a decoder download.
  try {
    if (new URLSearchParams(location.search).get('dev') === '1') globalThis.__reelRung = Object.freeze({ ask });
  } catch { /* no location */ }
  // CONFIG is the object the engine received; the engine reads this hook at call time.
  ctx.CONFIG.requestDownload = async info => (await ask(info)) === true;

  ctx.on('playback:audio-route', detail => {
    if (detail?.route !== 'software') return;
    const codec = String(detail.codec || '').toUpperCase();
    ctx.toast(ctx.t('rung.route.software', { codec }), 'info', ctx.t('rung.route.softwareDetail'));
  });
  ctx.on('playback:audio-refused', detail => {
    const codec = String(detail?.codec || '').toUpperCase();
    ctx.toast(ctx.t('rung.refused', { codec }), 'err', String(detail?.message || ''));
  });
}

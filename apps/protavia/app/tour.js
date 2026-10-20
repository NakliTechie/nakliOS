// A short guided tour, shown once on a first visit and re-openable from the header.
//
// The shape follows the tour in the slate app: a spotlight cut out of a dimmed overlay, a card
// beside it, and keyboard control. Steps whose target is not on screen are dropped rather than
// pointing at nothing, so the same list works before and after a structure is loaded.

const SEEN_KEY = 'protavia.v1.tour-seen';

const STEPS = [
  {
    target: '#starters',
    title: 'Start with a target',
    body: 'Two proteins are ready to open. Ubiquitin is small and fast, a good first run. ' +
      'Barnase and barstar is a real protein-protein interface, which is the shape binder design ' +
      'actually takes.',
  },
  {
    target: '#find',
    title: 'Or find your own',
    body: 'Type a protein name to search the Protein Data Bank, the public archive of solved ' +
      'structures. A four-character code like 1ubq opens straight away without searching.',
  },
  {
    target: '#drop',
    title: 'Your own files stay here',
    body: 'Drop a .pdb, .cif or .bcif file, gzipped or not. It is read inside this browser and ' +
      'never uploaded. Searching is the one action on this page that uses the network.',
  },
  {
    target: '#summary-wrap',
    title: 'Check what came in',
    body: 'Chains, how many residues each one has, the numbering range, and the sequence. ' +
      'Gaps in the range are real: they are residues the experiment could not resolve.',
  },
  {
    target: '#design-wrap',
    title: 'Redesign a chain',
    body: 'ProteinMPNN reads the backbone you loaded and proposes sequences that should fold into ' +
      'that same shape. It runs on this machine, on the graphics card when one is available.',
  },
  {
    target: '#design-results',
    title: 'Read the result',
    body: 'Each design shows how much of it matches the natural sequence. Positions that differ ' +
      'are picked out in bold, so the percentage is something you can check rather than trust. ' +
      'Around half is normal, and is evidence the model reads the fold.',
  },
];

let layer = null;
let steps = [];
let index = 0;
let previousFocus = null;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function isVisible(step) {
  const el = document.querySelector(step.target);
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 &&
    style.display !== 'none' && style.visibility !== 'hidden';
}

function currentTarget() {
  return document.querySelector(steps[index].target);
}

function position() {
  if (!layer) return;
  const target = currentTarget();
  if (!target) return;
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  const rect = target.getBoundingClientRect();
  const pad = 6;
  const spot = layer.querySelector('.tour-spotlight');
  spot.style.top = Math.max(4, rect.top - pad) + 'px';
  spot.style.left = Math.max(4, rect.left - pad) + 'px';
  spot.style.width = Math.max(24, Math.min(innerWidth - 8, rect.width + pad * 2)) + 'px';
  spot.style.height = Math.max(24, Math.min(innerHeight - 8, rect.height + pad * 2)) + 'px';

  const card = layer.querySelector('.tour-card');
  const box = card.getBoundingClientRect();
  const gap = 16;
  const margin = 12;
  let top;
  let left;

  if (rect.right + gap + box.width <= innerWidth - margin) {
    top = rect.top + rect.height / 2 - box.height / 2;
    left = rect.right + gap;
  } else if (rect.bottom + gap + box.height <= innerHeight - margin) {
    top = rect.bottom + gap;
    left = rect.left + rect.width / 2 - box.width / 2;
  } else if (rect.top - gap - box.height >= margin) {
    top = rect.top - gap - box.height;
    left = rect.left + rect.width / 2 - box.width / 2;
  } else {
    top = innerHeight - box.height - margin;
    left = innerWidth / 2 - box.width / 2;
  }

  card.style.top = clamp(top, margin, innerHeight - box.height - margin) + 'px';
  card.style.left = clamp(left, margin, innerWidth - box.width - margin) + 'px';
  card.style.visibility = 'visible';
}

function render() {
  if (!layer) return;
  const step = steps[index];
  layer.querySelector('.tour-progress').textContent = `Quick tour · ${index + 1} of ${steps.length}`;
  layer.querySelector('.tour-title').textContent = step.title;
  layer.querySelector('.tour-body').textContent = step.body;
  layer.querySelector('.tour-back').disabled = index === 0;
  layer.querySelector('.tour-next').textContent = index === steps.length - 1 ? 'Finish' : 'Next';
  layer.querySelector('.tour-card').style.visibility = 'hidden';
  requestAnimationFrame(() => {
    position();
    if (layer) layer.querySelector('.tour-next').focus();
  });
}

function close() {
  if (!layer) return;
  const old = layer;
  layer = null;
  window.removeEventListener('resize', position);
  document.removeEventListener('keydown', onKey, true);
  old.remove();
  if (previousFocus && previousFocus.isConnected) previousFocus.focus();
  previousFocus = null;
}

function finish() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private window, or blocked */ }
  close();
}

function next() {
  if (index < steps.length - 1) { index++; render(); } else finish();
}

function back() {
  if (index > 0) { index--; render(); }
}

function onKey(event) {
  if (!layer) return;
  event.stopPropagation();
  if (event.key === 'Escape') { event.preventDefault(); finish(); return; }
  if (event.key === 'ArrowRight') { event.preventDefault(); next(); return; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); back(); return; }
  if (event.key !== 'Tab') return;

  const controls = [...layer.querySelectorAll('button:not([disabled])')];
  if (controls.length === 0) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * @param {{force?: boolean}} options `force` shows it again after it has been seen.
 * @returns {boolean} whether the tour opened.
 */
export function show({ force = false } = {}) {
  if (layer) return false;
  if (!force) {
    try { if (localStorage.getItem(SEEN_KEY)) return false; } catch { /* treat as unseen */ }
  }

  steps = STEPS.filter(isVisible);
  if (steps.length === 0) return false;

  previousFocus = document.activeElement;
  index = 0;

  layer = document.createElement('div');
  layer.className = 'tour-layer';
  layer.innerHTML = `
    <div class="tour-spotlight" aria-hidden="true"></div>
    <section class="tour-card" role="dialog" aria-modal="true"
             aria-labelledby="tour-title" aria-describedby="tour-body">
      <p class="tour-progress"></p>
      <h2 class="tour-title" id="tour-title"></h2>
      <p class="tour-body" id="tour-body" aria-live="polite"></p>
      <div class="tour-actions">
        <button class="tour-skip" type="button">Skip</button>
        <span class="tour-spacer"></span>
        <button class="tour-back" type="button">Back</button>
        <button class="tour-next" type="button">Next</button>
      </div>
    </section>`;
  document.body.append(layer);

  layer.querySelector('.tour-skip').addEventListener('click', finish);
  layer.querySelector('.tour-back').addEventListener('click', back);
  layer.querySelector('.tour-next').addEventListener('click', next);
  window.addEventListener('resize', position);
  document.addEventListener('keydown', onKey, true);

  render();
  return true;
}

/** True when this browser has never been shown the tour. */
export function unseen() {
  try { return !localStorage.getItem(SEEN_KEY); } catch { return true; }
}

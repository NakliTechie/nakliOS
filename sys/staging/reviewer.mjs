// Staging — THE reviewer component (handoff P0.4). One component renders any
// app's staged diff, because it only ever sees the normalized shape the app's
// registered diff type produced (`{kind, summary, rows}` — see diff-types.mjs).
// It has no per-app branch and never imports an app. Feeding it a Reckon
// cell-range envelope and a Draft prosemirror-steps envelope is the M0 vector
// (plan/p0-protocol-spec.md:160).
//
// Split in two on purpose, because the spec calls the CONTRACT the testable seam
// and the visual attended (p0-protocol-spec.md:157):
//   buildReviewModel(envelope, ctx) -> a pure view model      (node-testable)
//   renderReview(model, {doc, ...}) -> DOM                    (document injected)
// The DOM half touches only createElement / textContent / className /
// setAttribute / appendChild, so a ~40-line fake document exercises it headless.
//
// Commit authority is NOT re-implemented here: the model asks decideCommit and
// renders its verdict. A denial is rendered LOUD (the reason is on screen, the
// button is disabled and says why) rather than silently hiding the control —
// an invisible refusal teaches the person nothing.

import { normalizeEnvelope, decideCommit, isExpired } from './envelope.mjs';
import { toolVerb } from './diff-types.mjs';

// Build the pure view model for one staged proposal.
// `ctx` = { actor:'person'|'agent', grant?, reversible?, now?, appName?, appOpen? } — the
// shape decideCommit takes, plus `now` for expiry, the app's catalog name for the heading
// (falls back to the app id), and whether the app's window is open (for the Show/Open control).
export function buildReviewModel(envelope, ctx = {}) {
  const normalized = normalizeEnvelope(envelope); // throws if the app never registered — a proposal is never un-renderable
  const now = ctx.now ?? Date.now();
  const expired = isExpired(envelope, now);
  const decision = decideCommit({ actor: ctx.actor, tool: envelope.tool, reversible: ctx.reversible, grant: ctx.grant });

  // Expiry outranks authority: a stale proposal is not committable even by a
  // person, because the state it was computed against has moved on.
  const committable = !expired && decision.allowed;
  const blockedReason = expired ? 'proposal expired — re-stage against current state' : (decision.allowed ? '' : decision.reason);

  const appName = typeof ctx.appName === 'string' && ctx.appName.trim() ? ctx.appName.trim() : envelope.app;
  return {
    proposalId: envelope.proposal_id,
    app: envelope.app,
    appName,
    appOpen: ctx.appOpen !== false,
    // The plain verb is what the person reads; the tool id stays in the model for History only.
    verb: toolVerb(envelope.tool),
    tool: envelope.tool,
    renderer: envelope.preview_renderer,
    kind: normalized.kind,
    summary: normalized.summary ?? '',
    rows: Array.isArray(normalized.rows) ? normalized.rows : [],
    expires: envelope.expires ?? null,
    expired,
    decision,
    committable,
    blockedReason,
  };
}

// ------------------------------------------------------------------- DOM ----

const CHANGE_LABEL = { add: 'added', remove: 'removed', edit: 'changed' };

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

// Render one proposal card. `onCommit(model)` / `onDiscard(model)` are optional;
// with neither, the card is a read-only preview (what a History replay shows).
// `onShowApp(model)`, when given, adds a control that shows the app's window
// ("Show Reckon") or, when the app is closed, opens it ("Open Reckon").
export function renderReview(model, { doc, onCommit, onDiscard, onShowApp } = {}) {
  if (!doc) throw new Error('renderReview needs a document (inject it — the reviewer is realm-agnostic)');

  const card = el(doc, 'article', 'nk-rev');
  card.setAttribute('data-app', model.app);
  card.setAttribute('data-proposal', model.proposalId);
  // The card names itself for assistive tech; without this a queue of cards is
  // an undifferentiated list of "article".
  // Plain words only: the app's name and a verb, never the internal tool id (Reckon review B20).
  const appName = model.appName || model.app;
  const verb = model.verb || 'wants to make a change';
  card.setAttribute('aria-label', `${appName} ${verb}`);

  const head = el(doc, 'header', 'nk-rev-head');
  head.appendChild(el(doc, 'span', 'nk-rev-app', appName));
  head.appendChild(el(doc, 'span', 'nk-rev-verb', verb));
  head.appendChild(el(doc, 'span', 'nk-rev-summary', model.summary));
  if (model.expired) head.appendChild(el(doc, 'span', 'nk-rev-flag nk-rev-expired', 'expired'));
  card.appendChild(head);

  // The diff table. Tabular before/after IS a table — a11y gets scope'd headers
  // and a caption instead of a div grid.
  const table = el(doc, 'table', 'nk-rev-diff');
  // The header already shows the summary; a second visible copy here read as a duplicate on the card
  // (Reckon promo capture, 2026-11-17). Keep the caption for the table's accessible name, visually hidden.
  const caption = el(doc, 'caption', 'nk-rev-sr', `Changes from ${appName}`);
  table.appendChild(caption);
  const thead = el(doc, 'thead');
  const hrow = el(doc, 'tr');
  for (const h of ['Where', 'Before', 'After']) {
    const th = el(doc, 'th', null, h);
    th.setAttribute('scope', 'col');
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = el(doc, 'tbody');
  for (const row of model.rows) {
    const tr = el(doc, 'tr', `nk-rev-row nk-rev-${row.change}`);
    tr.setAttribute('data-change', row.change);
    const th = el(doc, 'th', 'nk-rev-where', row.label);
    th.setAttribute('scope', 'row');
    tr.appendChild(th);
    tr.appendChild(el(doc, 'td', 'nk-rev-before', row.before));
    tr.appendChild(el(doc, 'td', 'nk-rev-after', row.after));
    // Colour alone must not carry the add/remove/edit distinction.
    const sr = el(doc, 'span', 'nk-sr', CHANGE_LABEL[row.change] || row.change);
    tr.appendChild(sr);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  card.appendChild(table);

  const foot = el(doc, 'footer', 'nk-rev-foot');
  const reasonId = `nk-rev-why-${model.proposalId}`;
  if (!model.committable) {
    const why = el(doc, 'p', 'nk-rev-why', model.blockedReason);
    why.setAttribute('id', reasonId);
    why.setAttribute('role', 'status'); // the refusal is announced, not just drawn
    foot.appendChild(why);
  }

  const commit = el(doc, 'button', 'nk-rev-commit', model.committable ? 'Commit' : 'Commit (blocked)');
  commit.setAttribute('type', 'button');
  if (!model.committable) {
    commit.setAttribute('disabled', 'disabled');
    commit.setAttribute('aria-describedby', reasonId);
  } else if (typeof onCommit === 'function') {
    commit.addEventListener?.('click', () => onCommit(model));
  }
  foot.appendChild(commit);

  const discard = el(doc, 'button', 'nk-rev-discard', 'Discard');
  discard.setAttribute('type', 'button');
  if (typeof onDiscard === 'function') discard.addEventListener?.('click', () => onDiscard(model));
  foot.appendChild(discard);

  if (typeof onShowApp === 'function') {
    const show = el(doc, 'button', 'nk-rev-show', `${model.appOpen === false ? 'Open' : 'Show'} ${appName}`);
    show.setAttribute('type', 'button');
    show.addEventListener?.('click', () => onShowApp(model));
    foot.appendChild(show);
  }

  card.appendChild(foot);
  return card;
}

// The one reviewer over many apps: N envelopes (any mix of apps) -> one element.
// `ctx` may be a single context or a function (envelope) -> ctx, so a queue can
// carry a different grant per proposal.
export function renderReviewQueue(envelopes, ctx = {}, { doc, onCommit, onDiscard, onShowApp } = {}) {
  if (!doc) throw new Error('renderReviewQueue needs a document');
  const list = el(doc, 'section', 'nk-rev-queue');
  list.setAttribute('aria-label', 'Staged proposals');
  const models = [];
  for (const env of envelopes) {
    const model = buildReviewModel(env, typeof ctx === 'function' ? ctx(env) : ctx);
    models.push(model);
    list.appendChild(renderReview(model, { doc, onCommit, onDiscard, onShowApp }));
  }
  return { element: list, models };
}

// Follow-ups for NakliOS: dated promises in both directions, gathered from Mail through its commands and from what the
// person types, closed by a later reply in the thread or by the person. Every date comes from Emergic's rules
// (sys/emergic-rules), never from a model. This module is pure: the page passes in the rules, the clock and the data.
//
// A follow-up: { key, direction: 'i_owe' | 'owed_to_me', who, what, due: 'YYYY-MM-DD' | null, inferred,
//   source: { kind: 'mail' | 'typed', id?, threadId?, subject?, from?, at }, status, closedBy?, closedAt?, addedAt }
// status: 'open' | 'done' | 'dropped' | 'replied' | 'answered' (the last two set by a reply in the thread).

export const OPEN = 'open';
export const CLOSED = Object.freeze(['done', 'dropped', 'replied', 'answered']);

const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

// One key per promise per message, so a second scan of the same mail adds nothing.
export function keyOf(source, promise) {
  const where = source.kind === 'mail' ? `mail:${source.id}` : `typed:${source.at}`;
  return `${where}:${promise.direction}:${norm(promise.what).toLowerCase().slice(0, 80)}`;
}

// What mail.read answered → follow-ups (open). Mail found the promises with Emergic's rules.
export function fromMail(read, now) {
  const source = { kind: 'mail', id: String(read.id), threadId: String(read.threadId || ''), subject: norm(read.subject),
    from: norm(read.from), at: Date.parse(read.date) || now };
  return (read.promises || []).filter(p => p && (p.direction === 'i_owe' || p.direction === 'owed_to_me') && p.what)
    .map(p => ({ key: keyOf(source, p), direction: p.direction, who: norm(p.who), what: norm(p.what).slice(0, 200),
      due: p.due || null, inferred: !!p.inferred, source, status: OPEN, addedAt: now }));
}

// A follow-up the person types ("Send Ravi the PO by Friday"). The day comes from the rules, counted from today; with
// no time words it has no date. `owed` marks one someone else owes the person.
export function typed(text, { today, now, rules, owed = false, who = '' }) {
  const what = norm(text).slice(0, 200);
  if (!what) throw Object.assign(new Error('Write what the follow-up is.'), { code: 'EINVAL' });
  const found = rules.hasTimeWords(what) ? rules.due(what, today) : null;
  const direction = owed ? 'owed_to_me' : 'i_owe';
  const source = { kind: 'typed', at: now };
  return { key: keyOf(source, { direction, what }), direction, who: norm(who), what, due: found ? found.due : null,
    inferred: found ? !!found.inferred : false, source, status: OPEN, addedAt: now };
}

// New follow-ups join the store; ones already there keep their status (a closed one stays closed).
export function merge(store, incoming) {
  const out = new Map(store.map(f => [f.key, f]));
  let added = 0;
  for (const f of incoming) if (!out.has(f.key)) { out.set(f.key, f); added++; }
  return { items: [...out.values()], added };
}

// A later message in the same thread may close open follow-ups from that thread (Emergic's `closes`).
// reply: what mail.read answered for the later message; me: the mailbox's own address.
export function applyReply(items, reply, me, rules, now) {
  const at = Date.parse(reply.date) || 0;
  let closed = 0;
  const out = items.map(f => {
    if (f.status !== OPEN || f.source.kind !== 'mail' || !f.source.threadId || f.source.threadId !== String(reply.threadId || '')) return f;
    if (f.source.id === String(reply.id) || at <= f.source.at || !f.due) return f;
    const how = rules.closes({ direction: f.direction, who: f.who, what: f.what, due: f.due, inferred: f.inferred },
      { from: String(reply.from || ''), body: String(reply.text || ''), draft: false }, me);
    if (!how) return f;
    closed++;
    return { ...f, status: how, closedBy: { kind: 'mail', id: String(reply.id), from: norm(reply.from) }, closedAt: now };
  });
  return { items: out, closed };
}

// The person closes or reopens one. `word` may be the person's own word ("done", "drop it"), read by the rules.
export function setStatus(items, key, how, { rules, now }) {
  let status = how;
  if (how !== OPEN && !CLOSED.includes(how)) status = rules.closedFromWord(String(how || ''));
  if (!status) throw Object.assign(new Error(`"${how}" is not done, dropped or open.`), { code: 'EINVAL' });
  let hit = false;
  const out = items.map(f => {
    if (f.key !== key) return f;
    hit = true;
    return status === OPEN ? { ...f, status: OPEN, closedBy: undefined, closedAt: undefined }
      : { ...f, status, closedBy: { kind: 'person' }, closedAt: now };
  });
  if (!hit) throw Object.assign(new Error('No follow-up has that key.'), { code: 'ENOENT' });
  return out;
}

// Open follow-ups by when they are due, against today in the person's own zone.
export function buckets(items, today) {
  const open = items.filter(f => f.status === OPEN);
  const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.addedAt - b.addedAt;
  return {
    overdue: open.filter(f => f.due && f.due < today).sort(byDue),
    today: open.filter(f => f.due === today).sort(byDue),
    upcoming: open.filter(f => f.due && f.due > today).sort(byDue),
    undated: open.filter(f => !f.due).sort(byDue),
    closed: items.filter(f => f.status !== OPEN).sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)),
  };
}

const whoShort = who => (/^(.*?)\s*</.exec(who || '')?.[1] || who || '').replace(/"/g, '').trim();
export function line(f) {
  const who = whoShort(f.who);
  return f.direction === 'i_owe' ? `You owe${who ? ` ${who}` : ''}: ${f.what}` : `${who || 'Someone'} owes you: ${f.what}`;
}

// The desktop card: what is due today or late.
export function dueCard(items, today) {
  const b = buckets(items, today);
  const due = [...b.overdue, ...b.today];
  return { heading: due.length ? `${due.length} due${b.overdue.length ? `, ${b.overdue.length} late` : ''}` : 'Nothing due',
    items: due.slice(0, 6).map(f => `${f.due < today ? 'Late · ' : ''}${line(f)}`), empty: 'Nothing due today' };
}

// The day for a moment in the person's zone ('YYYY-MM-DD').
export function localDay(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// What a command returns for one follow-up.
export const view = f => ({ key: f.key, direction: f.direction, who: f.who, what: f.what, due: f.due, inferred: f.inferred,
  status: f.status, from: f.source.kind === 'mail' ? { messageId: f.source.id, subject: f.source.subject } : 'typed' });

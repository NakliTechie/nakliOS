// Gmail in the NakliOS Mail app (apps/mail/gmail.js): mapping Gmail's message shape, walking MIME parts,
// the client's search, read, mark-read and one retry on 401, and the page and command wiring. No network:
// fetch is a fake. B4 in plan/2026-11-22-emergic-on-naklios-workplan.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const context = vm.createContext({ Intl, Date, Math, URLSearchParams, JSON, TextDecoder, Uint8Array, atob, String, Number, Array, Promise });
vm.runInContext(await readFile(new URL('apps/mail/gmail.js', root), 'utf8'), context);
const G = context.MailGmail;
const plain = v => JSON.parse(JSON.stringify(v));
const b64url = s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const message = {
  id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], internalDate: String(Date.parse('2026-11-23T04:30:00Z')),
  snippet: 'Will send the revised quote by Friday &amp; the PO',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [{ name: 'From', value: 'Ravi Kumar <Ravi@Vendor.in>' }, { name: 'To', value: '"Patnaik, Chirag" <chirag@atrium.in>, ops@atrium.in' },
      { name: 'Subject', value: 'Quote' }, { name: 'Cc', value: 'a@b.in' }, { name: 'Reply-To', value: 'sales@vendor.in' }],
    parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', body: { data: b64url('Hi Chirag,\nWill send the revised quote by Friday. ₹48,200 🙏\n') } },
        { mimeType: 'text/html', body: { data: b64url('<p>Hi Chirag,</p><p>Will send the revised quote by <b>Friday</b>.</p>') } },
      ] },
      { mimeType: 'application/pdf', filename: 'quote.pdf', body: { attachmentId: 'a1', size: 2048 } },
    ],
  },
};

test('base64url decodes UTF-8 text, including non-Latin and emoji', () => {
  assert.equal(G.decodeBase64Url(b64url('₹ नमस्ते 🙏')), '₹ नमस्ते 🙏');
  assert.equal(G.decodeBase64Url(''), '');
});

test('people split on commas outside quoted names; person reads name and lower-case address', () => {
  assert.deepEqual(plain(G.people('"Patnaik, Chirag" <chirag@atrium.in>, ops@atrium.in')), ['"Patnaik, Chirag" <chirag@atrium.in>', 'ops@atrium.in']);
  assert.deepEqual(plain(G.person('Ravi Kumar <Ravi@Vendor.in>')), { name: 'Ravi Kumar', address: 'ravi@vendor.in' });
  assert.deepEqual(plain(G.person('ops@atrium.in')), { name: '', address: 'ops@atrium.in' });
});

test('summary: headers, unread, date and a decoded snippet', () => {
  const s = plain(G.summary(message));
  assert.equal(s.id, 'm1');
  assert.equal(s.from, 'Ravi Kumar <Ravi@Vendor.in>');
  assert.deepEqual(s.to, ['"Patnaik, Chirag" <chirag@atrium.in>', 'ops@atrium.in']);
  assert.equal(s.subject, 'Quote');
  assert.equal(s.unread, true);
  assert.equal(s.date, Date.parse('2026-11-23T04:30:00Z'));
  assert.equal(s.snippet, 'Will send the revised quote by Friday & the PO');
  assert.equal(G.summary({ id: 'x', payload: { headers: [] } }).subject, '(no subject)');
});

test('full: the plain part wins, the HTML part is kept for the sandboxed view, attachments are listed', () => {
  const f = plain(G.full(message));
  assert.match(f.text, /Will send the revised quote by Friday\. ₹48,200 🙏/);
  assert.match(f.html, /<b>Friday<\/b>/);
  assert.deepEqual(f.attachments, [{ name: 'quote.pdf', type: 'application/pdf', size: 2048 }]);
  assert.deepEqual(f.cc, ['a@b.in']);
  assert.equal(f.replyTo, 'sales@vendor.in');
});

test('an HTML-only message is read as text with scripts and styles dropped', () => {
  const htmlOnly = { id: 'h', payload: { mimeType: 'text/html', headers: [], body: { data: b64url('<style>p{}</style><script>alert(1)</script><p>Line one</p><p>Pay by 20th&nbsp;Oct</p>') } } };
  const f = G.full(htmlOnly);
  assert.equal(f.text, 'Line one\nPay by 20th Oct');
  assert.doesNotMatch(f.text, /alert|p\{\}/);
});

test('localDay gives the day the mail was sent in the person\'s zone', () => {
  const ms = Date.parse('2026-11-22T20:00:00Z');
  assert.equal(G.localDay(ms, 'Asia/Kolkata'), '2026-11-23');
  assert.equal(G.localDay(ms, 'UTC'), '2026-11-22');
});

function fakeFetch(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization, body: init.body });
    const r = routes(url, init, calls.length);
    return { status: r.status ?? 200, ok: (r.status ?? 200) < 400, text: async () => (r.json === undefined ? '' : JSON.stringify(r.json)) };
  };
  return { fetchFn, calls };
}

test('search lists ids for the query, then fetches each message\'s headers', async () => {
  const { fetchFn, calls } = fakeFetch(url => url.includes('/messages?')
    ? { json: { messages: [{ id: 'm1' }, { id: 'm2' }], resultSizeEstimate: 42 } }
    : { json: { ...message, id: url.includes('/m2?') ? 'm2' : 'm1' } });
  const client = G.createClient({ getToken: async () => 't1', fetchFn });
  const out = await client.search('from:ravi is:unread', 5);
  assert.deepEqual(plain(out.messages.map(m => m.id)), ['m1', 'm2']);
  assert.equal(out.estimate, 42);
  assert.match(calls[0].url, /q=from%3Aravi\+is%3Aunread/);
  assert.match(calls[0].url, /maxResults=5/);
  assert.match(calls[1].url, /format=metadata/);
  assert.match(calls[1].url, /metadataHeaders=Subject/);
  assert.equal(calls[0].auth, 'Bearer t1');
});

test('one retry with a fresh token on 401; a refusal reports Google\'s message', async () => {
  const fresh = [];
  const { fetchFn, calls } = fakeFetch((url, init, n) => n === 1 ? { status: 401, json: { error: { message: 'expired' } } } : { json: message });
  const client = G.createClient({ getToken: async ({ fresh: f }) => { fresh.push(f); return f ? 't2' : 't1'; }, fetchFn });
  const msg = await client.read('m1');
  assert.equal(msg.subject, 'Quote');
  assert.deepEqual(fresh, [false, true]);
  assert.deepEqual(calls.map(c => c.auth), ['Bearer t1', 'Bearer t2']);
  const bad = G.createClient({ getToken: async () => 't', fetchFn: fakeFetch(() => ({ status: 403, json: { error: { message: 'Insufficient Permission' } } })).fetchFn });
  await assert.rejects(bad.read('m1'), /403: Insufficient Permission/);
});

test('markRead removes only the UNREAD label; unreadCount reads the inbox label', async () => {
  const { fetchFn, calls } = fakeFetch(url => url.endsWith('/labels/INBOX') ? { json: { messagesUnread: 7 } } : { json: {} });
  const client = G.createClient({ getToken: async () => 't', fetchFn });
  await client.markRead('m/1');
  assert.match(calls[0].url, /messages\/m%2F1\/modify$/);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { removeLabelIds: ['UNREAD'] });
  assert.equal(await client.unreadCount(), 7);
});

test('wiring: the page asks only gmail.modify, shows HTML only in a sandboxed frame, and the commands never mark mail read', async () => {
  const html = await readFile(new URL('apps/mail/index.html', root), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('apps/mail/commands.json', root), 'utf8'));
  const host = await readFile(new URL('index.html', root), 'utf8');
  assert.deepEqual([...G.SCOPES], ['gmail.modify']);
  assert.match(html, /<script src="gmail\.js"><\/script>/);
  assert.match(html, /setAttribute\('sandbox',''\)/);
  assert.match(html, /default-src 'none'; img-src data:/);
  assert.match(html, /import\('\.\.\/\.\.\/sys\/emergic-rules\/rules\.mjs'\)/);
  assert.deepEqual(manifest.commands.map(c => c.name), ['mail.search', 'mail.read', 'mail.unread']);
  const handlers = html.slice(html.indexOf('const COMMAND_HANDLERS={'), html.indexOf('if(naklios.experimental_commands)'));
  assert.ok(handlers.length > 100, 'the command handlers were found');
  assert.doesNotMatch(handlers, /markRead/);
  assert.match(host, /\{ id:'mail', name:'Mail', kind:'system',/);
});

// Gmail for the NakliOS Mail app: turning Gmail's message shape into Mail's, and a small client for the
// person's own mailbox. The token comes from the host (naklios.experimental_auth, scope gmail.modify);
// requests go from this browser straight to Google. Nothing passes through a NakliTechie server.
(function (root) {
  'use strict';

  const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const SCOPES = Object.freeze(['gmail.modify']);
  const LIST_HEADERS = Object.freeze(['From', 'To', 'Subject', 'Date']);

  // base64url (Gmail's body encoding) → UTF-8 text.
  function decodeBase64Url(data) {
    if (!data) return '';
    const b64 = String(data).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  function header(headers, name) {
    const key = name.toLowerCase();
    const row = (headers || []).find(h => String(h.name).toLowerCase() === key);
    return row ? String(row.value) : '';
  }

  // "Ravi Kumar <ravi@vendor.in>" → { name: 'Ravi Kumar', address: 'ravi@vendor.in' }.
  function person(value) {
    const text = String(value || '').trim();
    const m = /^(.*?)<([^>]+)>\s*$/.exec(text);
    if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim().toLowerCase() };
    return { name: '', address: text.toLowerCase() };
  }

  // Comma-separated recipients, ignoring commas inside quoted display names.
  function people(value) {
    const out = [];
    let cur = '', quoted = false;
    for (const ch of String(value || '')) {
      if (ch === '"') quoted = !quoted;
      if (ch === ',' && !quoted) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // Walk a MIME tree; collect the first text/plain and text/html parts, and attachment names.
  function walk(part, found) {
    if (!part) return found;
    const type = String(part.mimeType || '').toLowerCase();
    const name = part.filename || '';
    if (name && part.body && (part.body.attachmentId || part.body.size)) {
      found.attachments.push({ name, type, size: Number(part.body.size) || 0 });
    } else if (type === 'text/plain' && found.text == null && part.body?.data) {
      found.text = decodeBase64Url(part.body.data);
    } else if (type === 'text/html' && found.html == null && part.body?.data) {
      found.html = decodeBase64Url(part.body.data);
    }
    for (const child of part.parts || []) walk(child, found);
    return found;
  }

  // HTML → readable plain text, for the promise rules and for commands (never for display).
  function htmlToText(html) {
    return String(html || '')
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // A Gmail message (format=metadata or full) → Mail's summary row.
  function summary(item) {
    const headers = item?.payload?.headers || [];
    const labels = item.labelIds || [];
    return {
      id: String(item.id), threadId: String(item.threadId || ''),
      from: header(headers, 'From'), to: people(header(headers, 'To')),
      subject: header(headers, 'Subject') || '(no subject)',
      date: Number(item.internalDate) || Date.parse(header(headers, 'Date')) || 0,
      snippet: decodeEntities(String(item.snippet || '')),
      unread: labels.includes('UNREAD'), labels,
    };
  }

  function decodeEntities(text) {
    return text.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  // A Gmail message (format=full) → Mail's full message: the summary plus text, html and attachments.
  function full(item) {
    const found = walk(item.payload, { text: null, html: null, attachments: [] });
    const base = summary(item);
    const headers = item?.payload?.headers || [];
    return { ...base, cc: people(header(headers, 'Cc')), replyTo: header(headers, 'Reply-To'),
      text: found.text != null ? found.text : htmlToText(found.html), html: found.html, attachments: found.attachments };
  }

  // The day a message was sent, in the person's own zone ('YYYY-MM-DD'), for the deadline rules.
  function localDay(ms, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    const get = t => parts.find(p => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  // getToken({ fresh }) → access token; fetchFn defaults to fetch. One retry with a fresh token on 401.
  function createClient({ getToken, fetchFn = (...a) => fetch(...a), concurrency = 6 }) {
    async function call(path, init = {}) {
      const url = path.startsWith('http') ? path : API + path;
      let token = await getToken({ fresh: false });
      let res = await fetchFn(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
      if (res.status === 401) {
        token = await getToken({ fresh: true });
        res = await fetchFn(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
      }
      if (res.status === 204) return null;
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) throw Object.assign(new Error(`Gmail answered ${res.status}: ${json?.error?.message || 'request failed'}`), { status: res.status });
      return json;
    }
    async function each(ids, fn) {
      const out = new Array(ids.length);
      let next = 0;
      const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
        while (next < ids.length) { const i = next++; out[i] = await fn(ids[i]); }
      });
      await Promise.all(workers);
      return out;
    }
    return {
      profile: () => call('/profile'),
      // Message summaries matching a Gmail search ("in:inbox", "is:unread from:ravi"), newest first.
      async search(query, max = 25) {
        const q = new URLSearchParams({ q: String(query || 'in:inbox'), maxResults: String(Math.max(1, Math.min(100, max))) });
        const page = await call(`/messages?${q}`);
        const ids = (page?.messages || []).map(m => m.id);
        const meta = new URLSearchParams({ format: 'metadata' });
        for (const h of LIST_HEADERS) meta.append('metadataHeaders', h);
        const items = await each(ids, id => call(`/messages/${encodeURIComponent(id)}?${meta}`));
        return { messages: items.map(summary), estimate: Number(page?.resultSizeEstimate) || ids.length };
      },
      read: async id => full(await call(`/messages/${encodeURIComponent(id)}?format=full`)),
      // Opening a message in Mail marks it read, as Gmail does. Commands never do.
      markRead: id => call(`/messages/${encodeURIComponent(id)}/modify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ removeLabelIds: ['UNREAD'] }) }),
      unreadCount: async () => Number((await call('/labels/INBOX'))?.messagesUnread) || 0,
    };
  }

  root.MailGmail = Object.freeze({ SCOPES, decodeBase64Url, person, people, summary, full, htmlToText, localDay, createClient });
})(typeof window === 'undefined' ? globalThis : window);

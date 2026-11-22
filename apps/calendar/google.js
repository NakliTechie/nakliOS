// Google Calendar for the NakliOS Calendar: mapping between Google's event shape and Calendar's, and a small client
// for the person's primary calendar. The token comes from the host (naklios.experimental_auth, scope calendar.events);
// requests go from this browser straight to Google, and nothing is stored here except what Calendar caches itself.
(function (root) {
  'use strict';

  const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const SCOPES = Object.freeze(['calendar.events']);

  // Google dateTime ("2026-11-23T15:00:00+05:30") → wall time "2026-11-23T15:00" in zone.
  function wallIn(dateTime, zone, Core) {
    return Core.utcToWall(new Date(dateTime).toISOString(), zone);
  }

  // A Google event (singleEvents=true, so every instance arrives on its own) → a Calendar event. Ids carry a "g:"
  // prefix so they can never collide with local ids, and `source` marks where edits must go.
  function fromGoogle(item, defaultZone, Core) {
    if (!item || item.status === 'cancelled' || !item.start) return null;
    const allDay = !!item.start.date;
    const zone = item.start.timeZone || defaultZone;
    const startLocal = allDay ? item.start.date : wallIn(item.start.dateTime, zone, Core);
    const endLocal = allDay ? (item.end?.date || item.start.date) : wallIn(item.end?.dateTime || item.start.dateTime, zone, Core);
    return {
      id: 'g:' + item.id, googleId: item.id, source: 'google', recurringEventId: item.recurringEventId || null,
      title: String(item.summary || '(no title)').slice(0, 180), description: String(item.description || ''),
      location: String(item.location || ''), startLocal, endLocal, allDay, timeZone: zone,
      recurrence: { frequency: 'none', interval: 1, until: null },
      htmlLink: item.htmlLink || '', etag: item.etag || '',
      createdAt: Date.parse(item.created || '') || 0, updatedAt: Date.parse(item.updated || '') || 0,
    };
  }

  // A Calendar event → the body Google's insert and patch take. A repeating local rule becomes an RRULE.
  function toGoogle(event) {
    const body = { summary: event.title, description: event.description || '', location: event.location || '' };
    if (event.allDay) {
      body.start = { date: String(event.startLocal).slice(0, 10) };
      body.end = { date: String(event.endLocal).slice(0, 10) };
    } else {
      body.start = { dateTime: `${event.startLocal}:00`, timeZone: event.timeZone };
      body.end = { dateTime: `${event.endLocal}:00`, timeZone: event.timeZone };
    }
    const r = event.recurrence || {};
    if (!event.recurringEventId && r.frequency && r.frequency !== 'none') {
      let rule = `RRULE:FREQ=${r.frequency.toUpperCase()}`;
      if (Number(r.interval) > 1) rule += `;INTERVAL=${Number(r.interval)}`;
      if (r.until) rule += `;UNTIL=${String(r.until).replace(/-/g, '')}T235959Z`;
      body.recurrence = [rule];
    }
    return body;
  }

  // getToken({ fresh }) → access token; fetchFn defaults to fetch. One retry with a fresh token on 401.
  function createClient({ getToken, fetchFn = (...a) => fetch(...a) }) {
    async function call(url, init = {}) {
      let token = await getToken({ fresh: false });
      let res = await fetchFn(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
      if (res.status === 401) {
        token = await getToken({ fresh: true });
        res = await fetchFn(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
      }
      if (res.status === 204) return null;
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(`Google Calendar answered ${res.status}: ${json?.error?.message || 'request failed'}`);
      return json;
    }
    return {
      // Every event instance overlapping [startMs, endMs), across pages (capped at 2,500 to bound a bad range).
      async list(startMs, endMs) {
        const out = [];
        let pageToken = '';
        do {
          const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
            timeMin: new Date(startMs).toISOString(), timeMax: new Date(endMs).toISOString() });
          if (pageToken) q.set('pageToken', pageToken);
          const page = await call(`${API}?${q}`);
          out.push(...(page?.items || []));
          pageToken = page?.nextPageToken || '';
        } while (pageToken && out.length < 2500);
        return out;
      },
      insert: event => call(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toGoogle(event)) }),
      patch: (googleId, event) => call(`${API}/${encodeURIComponent(googleId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toGoogle(event)) }),
      remove: googleId => call(`${API}/${encodeURIComponent(googleId)}`, { method: 'DELETE' }),
    };
  }

  root.CalendarGoogle = Object.freeze({ SCOPES, fromGoogle, toGoogle, createClient });
})(typeof window === 'undefined' ? globalThis : window);

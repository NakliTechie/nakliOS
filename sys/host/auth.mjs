// auth.mjs — sign-in to outside accounts for apps (naklios.experimental_auth). First provider: Google.
//
// The host, not the app, runs Google Identity Services' token flow in its own window, so one OAuth client
// (origin naklios.dev) serves every app. An app asks for named scopes; the person allows that app once per
// scope set (a Grant, like naklios.net's per-host Grant); the host asks Google for a token covering exactly
// that scope set and hands the app the access token. Google's browser flow gives one-hour access tokens and
// no refresh token, so nothing long-lived exists to steal. Tokens live in this module's memory only and are
// never written to storage or History. History records the app, provider, scopes and outcome.
//
// Exact scope sets matter: a token for A∪B handed to an app allowed only A would leak B, so tokens are
// requested and cached per sorted scope set, without include_granted_scopes.
//
// deps:
//   authorize(appId, provider, scopeKey, describe) → grant id; throws { code:'ENOGRANT' } when the person declines
//   requestToken(provider, scopes, { hint }) → { accessToken, expiresIn, grantedScopes: string[] }
//       throws { code:'EPOPUP' } when the browser blocked Google's window (no recent click),
//       { code:'ECANCELLED' } when the person closed it, any other error for a Google failure
//   continueSignIn(appName, provider) → true when the person clicks through a host dialog, which gives the
//       window the click it needs to open Google's popup
//   record(event) → appends one History event { appId, provider, scopes, outcome }
//   revokeToken(provider, accessToken) → asks the provider to revoke one token (best effort)
//   appName(appId) → display name
//   now() → ms clock (injectable)

export const GOOGLE_SCOPE_BASE = 'https://www.googleapis.com/auth/';

// The scopes an app may ask for, each with the words the person sees. A scope missing here is refused, so the
// consent text can never be vaguer than what Google will grant.
export const GOOGLE_SCOPES = Object.freeze({
  'gmail.modify': 'read, send, label and delete your Gmail',
  'gmail.readonly': 'read your Gmail',
  'gmail.send': 'send mail as you from Gmail',
  'gmail.compose': 'write Gmail drafts and send them',
  'gmail.labels': 'see and edit your Gmail labels',
  'calendar.events': 'see and edit events in your Google calendars',
  'calendar.readonly': 'see your Google calendars and events',
  'calendar.calendarlist.readonly': 'see the list of your Google calendars',
  'openid': 'know your Google account',
  'email': 'see your email address',
  'profile': 'see your name and photo',
});

export const PROVIDERS = Object.freeze(['google']);
const REUSE_MARGIN_MS = 60_000; // a cached token is handed out only with at least a minute left

function err(code, message) { return Object.assign(new Error(message), { code }); }

// 'gmail.modify' or the full URL → the short name; refuses anything not in GOOGLE_SCOPES.
export function normaliseScopes(provider, scopes) {
  if (!PROVIDERS.includes(provider)) throw err('EINVAL', `Unknown sign-in provider "${provider}"; known: ${PROVIDERS.join(', ')}`);
  const list = Array.isArray(scopes) ? scopes : scopes == null ? [] : [scopes];
  if (!list.length) throw err('EINVAL', 'Ask for at least one scope');
  const out = new Set();
  for (const raw of list) {
    const s = String(raw || '').trim();
    const short = s.startsWith(GOOGLE_SCOPE_BASE) ? s.slice(GOOGLE_SCOPE_BASE.length) : s;
    if (!Object.hasOwn(GOOGLE_SCOPES, short)) throw err('EINVAL', `Scope "${s}" is not one NakliOS can ask Google for`);
    out.add(short);
  }
  return [...out].sort();
}

// Google's own name for a short scope (openid, email and profile have no URL form).
export function googleScopeUrl(short) {
  return ['openid', 'email', 'profile'].includes(short) ? short : GOOGLE_SCOPE_BASE + short;
}

export function describeScopes(scopes) {
  return scopes.map(s => GOOGLE_SCOPES[s]);
}

export function createAuthService(deps) {
  const now = deps.now || (() => Date.now());
  const tokens = new Map();   // provider + '\0' + scopeKey → { accessToken, expiresAt, scopes }
  const inflight = new Map(); // same key → Promise of the token record
  const appsByKey = new Map(); // same key → Set of app ids handed this token (for revoke)

  async function fetchToken(appId, provider, scopes, key) {
    let res;
    try {
      res = await deps.requestToken(provider, scopes.map(googleScopeUrl));
    } catch (e) {
      if (e?.code !== 'EPOPUP') throw e;
      // The app's click did not reach this window in time; one host dialog click gives Google's window its gesture.
      if (!(await deps.continueSignIn(deps.appName(appId), provider))) throw err('ECANCELLED', 'Sign-in was cancelled');
      res = await deps.requestToken(provider, scopes.map(googleScopeUrl));
    }
    // Google reports email and profile back as userinfo.email and userinfo.profile.
    const granted = new Set((res.grantedScopes || []).map(s => {
      const short = s.startsWith(GOOGLE_SCOPE_BASE) ? s.slice(GOOGLE_SCOPE_BASE.length) : s;
      return short === 'userinfo.email' ? 'email' : short === 'userinfo.profile' ? 'profile' : short;
    }));
    const missing = scopes.filter(s => !granted.has(s));
    if (missing.length) {
      // The person unticked a box on Google's screen; give back nothing rather than a token that half works.
      try { await deps.revokeToken(provider, res.accessToken); } catch (_) {}
      throw err('EDENIED', `Google did not grant: ${missing.join(', ')}`);
    }
    const rec = { accessToken: res.accessToken, expiresAt: now() + Math.max(0, Number(res.expiresIn) || 0) * 1000, scopes };
    tokens.set(key, rec);
    return rec;
  }

  return {
    providers: PROVIDERS,

    // → { accessToken, expiresAt, scopes } for exactly the requested scope set.
    // prompt: false → only a token the host already holds; with none it throws ENOSIGNIN and shows nothing, so a
    // command another app runs in the background never opens a sign-in window.
    async token(appId, { provider = 'google', scopes, prompt = true } = {}) {
      const list = normaliseScopes(provider, scopes);
      const scopeKey = list.join(' ');
      if (prompt === false) {
        const held = tokens.get(provider + '\0' + scopeKey);
        if (!held || held.expiresAt - now() <= REUSE_MARGIN_MS) throw err('ENOSIGNIN', `${provider} sign-in is needed; the person signs in from the app`);
      }
      let grantId;
      try {
        grantId = await deps.authorize(appId, provider, scopeKey, describeScopes(list));
      } catch (e) {
        await deps.record({ appId, provider, scopes: list, outcome: { refused: e?.message || 'not allowed' } });
        throw e?.code ? e : err('ENOGRANT', String(e?.message || e));
      }
      const key = provider + '\0' + scopeKey;
      const have = tokens.get(key);
      let rec;
      if (have && have.expiresAt - now() > REUSE_MARGIN_MS) rec = have;
      else {
        if (!inflight.has(key)) inflight.set(key, fetchToken(appId, provider, list, key).finally(() => inflight.delete(key)));
        try { rec = await inflight.get(key); }
        catch (e) {
          await deps.record({ appId, provider, scopes: list, grantId, outcome: { failed: e?.code || 'error' } });
          throw e;
        }
      }
      if (!appsByKey.has(key)) appsByKey.set(key, new Set());
      appsByKey.get(key).add(appId);
      await deps.record({ appId, provider, scopes: list, grantId, outcome: { issued: true, reused: rec === have } });
      return { accessToken: rec.accessToken, expiresAt: rec.expiresAt, scopes: [...rec.scopes] };
    },

    // Forget the tokens this app was handed. A token another app also holds stays with that app; a token only this
    // app held is revoked at the provider too.
    async revoke(appId, provider = 'google') {
      let dropped = 0;
      for (const [key, apps] of appsByKey) {
        if (!key.startsWith(provider + '\0') || !apps.has(appId)) continue;
        apps.delete(appId);
        if (apps.size) continue;
        const rec = tokens.get(key);
        tokens.delete(key); appsByKey.delete(key); dropped++;
        if (rec) { try { await deps.revokeToken(provider, rec.accessToken); } catch (_) {} }
      }
      await deps.record({ appId, provider, scopes: [], outcome: { revoked: dropped } });
      return { revoked: dropped };
    },

    // Settings reset: every token, for every app, revoked at the provider.
    async revokeAll() {
      const recs = [...tokens.entries()];
      tokens.clear(); appsByKey.clear();
      for (const [key, rec] of recs) { try { await deps.revokeToken(key.split('\0')[0], rec.accessToken); } catch (_) {} }
      return { revoked: recs.length };
    },

    // For tests and Settings: how many live tokens the host holds.
    size() { return tokens.size; },
  };
}

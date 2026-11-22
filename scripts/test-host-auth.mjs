// Sign-in to outside accounts (sys/host/auth.mjs): consent per app per scope set, exact-scope tokens, reuse
// until a minute before expiry, the popup retry, refused scopes, revoke, and History records with no token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthService, normaliseScopes, googleScopeUrl, GOOGLE_SCOPE_BASE } from '../sys/host/auth.mjs';

function bed({ allow = () => true, google, continueOk = true } = {}) {
  let clock = 1_000_000, n = 0;
  const asked = [], records = [], requests = [], revoked = [], continued = [];
  const service = createAuthService({
    authorize: async (appId, provider, scopeKey, describe) => {
      asked.push({ appId, scopeKey, describe });
      if (!allow(appId, scopeKey)) throw Object.assign(new Error(`Signing in to ${provider} was not allowed for this app`), { code: 'ENOGRANT' });
      return `grant:${appId}:${scopeKey}`;
    },
    requestToken: async (provider, scopeUrls) => {
      requests.push(scopeUrls);
      if (google) return google(scopeUrls, requests.length);
      return { accessToken: `tok${++n}`, expiresIn: 3600, grantedScopes: scopeUrls };
    },
    continueSignIn: async (name) => { continued.push(name); return continueOk; },
    record: async (event) => { records.push(event); },
    revokeToken: async (provider, token) => { revoked.push(token); },
    appName: id => id.toUpperCase(),
    now: () => clock,
  });
  return { service, asked, records, requests, revoked, continued, tick: ms => { clock += ms; } };
}

test('scopes: short names and full URLs normalise and sort; unknown scopes and providers are refused', () => {
  assert.deepEqual(normaliseScopes('google', ['calendar.events', GOOGLE_SCOPE_BASE + 'gmail.modify', 'gmail.modify']), ['calendar.events', 'gmail.modify']);
  assert.throws(() => normaliseScopes('google', ['drive']), e => e.code === 'EINVAL');
  assert.throws(() => normaliseScopes('google', []), e => e.code === 'EINVAL');
  assert.throws(() => normaliseScopes('microsoft', ['gmail.modify']), e => e.code === 'EINVAL');
  assert.equal(googleScopeUrl('email'), 'email');
  assert.equal(googleScopeUrl('gmail.modify'), GOOGLE_SCOPE_BASE + 'gmail.modify');
});

test('token: consent is asked with plain words, Google gets exactly the scope set, History has no token', async () => {
  const { service, asked, requests, records } = bed();
  const out = await service.token('mail', { provider: 'google', scopes: ['gmail.modify'] });
  assert.equal(out.accessToken, 'tok1');
  assert.deepEqual(out.scopes, ['gmail.modify']);
  assert.equal(asked[0].scopeKey, 'gmail.modify');
  assert.match(asked[0].describe[0], /Gmail/);
  assert.deepEqual(requests[0], [GOOGLE_SCOPE_BASE + 'gmail.modify']);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].outcome, { issued: true, reused: false });
  assert.ok(!JSON.stringify(records).includes('tok1'), 'History must not carry the token');
});

test('token: reused while more than a minute is left, refetched after', async () => {
  const { service, requests, tick } = bed();
  await service.token('mail', { scopes: ['gmail.modify'] });
  tick(3500_000); // 100 s left
  const again = await service.token('mail', { scopes: ['gmail.modify'] });
  assert.equal(again.accessToken, 'tok1');
  tick(50_000); // 50 s left
  const fresh = await service.token('mail', { scopes: ['gmail.modify'] });
  assert.equal(fresh.accessToken, 'tok2');
  assert.equal(requests.length, 2);
});

test('token: a different scope set gets its own token, so one app never receives another set\'s scopes', async () => {
  const { service, requests } = bed();
  const mail = await service.token('mail', { scopes: ['gmail.modify'] });
  const cal = await service.token('calendar', { scopes: ['calendar.events'] });
  assert.notEqual(mail.accessToken, cal.accessToken);
  assert.deepEqual(requests, [[GOOGLE_SCOPE_BASE + 'gmail.modify'], [GOOGLE_SCOPE_BASE + 'calendar.events']]);
});

test('token: two calls at once share one Google request', async () => {
  const { service, requests } = bed();
  const [a, b] = await Promise.all([service.token('mail', { scopes: ['gmail.modify'] }), service.token('mail', { scopes: ['gmail.modify'] })]);
  assert.equal(a.accessToken, b.accessToken);
  assert.equal(requests.length, 1);
});

test('token: a declined app gets ENOGRANT, Google is never asked, and the refusal is recorded', async () => {
  const { service, requests, records } = bed({ allow: () => false });
  await assert.rejects(service.token('mail', { scopes: ['gmail.modify'] }), e => e.code === 'ENOGRANT');
  assert.equal(requests.length, 0);
  assert.ok(records[0].outcome.refused);
});

test('token: a blocked popup asks the person to continue once, then retries', async () => {
  const { service, continued, requests } = bed({ google: (scopes, i) => {
    if (i === 1) throw Object.assign(new Error('popup blocked'), { code: 'EPOPUP' });
    return { accessToken: 'late', expiresIn: 3600, grantedScopes: scopes };
  } });
  const out = await service.token('mail', { scopes: ['gmail.modify'] });
  assert.equal(out.accessToken, 'late');
  assert.deepEqual(continued, ['MAIL']);
  assert.equal(requests.length, 2);
});

test('token: cancelling the continue dialog gives ECANCELLED', async () => {
  const { service } = bed({ continueOk: false, google: () => { throw Object.assign(new Error('popup blocked'), { code: 'EPOPUP' }); } });
  await assert.rejects(service.token('mail', { scopes: ['gmail.modify'] }), e => e.code === 'ECANCELLED');
});

test('token: a scope the person unticked on Google\'s screen gives EDENIED and the partial token is revoked', async () => {
  const { service, revoked, records } = bed({ google: () => ({ accessToken: 'half', expiresIn: 3600, grantedScopes: [GOOGLE_SCOPE_BASE + 'calendar.events'] }) });
  await assert.rejects(service.token('emergic', { scopes: ['calendar.events', 'gmail.modify'] }), e => e.code === 'EDENIED' && /gmail\.modify/.test(e.message));
  assert.deepEqual(revoked, ['half']);
  assert.equal(records.at(-1).outcome.failed, 'EDENIED');
});

test('token: Google reports email and profile as userinfo scopes, which count as granted', async () => {
  const { service } = bed({ google: () => ({ accessToken: 't', expiresIn: 3600, grantedScopes: ['openid', GOOGLE_SCOPE_BASE + 'userinfo.email'] }) });
  const out = await service.token('mail', { scopes: ['openid', 'email'] });
  assert.equal(out.accessToken, 't');
});

test('revoke: a token shared by two apps stays until the last one revokes; then Google is told', async () => {
  const { service, revoked } = bed();
  await service.token('mail', { scopes: ['gmail.modify'] });
  await service.token('mail2', { scopes: ['gmail.modify'] });
  assert.deepEqual(await service.revoke('mail'), { revoked: 0 });
  assert.deepEqual(revoked, []);
  assert.deepEqual(await service.revoke('mail2'), { revoked: 1 });
  assert.deepEqual(revoked, ['tok1']);
  assert.equal(service.size(), 0);
});

test('revokeAll: every held token is revoked at the provider', async () => {
  const { service, revoked } = bed();
  await service.token('mail', { scopes: ['gmail.modify'] });
  await service.token('calendar', { scopes: ['calendar.events'] });
  assert.deepEqual(await service.revokeAll(), { revoked: 2 });
  assert.deepEqual(revoked.sort(), ['tok1', 'tok2']);
});

test('History: the ledger accepts the auth door, so sign-in events are not dropped', async () => {
  const { appendEvent, DOORS } = await import('../sys/history/ledger.mjs');
  assert.ok(DOORS.includes('auth'));
  const { event } = await appendEvent(null, { ts: 1, principal: 'app:mail', door: 'auth', tool: 'auth.token', app: 'mail', input: { provider: 'google', scopes: ['gmail.modify'] }, output: { issued: true } });
  assert.equal(event.door, 'auth');
});

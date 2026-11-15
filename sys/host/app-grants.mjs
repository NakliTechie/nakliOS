// App-to-app command Grants (common rail, "Grants on the rail", row "Another app"). An app that is not a system app
// reaches another app's registered commands only after the person allows it, once per caller app and target app, in a
// host dialog. The Grant is the same kind the network door issues: caveats principal app:<caller>, tools
// [app.commands], scope app:<target>, verified at every call against the host's root key and revocation list.
// After the Grant, `read` commands run; `write` and `destructive` commands go through the host's own checks
// (`run`), which ask once per visit and route destructive ones through review. Every call, refused ones included,
// is one History event through `record`.

export const APP_GRANTS_KEY = 'nakliOS.appGrants.v1';   // { [caller]: { [target]: grant | { denied:true, decidedAt } } }
export const APP_REVOKED_KEY = 'nakliOS.appRevoked.v1'; // [grant identifier]
export const APP_GRANT_TOOL = 'app.commands';

/**
 * @param {{
 *   storage: { getItem(k: string): string | null, setItem(k: string, v: string): void },
 *   grantLib: { issueGrant: Function, verifyGrant: Function, caveat: any },
 *   rootKey: () => Promise<Uint8Array>,
 *   confirm: (caller: string, target: string) => Promise<boolean>,
 *   describe: (name: string) => any,
 *   searchAll: (query: string) => Promise<Array<{ name: string, app?: string }>>,
 *   run: (caller: string, name: string, input: any, stillWanted: () => boolean) => Promise<any>,
 *   record: (event: { caller: string, target: string, command: string, grantId: string | null, output: any }) => Promise<void> | void,
 *   now?: () => number,
 *   consentMs?: number,
 * }} deps
 */
export function createAppGrants({ storage, grantLib, rootKey, confirm, describe, searchAll, run, record, now = Date.now, consentMs = 240000 }) {
  const read = (key, fallback) => { try { return JSON.parse(storage.getItem(key) || 'null') ?? fallback; } catch (_) { return fallback; } };
  const decisions = () => read(APP_GRANTS_KEY, {});
  const save = value => { try { storage.setItem(APP_GRANTS_KEY, JSON.stringify(value)); } catch (_) {} };
  const revoked = () => new Set(read(APP_REVOKED_KEY, []));
  const saveRevoked = set => { try { storage.setItem(APP_REVOKED_KEY, JSON.stringify([...set])); } catch (_) {} };
  const prompts = new Map();

  async function verify(caller, target, grant) {
    return grantLib.verifyGrant(grant, await rootKey(), { principal: 'app:' + caller, tool: APP_GRANT_TOOL, target: 'app:' + target, now: now(), revocationList: revoked() });
  }
  // The caller's Grant for the target: the stored one, or a new one after the person allows it once. null after a
  // decline, which is remembered until the person resets it in Settings. One dialog per pair, however many calls wait.
  function ensure(caller, target) {
    const have = (decisions()[caller] || {})[target];
    if (have?.denied) return Promise.resolve(null);
    if (have?.identifier) return Promise.resolve(have);
    const key = caller + '\0' + target;
    if (prompts.has(key)) return prompts.get(key);
    const asked = (async () => {
      const ok = await confirm(caller, target);
      const all = decisions(); all[caller] = all[caller] || {};
      if (!ok) { all[caller][target] = { denied: true, decidedAt: now() }; save(all); return null; }
      const { issueGrant, caveat } = grantLib;
      const grant = await issueGrant(await rootKey(), { caveats: [caveat.principal('app:' + caller), caveat.tools([APP_GRANT_TOOL]), caveat.scope('app:' + target)] });
      all[caller][target] = { ...grant, decidedAt: now() }; save(all); return all[caller][target];
    })().finally(() => prompts.delete(key));
    prompts.set(key, asked);
    return asked;
  }
  async function authorize(caller, target) {
    const grant = await ensure(caller, target);
    if (!grant) return { ok: false, grant: null, reason: `the person did not allow this app to use ${target}` };
    const v = await verify(caller, target, grant);
    return { ok: v.ok, grant, reason: v.ok ? '' : `the grant for ${target} did not verify (${v.reason})` };
  }
  // Holds a valid Grant now, without asking.
  async function holds(caller, target) {
    const grant = (decisions()[caller] || {})[target];
    return !!grant?.identifier && (await verify(caller, target, grant)).ok;
  }

  // The caller's own commands and the commands of apps it holds a Grant for.
  async function search(caller, query) {
    const found = await searchAll(query);
    const allowed = new Map();
    const out = [];
    for (const command of found) {
      const target = command.app;
      if (!target) continue;
      if (!allowed.has(target)) allowed.set(target, target === caller || await holds(caller, target));
      if (allowed.get(target)) out.push(command);
    }
    return out;
  }

  async function call(caller, name, input, stillWanted = () => true) {
    const command = describe(name);
    const target = command?.annotations?.app;
    if (!target) return { ok: false, code: 'ENOENT', message: `no app command named ${name}` };
    let grantId = null;
    if (target !== caller) {
      const started = now();
      const auth = await authorize(caller, target);
      grantId = auth.grant?.identifier || null;
      if (!auth.ok) {
        const out = { ok: false, code: 'ENOGRANT', message: auth.reason };
        await record({ caller, target, command: name, grantId, output: { ok: false, code: out.code } });
        return out;
      }
      // An answer given after the caller stopped waiting keeps the Grant but runs nothing now.
      if (now() - started >= consentMs || !stillWanted()) {
        await record({ caller, target, command: name, grantId, output: { ok: false, code: 'ETIMEOUT' } });
        return { ok: false, code: 'ETIMEOUT', message: 'the caller stopped waiting before the person answered' };
      }
    }
    let out;
    try { out = await run(caller, name, input, stillWanted); }
    catch (error) { out = { ok: false, code: 'EFAIL', message: String(error?.message || error) }; }
    await record({ caller, target, command: name, grantId, output: { ok: out?.ok !== false, code: out?.code || null } });
    return out;
  }

  // What Settings shows: one row per caller and target, allowed or declined.
  function list() {
    const rows = [];
    for (const [caller, targets] of Object.entries(decisions())) {
      for (const [target, v] of Object.entries(targets || {})) rows.push({ caller, target, allowed: !!v?.identifier, decidedAt: v?.decidedAt || null });
    }
    return rows.sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0));
  }
  // Revoke one pair (or every pair): the Grant's identifier goes on the revocation list and the decision is forgotten,
  // so the caller asks again on its next call.
  function revoke(caller, target) {
    const all = decisions(); const gone = revoked();
    for (const [c, targets] of Object.entries(all)) {
      if (caller !== undefined && c !== caller) continue;
      for (const [t, v] of Object.entries(targets || {})) {
        if (target !== undefined && t !== target) continue;
        if (v?.identifier) gone.add(v.identifier);
        delete targets[t];
      }
      if (!Object.keys(targets || {}).length) delete all[c];
    }
    saveRevoked(gone); save(all);
  }
  const count = () => list().length;

  return { ensure, authorize, holds, search, call, list, revoke, revokeAll: () => revoke(), count };
}

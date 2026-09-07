// grant — Rig's single grant primitive (C4).
//
// A grant is the operator's per-session authorisation: a set of path prefixes
// and capability scopes. Rig is the ONE source of grants — Kiln derives its
// mount from the same grant and never sets, widens, or caches one (hard rule
// #5c). Deny by default: an empty prefix list allows nothing.
//
// Path checks reuse pathguard, so every traversal class (.., absolute-escape,
// encoded, backslash, control) is denied here exactly as it is at the fs
// ingress — the grant edge and the fs edge cannot disagree.

import { normalizeMountPath } from '../fileops/pathguard.mjs';

/**
 * @param {object}   opts
 * @param {string[]} [opts.prefixes]  mount-relative path prefixes ('' = whole mount)
 * @param {string[]} [opts.scopes]    capability scopes, e.g. 'fs:read', 'git:write'
 * @param {string[]} [opts.readOnlyPrefixes]  regions inside the grant that may be READ but
 *   never written or removed. This is where a directory that is AUTHORITY rather than content
 *   belongs (.anvil/skills — a file there decides what instructions bind, and one door,
 *   skill_manage, scans before binding). Enforced on the normalised path, so every route the
 *   shell offers — a redirect, `rm`, a dotted `fs.write`, a relative path from another cwd,
 *   `..` traversal — collapses to the same check. A string match on the command line cannot
 *   do that, which is why the boundary lives here and not there.
 */
export function createGrant({ prefixes = [], scopes = [], readOnlyPrefixes = [] } = {}) {
  let active = true;
  // Normalise prefixes through the same validator; drop any that don't validate.
  const norm = [];
  for (const p of prefixes) {
    const r = normalizeMountPath(p);
    if (r.ok) norm.push(r.path);
  }
  const scopeSet = new Set(scopes);
  const readOnly = [];
  for (const p of readOnlyPrefixes) {
    const r = normalizeMountPath(p);
    if (r.ok) readOnly.push(r.path);
  }

  function allowsPath(input) {
    if (!active) return false;
    const r = normalizeMountPath(input);
    if (!r.ok) return false; // traversal / encoded / absolute-escape → denied
    return norm.some((prefix) => prefix === '' || r.path === prefix || r.path.startsWith(prefix + '/'));
  }

  // Is this path inside a read-only region — or an ANCESTOR of one? A path that does not
  // normalise is reported as read-only too: allowsPath already denies it, and the two edges
  // must not disagree.
  //
  // The ancestor half is not an extra: protecting `.anvil/skills` while allowing
  // `rm -rf .anvil` or `mv .anvil elsewhere` protects nothing (found by a cross-family review
  // of the first version, which checked descendants only). Removing or moving a directory
  // takes its whole subtree with it, so a region is only read-only if the path to it is too.
  function isReadOnly(input) {
    const r = normalizeMountPath(input);
    if (!r.ok) return true;
    return readOnly.some((prefix) =>
      prefix === '' ||
      r.path === prefix ||
      r.path.startsWith(prefix + '/') ||          // inside the region
      prefix.startsWith(r.path + '/') ||          // an ancestor of it
      r.path === '');                             // the mount root itself
  }

  return {
    get active() { return active; },
    get readOnlyPrefixes() { return readOnly.slice(); },
    isReadOnly,
    revoke() { active = false; },
    get prefixes() { return norm.slice(); },
    get scopes() { return [...scopeSet]; },
    allowsScope(scope) { return active && scopeSet.has(scope); },
    allowsPath,
    // A single object describing what is active — for a "grant visible while
    // active" surface (C5) and for the Kiln mount derivation.
    describe() {
      return { active, prefixes: norm.slice(), scopes: [...scopeSet], readOnlyPrefixes: readOnly.slice() };
    },
  };
}

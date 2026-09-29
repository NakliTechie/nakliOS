// git-core — Rig's C2 git surface over vendored isomorphic-git.
//
// isomorphic-git is used through the fs adapter only; it is never forked.
// In scope: init, add, remove, commit, log, status, statusMatrix, branch,
// checkout, listBranches, listRemotes, diff (working tree and between refs),
// resolveRef, readCommit. Out: merge, rebase, submodules, LFS.
//
// Commit identity (RIG §5): operator commits use the operator's Identity; agent
// commits are forced to agent@rig.local plus a session trailer, and can NEVER
// borrow the operator's identity. Push is a Transport concern (Layer 2), is
// operator-only, and is not exposed to the kernel.

import * as git from '../../../vendor/isomorphic-git/1.40.0/isomorphic-git.mjs';
import { makeFsAdapter } from './fs-adapter.mjs';

const AGENT_IDENTITY = { name: 'Rig agent', email: 'agent@rig.local' };

function appendSessionTrailer(message, session) {
  const id = session && session.id ? String(session.id) : 'unknown';
  const body = message.endsWith('\n') ? message : message + '\n';
  return `${body}\nRig-Session: ${id}\n`;
}

/**
 * @param {object} opts
 * @param {object} opts.fs         a createFileops(...) instance
 * @param {string} [opts.dir='/']  worktree root within the mount
 * @param {object} [opts.transport] a Transport (Layer 2) for clone/fetch/push
 */
export function createGitCore({ fs, dir = '/', transport = null }) {
  if (!fs) throw new Error('createGitCore requires a fileops instance (fs)');
  const igfs = makeFsAdapter(fs);
  const base = { fs: igfs, dir };

  // The local operations below need a repository. isomorphic-git's statusMatrix does not check,
  // so without `.git` it listed every file as untracked (2026-09-29).
  const NOT_A_REPO = { ok: false, code: 'ENOTREPO', message: 'not a git repository (run `git init` first)' };
  async function hasRepo() {
    try { await git.findRoot({ fs: igfs, filepath: dir }); return true; } catch (_) { return false; }
  }
  const inRepo = (fn) => async (...args) => ((await hasRepo()) ? fn(...args) : NOT_A_REPO);

  // A commit oid for REF: a branch, a tag, HEAD, a full or abbreviated oid, each optionally followed
  // by `~N` (N first parents back) or `^` (one), as git reads them.
  async function resolveCommit(ref) {
    const m = /^(.*?)((?:~\d*|\^)*)$/.exec(String(ref));
    let oid;
    if (/^[0-9a-f]{4,40}$/i.test(m[1])) {
      try { oid = await git.expandOid({ ...base, oid: m[1] }); } catch (_) { oid = await git.resolveRef({ ...base, ref: m[1] }); }
    } else oid = await git.resolveRef({ ...base, ref: m[1] });
    for (const step of m[2].match(/~\d*|\^/g) || []) {
      for (let n = step === '^' || step === '~' ? 1 : Number(step.slice(1)); n > 0; n--) {
        const { commit } = await git.readCommit({ ...base, oid });
        if (!commit.parent.length) throw Object.assign(new Error(`${ref}: no such commit (history ends first)`), { code: 'NotFoundError' });
        oid = commit.parent[0];
      }
    }
    return oid;
  }

  async function init({ defaultBranch = 'main' } = {}) {
    await git.init({ ...base, defaultBranch });
    return { ok: true };
  }

  async function add({ filepath }) {
    await git.add({ ...base, filepath });
    return { ok: true };
  }

  async function remove({ filepath }) {
    await git.remove({ ...base, filepath });
    return { ok: true };
  }

  // actor: 'operator' (requires identity) | 'agent' (forced agent@rig.local).
  async function commit({ message, actor = 'operator', identity, session, timestamp, timezoneOffset = 0 } = {}) {
    if (!message || typeof message !== 'string') {
      return { ok: false, code: 'EINVAL', message: 'commit requires a message' };
    }
    let author;
    let msg = message;
    if (actor === 'agent') {
      author = { ...AGENT_IDENTITY }; // never the operator's identity
      msg = appendSessionTrailer(message, session);
    } else if (actor === 'operator') {
      if (!identity || !identity.name || !identity.email) {
        return { ok: false, code: 'ENOIDENT', message: 'operator commit requires an identity {name,email}' };
      }
      author = { name: identity.name, email: identity.email };
    } else {
      return { ok: false, code: 'EINVAL', message: `unknown commit actor: ${actor}` };
    }
    author.timestamp = timestamp != null ? timestamp : Math.floor(Date.now() / 1000);
    author.timezoneOffset = timezoneOffset;
    const oid = await git.commit({ ...base, message: msg, author, committer: author });
    return { ok: true, oid, actor };
  }

  async function log(opts = {}) {
    return { ok: true, commits: await git.log({ ...base, ...opts, ...(opts.ref ? { ref: await resolveCommit(opts.ref) } : {}) }) };
  }

  async function status({ filepath }) {
    return { ok: true, status: await git.status({ ...base, filepath }) };
  }

  async function statusMatrix(opts = {}) {
    return { ok: true, matrix: await git.statusMatrix({ ...base, ...opts }) };
  }

  async function branch({ ref, checkout = false }) {
    await git.branch({ ...base, ref, checkout });
    return { ok: true };
  }

  async function listBranches() {
    return { ok: true, branches: await git.listBranches({ ...base }) };
  }

  async function checkout({ ref, force = false }) {
    await git.checkout({ ...base, ref, force });
    return { ok: true };
  }

  async function listRemotes() {
    return { ok: true, remotes: await git.listRemotes({ ...base }) };
  }

  async function resolveRef({ ref }) {
    return { ok: true, oid: await git.resolveRef({ ...base, ref }) };
  }

  async function readCommit({ oid }) {
    // isomorphic-git returns { oid, commit, payload }; expose the inner commit
    // object (message, tree, parent, author, committer).
    const r = await git.readCommit({ ...base, oid });
    return { ok: true, oid: r.oid, commit: r.commit };
  }

  // The tree oid of a ref/commit — content-addressed and timestamp-independent,
  // which is why the checkpoint asserts the TREE hash, not the commit hash.
  async function treeOid({ ref = 'HEAD' } = {}) {
    const oid = await git.resolveRef({ ...base, ref });
    const { commit } = await git.readCommit({ ...base, oid });
    return { ok: true, oid: commit.tree };
  }

  // diff working tree (refB omitted) or between two refs.
  async function diff({ refA = 'HEAD', refB = null } = {}) {
    const trees = [git.TREE({ ref: await resolveCommit(refA) }), refB ? git.TREE({ ref: await resolveCommit(refB) }) : git.WORKDIR()];
    // walk prunes a subtree when map returns undefined, so directories must
    // return a truthy marker to keep descending; only blobs emit a change.
    const KEEP = { _dir: true };
    const changes = await git.walk({
      ...base,
      trees,
      map: async (filepath, entries) => {
        if (filepath === '.') return KEEP;
        // The gitdir lives inside the worktree when dir='/'; never diff it.
        if (filepath === '.git' || filepath.startsWith('.git/')) return undefined;
        const [a, b] = entries;
        const aType = a && (await a.type());
        const bType = b && (await b.type());
        if (aType === 'tree' || bType === 'tree') return KEEP; // descend into real dirs
        const aOid = a && (await a.oid());
        const bOid = b && (await b.oid());
        if (aOid === bOid) return undefined; // unchanged blob
        const state = aOid && bOid ? 'modified' : aOid ? 'deleted' : 'added';
        return { path: filepath, status: state };
      },
      reduce: async (parent, children) => {
        const flat = (children || []).flat().filter(Boolean);
        if (parent && parent.path) flat.push(parent);
        return flat;
      },
    });
    return { ok: true, changes: (changes || []).filter((c) => c && c.path) };
  }

  // The bytes of `filepath` in a commit (`ref`, as resolveCommit reads it) or, with no ref, in the
  // index. ENOENT when the path is not there. `git diff` reads both sides of a patch with it.
  async function readBlob({ filepath, ref }) {
    const missing = { ok: false, code: 'ENOENT', message: `${filepath}: not in ${ref || 'the index'}` };
    if (ref) {
      const oid = await resolveCommit(ref); // a bad ref throws, and says so
      try { return { ok: true, data: (await git.readBlob({ ...base, oid, filepath })).blob }; }
      catch (e) { if (e && e.code === 'NotFoundError') return missing; throw e; }
    }
    let oid = null;
    await git.walk({ ...base, trees: [git.STAGE()], map: async (fp, [entry]) => {
      if (fp === '.') return true;
      if (fp === filepath) { if (entry) oid = await entry.oid(); return undefined; }
      return filepath.startsWith(fp + '/') ? true : undefined; // descend only toward the path
    } });
    if (!oid) return missing;
    return { ok: true, data: (await git.readBlob({ ...base, oid })).blob };
  }

  // The checked-out branch's short name, or null on a detached HEAD.
  async function currentBranch() {
    return { ok: true, branch: (await git.currentBranch({ ...base, fullname: false })) || null };
  }

  // ── Transport-backed (Layer 2): clone/fetch/push/listRemote ──────────────
  function requireTransport(op) {
    if (!transport) throw new Error(`git.${op} needs a Transport (none configured)`);
    return transport;
  }
  // Transports also receive the raw fileops (`fs`) and worktree `dir`: base.fs
  // is the isomorphic-git adapter, but a Transport needs glob/read/write to move
  // the object database.
  async function clone(opts = {}) { return requireTransport('clone').clone({ git, base, fs, dir, ...opts }); }
  async function fetch(opts = {}) { return requireTransport('fetch').fetch({ git, base, fs, dir, ...opts }); }
  async function push(opts = {}) { return requireTransport('push').push({ git, base, fs, dir, ...opts }); }
  async function listServerRefs(opts = {}) { return requireTransport('listServerRefs').listServerRefs({ git, base, fs, dir, ...opts }); }

  return {
    init,
    add: inRepo(add), remove: inRepo(remove), commit: inRepo(commit), log: inRepo(log),
    status: inRepo(status), statusMatrix: inRepo(statusMatrix),
    branch: inRepo(branch), listBranches: inRepo(listBranches), checkout: inRepo(checkout),
    listRemotes: inRepo(listRemotes), resolveRef: inRepo(resolveRef), readCommit: inRepo(readCommit),
    treeOid: inRepo(treeOid), diff: inRepo(diff), readBlob: inRepo(readBlob), currentBranch: inRepo(currentBranch),
    clone, fetch, push, listServerRefs,
    _git: git, _base: base,
  };
}

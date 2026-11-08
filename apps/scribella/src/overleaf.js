// Two-way sync with an Overleaf project through Overleaf's own Git integration. Pull merges Overleaf's changes with
// yours file by file; push sends a commit that builds on Overleaf's latest, so nothing there is overwritten.
import * as git from '../vendor/isomorphic-git/isomorphic-git.mjs';
import http from '../vendor/isomorphic-git/http-web.mjs';
import { storeFs } from './git.js';
import { merge3 } from './merge.js';

export const GITDIR = '/.scribella/overleaf-git';
const STATE = '.scribella/overleaf.json';
const BRANCH = 'master';
const decode = bytes => new TextDecoder().decode(bytes);
const sameBytes = (a, b) => a?.length === b?.length && a.every((byte, index) => byte === b[index]);
const TEXT = /\.(tex|ltx|bib|sty|cls|bst|bbx|cbx|txt|md|csv|tsv|board)$/i;
const fingerprint = bytes => (bytes ? `${bytes.length}:${bytes.reduce((hash, byte) => (Math.imul(hash, 31) + byte) >>> 0, 7)}` : 'absent');
const HIDDEN = path => path.split('/').some(part => part.startsWith('.'));

export function overleafProjectId(input) {
  const match = /(?:overleaf\.com\/(?:project|read)\/|^)([a-f0-9]{24})\b/.exec(String(input).trim());
  return match?.[1] || null;
}

// `link` is { id, token }. `proxy` is the CORS proxy base, `transport` replaces fetch-based HTTP in tests.
export const STATE_PATH = STATE;

export function overleafSync({ store, root, link, proxy, transport = http, url = `https://git.overleaf.com/${link.id}` }) {
  const fs = storeFs(store, root);
  const base = { fs, dir:'/', gitdir:GITDIR };
  const remote = { http:transport, ...base, url, corsProxy:proxy, onAuth:() => ({ username:'git', password:link.token }) };
  const statePath = `${root}/${STATE}`;
  const readState = async () => (await store.exists(statePath) ? JSON.parse(await store.read(statePath)) : {});
  const writeState = value => store.write(statePath, JSON.stringify(value));

  async function ready() {
    if (await store.exists(`${root}${GITDIR}/HEAD`)) return;
    await git.init({ ...base, defaultBranch:BRANCH });
    await git.addRemote({ ...base, remote:'origin', url });
  }

  async function files(oid) {
    const out = {};
    await git.walk({ ...base, trees:[git.TREE({ ref:oid })], map:async (path, [entry]) => {
      if (path === '.') return true;
      if ((await entry.type()) === 'tree') return true;
      out[path] = await entry.content();
      return true;
    } });
    return out;
  }

  async function localFiles() {
    const out = {}, pending = [root];
    while (pending.length) {
      for (const entry of await store.list(pending.pop())) {
        const path = entry.replace(/\/$/, ''), relative = path.slice(root.length + 1);
        if (HIDDEN(relative)) continue;
        if (entry.endsWith('/')) pending.push(path); else out[relative] = await store.readBinary(path);
      }
    }
    return out;
  }

  return {
    // Answers what changed and which files hold conflict markers.
    async pull() {
      await ready();
      const { fetchHead } = await git.fetch({ ...remote, ref:BRANCH, singleBranch:true, depth:50 });
      const saved = await readState();
      const theirs = await files(fetchHead), before = saved.synced ? await files(saved.synced) : {};
      const mine = await localFiles();
      const changed = [], conflicts = [];
      for (const path of new Set([...Object.keys(theirs), ...Object.keys(before)])) {
        const old = before[path], next = theirs[path], current = mine[path];
        if (sameBytes(old, next)) continue;
        if (next === undefined) {
          if (current && sameBytes(current, old)) { await store.remove(`${root}/${path}`); changed.push(path); }
          else if (current) conflicts.push(path);
          continue;
        }
        if (current === undefined && old) { await store.write(`${root}/${path}`, next); changed.push(path); conflicts.push(path); continue; }
        if (current === undefined || sameBytes(current, old)) { await store.write(`${root}/${path}`, next); changed.push(path); continue; }
        if (sameBytes(current, next)) continue;
        // Both sides changed a file that is not text: the local copy stays, and the person decides.
        if (!TEXT.test(path)) { conflicts.push(path); continue; }
        const merged = merge3(old ? decode(old) : '', decode(current), decode(next), 'overleaf');
        await store.write(`${root}/${path}`, merged.text);
        changed.push(path);
        if (merged.conflicts) conflicts.push(path);
      }
      await git.writeRef({ ...base, ref:`refs/heads/${BRANCH}`, value:fetchHead, force:true });
      // Each conflict is kept with a fingerprint of the local copy; it counts as resolved once that copy changes.
      const after = await localFiles(), open = { ...(saved.open || {}) };
      for (const path of conflicts) open[path] = fingerprint(after[path]);
      await writeState({ ...saved, synced:fetchHead, open });
      return { changed, conflicts, head:fetchHead };
    },
    // Pulls first, so the commit builds on Overleaf's latest; answers what was sent.
    async push(message = 'Changes from Scribella', now = Date.now()) {
      const pulled = await this.pull();
      if (pulled.conflicts.length) return { pushed:false, conflicts:pulled.conflicts };
      const files = await localFiles(), saved = await readState();
      const unresolved = Object.entries(saved.open || {}).filter(([path, mark]) => fingerprint(files[path]) === mark).map(([path]) => path);
      if (unresolved.length) return { pushed:false, conflicts:unresolved };
      const marked = Object.entries(files).filter(([, bytes]) => /^<<<<<<< yours$/m.test(decode(bytes))).map(([path]) => path);
      if (marked.length) return { pushed:false, conflicts:marked };
      let staged = 0;
      for (const [file, head, work] of await git.statusMatrix(base)) {
        if (HIDDEN(file) || (head === 1 && work === 1 && (await git.status({ ...base, filepath:file })) === 'unmodified')) continue;
        if (work === 0) await git.remove({ ...base, filepath:file }); else await git.add({ ...base, filepath:file });
        staged += 1;
      }
      if (!staged) return { pushed:false, nothing:true };
      const author = { name:'Scribella', email:'scribella@local', timestamp:Math.floor(now / 1000), timezoneOffset:0 };
      const oid = await git.commit({ ...base, message, author, committer:author });
      const result = await git.push({ ...remote, ref:BRANCH, remoteRef:BRANCH });
      if (!result.ok) throw new Error(`Overleaf refused the push: ${JSON.stringify(result.refs || result.error)}`);
      await writeState({ ...(await readState()), synced:oid, open:{} });
      return { pushed:true, files:staged, oid };
    },
  };
}

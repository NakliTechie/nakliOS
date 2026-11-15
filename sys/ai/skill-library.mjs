// skill-library.mjs — NakliOS's one skills library, shared by every agent (Anvil, Dish, Pi).
//
// A skill is `skills/<name>/SKILL.md` at the root of the user's NakliOS storage (their Folder or
// Crate), the same file shape as Anvil's project skills and the cross-agent `.agents/skills`
// convention: frontmatter `name`, `description`, optional `status`, then the instructions. Pure: the
// caller passes a `store` with `list(prefix)` and `read(path)` (and `write(path, text)` to propose);
// the host binds it to its active backend.
//
// One gate for every agent. A skill reaches an agent only when it is injectable (status active or
// stale) AND Sentinel passes it (refused or quarantined skills never bind). A person owns the status:
// a hand-written skill is active, and anything an agent proposes lands `staged` until a person
// activates it. Sentinel runs on every load, so editing a file cannot slip past it.
// Plan: plan/2026-10-29-shared-skills-plan.md.

import { parseSkill, INJECTED_STATUSES } from './skills.mjs';
import { scanSkill, sentinelLine } from './skill-sentinel.mjs';
import { applySkillStatus } from './skill-lifecycle.mjs';

export const SKILL_LIBRARY_DIR = 'skills';
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function validSkillName(name) { return NAME.test(String(name || '')); }

// The skill folder names under skills/, from either listing style: immediate children
// ("skills/foo/") or flat object-store keys ("skills/foo/SKILL.md").
export function skillNamesFromListing(entries) {
  const names = new Set();
  for (const e of entries || []) {
    const rel = String(typeof e === 'string' ? e : e?.path || e?.name || '').replace(/^\/+/, '');
    const rest = rel.startsWith(SKILL_LIBRARY_DIR + '/') ? rel.slice(SKILL_LIBRARY_DIR.length + 1) : rel;
    const first = rest.split('/')[0];
    if (validSkillName(first)) names.add(first);
  }
  return [...names].sort();
}

// Every skill in the library with its status and Sentinel verdict. A file that will not parse or
// read is reported, never thrown, so one bad skill cannot hide the rest.
export async function loadLibrary(store) {
  let entries;
  try { entries = await store.list(SKILL_LIBRARY_DIR); } catch (_) { return []; }
  const out = [];
  for (const dir of skillNamesFromListing(entries)) {
    const path = `${SKILL_LIBRARY_DIR}/${dir}/SKILL.md`;
    let text;
    try { text = await store.read(path); } catch (e) { out.push({ name: dir, path, status: 'unreadable', error: String(e?.message || e), usable: false }); continue; }
    if (text == null) continue;
    const skill = parseSkill(String(text));
    const name = skill.name || dir;
    const scan = scanSkill({ name, description: skill.description, body: skill.body });
    const blocked = scan.state === 'refused' || scan.state === 'quarantined';
    out.push({
      name, dir, path, description: skill.description, status: skill.status, pinned: skill.pinned,
      sentinel: scan.state, sentinelLine: sentinelLine(scan), body: skill.body,
      usable: !blocked && INJECTED_STATUSES.includes(skill.status) && name === dir,
    });
  }
  return out;
}

// What an agent may see: usable skills, without their bodies (bodies load on demand).
export function agentCatalog(library) {
  return library.filter((s) => s.usable).map(({ name, description, status }) => ({ name, description, status }));
}

// One usable skill's full text for an agent, or null.
export function agentSkill(library, name) {
  const s = library.find((x) => x.usable && x.name === name);
  return s ? { name: s.name, description: s.description, status: s.status, body: s.body } : null;
}

// A person sets a skill's status (Settings → Skills). Never offered to apps: activation is the person's
// decision. Activating a skill Sentinel blocks is refused, since it would never bind anyway.
export async function setSkillStatus(store, name, status, { now = new Date() } = {}) {
  if (!validSkillName(name)) return { ok: false, code: 'EINVAL', message: 'not a skill name' };
  const path = `${SKILL_LIBRARY_DIR}/${name}/SKILL.md`;
  const text = await store.read(path);
  if (text == null) return { ok: false, code: 'ENOENT', message: `no skill named ${name}` };
  if (status === 'active') {
    const s = parseSkill(String(text));
    const scan = scanSkill({ name: s.name || name, description: s.description, body: s.body });
    if (scan.state === 'refused' || scan.state === 'quarantined') return { ok: false, code: 'EBLOCKED', message: sentinelLine(scan) };
  }
  let next;
  try { next = applySkillStatus(String(text), status, { now: now.getTime() }); }
  catch (e) { return { ok: false, code: 'EINVAL', message: String(e.message || e) }; }
  await store.write(path, next);
  return { ok: true, path, status };
}

// An agent proposes a skill: written `staged`, never active, and refused outright if Sentinel refuses
// it or a skill of that name exists (a proposal never overwrites the person's skill).
export async function proposeSkill(store, { name, description, body }, { now = new Date() } = {}) {
  if (!validSkillName(name)) return { ok: false, code: 'EINVAL', message: 'skill names are lowercase letters, digits, dot, dash or underscore (max 64)' };
  const scan = scanSkill({ name, description: String(description || ''), body: String(body || '') });
  if (scan.state === 'refused') return { ok: false, code: 'EREFUSED', message: sentinelLine(scan) };
  const path = `${SKILL_LIBRARY_DIR}/${name}/SKILL.md`;
  try { if (await store.read(path) != null) return { ok: false, code: 'EEXIST', message: `a skill named ${name} already exists` }; } catch (_) {}
  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const status = scan.state === 'quarantined' ? 'quarantined' : 'staged';
  const text = `---\nname: ${name}\ndescription: ${oneLine(description)}\nstatus: ${status}\ncreated: ${now.toISOString()}\n---\n${String(body || '').trim()}\n`;
  await store.write(path, text);
  return { ok: true, path, status, sentinel: sentinelLine(scan) };
}

// ---- Support files ----
// A skill folder may hold more than SKILL.md: reference notes, scripts, templates. Agents get them so a
// skill that says "read references/x.md" or "run bin/y.py" works. Text files only, under caps, and every
// file goes through Sentinel with the body (path, prompt-injection and shell checks), so a clean
// SKILL.md cannot carry a bad script past the gate.
export const SUPPORT_FILE_MAX_BYTES = 128 * 1024;
export const SUPPORT_TOTAL_MAX_BYTES = 512 * 1024;
export const SUPPORT_MAX_FILES = 64;
const utf8Len = (s) => new TextEncoder().encode(String(s)).length;

// Every file path under `dir`, from either listing style (Folder: one level, directories end in "/";
// Crate: flat keys at any depth).
export async function listTree(store, dir, { maxEntries = 500 } = {}) {
  const out = new Set();
  const queue = [dir];
  const seen = new Set();
  while (queue.length && out.size < maxEntries) {
    const d = queue.shift();
    if (seen.has(d)) continue;
    seen.add(d);
    let entries = [];
    try { entries = await store.list(d); } catch (_) { entries = []; }
    for (const e of entries || []) {
      const p = String(typeof e === 'string' ? e : e?.path || '').replace(/^\/+/, '');
      if (!p.startsWith(dir + '/')) continue;
      if (p.endsWith('/')) queue.push(p.slice(0, -1));
      else out.add(p);
    }
  }
  return [...out].sort();
}

// The support files of skills/<dir>/ (everything but SKILL.md), as [{path, content}] with paths
// relative to the skill folder. Over a cap, or an unreadable file, returns { error }.
export async function readSkillFiles(store, dir) {
  const root = `${SKILL_LIBRARY_DIR}/${dir}`;
  const paths = (await listTree(store, root)).filter((p) => p !== `${root}/SKILL.md`);
  if (paths.length > SUPPORT_MAX_FILES) return { files: [], error: `${paths.length} support files > ${SUPPORT_MAX_FILES}` };
  const files = [];
  let total = 0;
  for (const p of paths) {
    let content;
    try { content = await store.read(p); } catch (e) { return { files: [], error: `cannot read ${p}: ${e?.message || e}` }; }
    if (content == null) continue;
    content = String(content);
    const n = utf8Len(content);
    if (n > SUPPORT_FILE_MAX_BYTES) return { files: [], error: `${p.slice(root.length + 1)} is ${n} bytes > ${SUPPORT_FILE_MAX_BYTES}` };
    total += n;
    if (total > SUPPORT_TOTAL_MAX_BYTES) return { files: [], error: `support files exceed ${SUPPORT_TOTAL_MAX_BYTES} bytes` };
    files.push({ path: p.slice(root.length + 1), content });
  }
  return { files };
}

// One usable skill for an agent with its support files, re-scanned as a whole folder at the point of
// use. Returns null when the skill is not usable, and { blocked } when its files do not pass.
export async function agentSkillWithFiles(store, library, name) {
  const s = agentSkill(library, name);
  if (!s) return null;
  const entry = library.find((x) => x.name === name);
  const { files, error } = await readSkillFiles(store, entry.dir || name);
  if (error) return { name, blocked: `Support files refused: ${error}` };
  const scan = scanSkill({ name, description: s.description, body: s.body, files });
  if (scan.state === 'refused' || scan.state === 'quarantined') return { name, blocked: sentinelLine(scan) };
  return { ...s, files };
}

// Settings view: the library with each folder's files counted and scanned too.
export async function loadLibraryWithFiles(store) {
  const lib = await loadLibrary(store);
  for (const s of lib) {
    if (s.status === 'unreadable') continue;
    const { files, error } = await readSkillFiles(store, s.dir);
    s.fileCount = files.length;
    if (error) { s.sentinel = 'refused'; s.sentinelLine = `Support files refused: ${error}`; s.usable = false; continue; }
    if (!files.length) continue;
    const scan = scanSkill({ name: s.name, description: s.description, body: s.body, files });
    s.sentinel = scan.state; s.sentinelLine = sentinelLine(scan);
    if (scan.state === 'refused' || scan.state === 'quarantined') s.usable = false;
  }
  return lib;
}

// ---- Installing a pinned skill pack (ntkit) ----
// `pack` is a pin file (sys/ai/ntkit-pin.json): { id, repo, tag, commit, license, skills: { name: [{ path,
// sha256, bytes }] } }, paths relative to the repository root. `fetchText(path)` returns a file's text at the
// pinned commit. Every file must match its pinned SHA-256, and each skill passes Sentinel as a whole folder,
// before anything is written. A folder the person made themselves (not in the pack's install record) is
// never overwritten. The record lives at skills/.<id>-install.json (a dot name, so it is not a skill).
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function packRecordPath(pack) { return `${SKILL_LIBRARY_DIR}/.${pack.id}-install.json`; }

export async function readPackRecord(store, pack) {
  try { const t = await store.read(packRecordPath(pack)); return t == null ? null : JSON.parse(String(t)); } catch (_) { return null; }
}

export async function installSkillPack(store, pack, fetchText, { onProgress = () => {}, now = new Date() } = {}) {
  const before = await readPackRecord(store, pack);
  const owned = new Set(Object.keys(before?.skills || {}));
  const report = { installed: [], skipped: [], removed: [], files: 0, tag: pack.tag };
  const record = { id: pack.id, repo: pack.repo, tag: pack.tag, commit: pack.commit, installedAt: now.toISOString(), skills: {} };
  const names = Object.keys(pack.skills).sort();
  let done = 0;
  // A skill this pack installed before keeps its record entry when it is skipped now, so a failed
  // update never turns it into "your own skill" on the next run.
  const skip = (name, reason) => { report.skipped.push({ name, reason }); if (owned.has(name)) record.skills[name] = before.skills[name]; };
  for (const name of names) {
    onProgress({ name, done, total: names.length });
    done++;
    if (!validSkillName(name)) { skip(name, 'not a skill name'); continue; }
    const dir = `${SKILL_LIBRARY_DIR}/${name}`;
    let exists = false;
    try { exists = (await store.read(`${dir}/SKILL.md`)) != null; } catch (_) {}
    if (exists && !owned.has(name)) { report.skipped.push({ name, reason: 'you already have your own skill with this name' }); continue; }
    // Fetch and verify every file before writing any of this skill.
    // The files of one skill download together; every one must arrive and match its hash.
    const got = [];
    let bad = null;
    const results = await Promise.all(pack.skills[name].map(async (f) => {
      let text;
      try { text = await fetchText(f.path); } catch (e) { return { error: `download failed for ${f.path}: ${e?.message || e}` }; }
      if ((await sha256Hex(text)) !== f.sha256) return { error: `${f.path} does not match its pinned SHA-256` };
      return { rel: f.as || f.path.slice(f.path.indexOf(`/${name}/`) + name.length + 2), text };
    }));
    for (const r of results) { if (r.error) { bad = r.error; break; } got.push(r); }
    if (bad) { skip(name, bad); continue; }
    const main = got.find((g) => g.rel === 'SKILL.md');
    if (!main) { skip(name, 'no SKILL.md in the pack'); continue; }
    const parsed = parseSkill(main.text);
    const scan = scanSkill({ name, description: parsed.description, body: parsed.body, files: got.filter((g) => g !== main).map((g) => ({ path: g.rel, content: g.text })) });
    if (scan.state === 'refused' || scan.state === 'quarantined') { skip(name, sentinelLine(scan)); continue; }
    for (const g of got) await store.write(`${dir}/${g.rel}`, g.text);
    // Files an earlier install wrote that this version no longer has are removed, each by name.
    const kept = new Set(got.map((g) => g.rel));
    for (const rel of before?.skills?.[name] || []) {
      if (!kept.has(rel) && store.delete) { try { await store.delete(`${dir}/${rel}`); report.removed.push(`${name}/${rel}`); } catch (_) {} }
    }
    record.skills[name] = [...kept].sort();
    report.installed.push(name);
    report.files += got.length;
  }
  // Skills the old version had and this one dropped stay on disk; they are listed, never deleted.
  report.dropped = [...owned].filter((n) => !pack.skills[n]);
  for (const n of report.dropped) record.skills[n] = before.skills[n];
  await store.write(packRecordPath(pack), JSON.stringify(record, null, 1));
  onProgress({ done: names.length, total: names.length });
  return report;
}

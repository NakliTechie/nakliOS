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

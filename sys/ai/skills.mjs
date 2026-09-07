// Progressive-disclosure skills for the coding agent. A skill is a folder at
// .anvil/skills/<name>/SKILL.md in the project workspace (it roams with the
// workspace, like AGENTS.md/memory.md). SKILL.md carries YAML-ish frontmatter
// (name, description) + a body of instructions; the folder may hold supporting
// files the body references.
//
// The cheap part: at task start only the skill DESCRIPTIONS are injected into
// the system context (cache-safe). The agent loads a skill's full body ON DEMAND
// via the `skill` tool when a task matches it. This module is PURE (no fs, no
// browser): the app lists/reads the files and passes the parsed skills in.

export const SKILLS_DIR = '.anvil/skills';

// Parse YAML-ish frontmatter (bare or quoted values, keys lowercased) + body.
// Tolerant: no frontmatter → {meta:{}, body:<whole trimmed text>}. Shared by
// skills and the structured memory store — they're the same progressive-
// disclosure mechanism (description-index + on-demand load).
export function parseFrontmatter(text){
  const s = String(text == null ? '' : text);
  const m = s.match(/^﻿?---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta = {};
  let body = s;
  if (m){
    body = m[2];
    for (const line of m[1].split('\n')){
      const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (kv){
        const key = kv[1].trim().toLowerCase();
        const val = kv[2].trim().replace(/^["']|["']$/g, '');
        meta[key] = val;
      }
    }
  }
  return { meta, body: body.trim() };
}

// Lifecycle (C1/C4): a skill written by hand is the owner's — ACTIVE. One the agent
// writes lands STAGED until a person activates it; Sentinel can land it QUARANTINED;
// the curator ages an unused one STALE then ARCHIVED (never deleted). Only active and
// stale skills are injected; `pinned: true` exempts a skill from aging.
export const SKILL_STATUSES = Object.freeze(['active', 'staged', 'quarantined', 'stale', 'archived']);
export const INJECTED_STATUSES = Object.freeze(['active', 'stale']);

// Parse a SKILL.md — frontmatter (name/description + lifecycle fields) + body.
export function parseSkill(text){
  const { meta, body } = parseFrontmatter(text);
  return {
    name: meta.name || '', description: meta.description || '',
    status: SKILL_STATUSES.includes((meta.status || '').toLowerCase()) ? meta.status.toLowerCase() : 'active',
    pinned: /^(true|yes|1)$/i.test(String(meta.pinned || '')),
    created: meta.created || null, updated: meta.updated || null,
    body,
  };
}

// Build the injected index from [{name, description, status?}]. Descriptions only,
// one per line; a staged, quarantined or archived skill is NOT injected (it does not
// bind); a stale one is, tagged. Returns '' when nothing is injectable.
export function buildSkillsIndex(skills){
  const list = (skills || []).filter(s => s && s.name && INJECTED_STATUSES.includes(s.status || 'active'));
  if (!list.length) return '';
  const lines = list.map(s =>
    `- **${s.name}**: ${String(s.description || '(no description)').replace(/\s+/g, ' ').trim()}${s.status === 'stale' ? ' _(stale — unused for a while; still valid until archived)_' : ''}`);
  return '\n\n# Skills\n' +
    'These named skills are available for THIS project. When a task matches one, ' +
    'call the `skill` tool with its exact name to load its full instructions ' +
    'BEFORE proceeding — do not guess a skill\'s contents.\n\n' +
    lines.join('\n') + '\n';
}

// OpenAI-style tool the agent calls to pull one skill's full body on demand.
export function skillTool(){
  return {
    type: 'function',
    function: {
      name: 'skill',
      description: 'Load a project skill\'s full instructions by name (from the ' +
        'Skills list in your context). Call this before doing a task the skill ' +
        'covers, then follow the returned instructions.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The skill name, exactly as listed in the Skills section.' },
        },
        required: ['name'],
      },
    },
  };
}

// ── the write side of the skills fence (forward-pass NAF-01, second half) ──
//
// The general file tools are refused against SKILLS_DIR by the app, because a file
// there decides what instructions bind and `skill_manage` is the door that scans
// before binding. The shell was NOT covered, so `echo x > .anvil/skills/y/SKILL.md`
// still landed and the load-path sentinel was the only thing left between a
// hand-written skill and the model. This closes the write side.
//
// It refuses MUTATION, not the directory: reading a skill from the shell
// (`cat`, `ls`, `grep`, `rg`, `head`, `wc`) is legitimate and stays allowed. It
// refuses a redirect whose TARGET is under the skills dir, and the mutating
// commands when the dir appears among their arguments.
const SHELL_MUTATORS = /^(rm|mv|cp|mkdir|rmdir|touch|tee|ln|chmod|truncate|install|dd)$/;

// Every redirect target in a command line, in source order (`>`, `>>`, `2>`, `&>`).
function redirectTargets(cmd) {
  const out = [];
  const re = /(?:\d*|&)>{1,2}\s*("[^"]*"|'[^']*'|[^\s;|&()]+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1].replace(/^["']|["']$/g, ''));
  return out;
}

// Does this path (as written) fall inside the skills directory? Compares on
// segments so `.anvil/skills-backup` is NOT inside `.anvil/skills`, and tolerates
// a leading `./` or `/` the way the fileops layer does.
export function underSkillsDir(path) {
  const p = String(path == null ? '' : path).trim().replace(/^["']|["']$/g, '');
  if (!p) return false;
  const norm = p.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
  const want = SKILLS_DIR.split('/');
  const got = norm.split('/');
  if (got.length < want.length) return false;
  return want.every((seg, i) => got[i] === seg);
}

// Returns a refusal string when a shell command would WRITE into the skills dir,
// or null when the command may run. Split on the shell's own separators first, so
// `ls . && echo x > .anvil/skills/a` is judged segment by segment.
export function skillsShellRefusal(command) {
  const cmd = String(command == null ? '' : command);
  if (!cmd.trim()) return null;
  const refusal = `Refused: ${SKILLS_DIR}/ is managed by \`skill_manage\`, which scans a skill before it can bind. Writing there from the shell would bypass that check. Use skill_manage (create/patch); reading the directory from the shell is still allowed.`;
  for (const seg of cmd.split(/(?:\|\||&&|[;|\n])/)) {
    const s = seg.trim();
    if (!s) continue;
    if (redirectTargets(s).some(underSkillsDir)) return refusal;
    const words = s.split(/\s+/).filter(Boolean);
    // skip NAME=value prefixes the shell allows before the verb
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    const verb = (words[i] || '').replace(/^.*\//, '');
    if (!SHELL_MUTATORS.test(verb)) continue;
    if (words.slice(i + 1).some(underSkillsDir)) return refusal;
  }
  return null;
}

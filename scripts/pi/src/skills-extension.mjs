// skills-extension.mjs — the NakliOS skills library in Pi, as a pi-durable extension.
//
// pi-durable has no skills of its own (Pi's skills live in its CLI, which NakliOS does not ship). This
// gives Pi the same progressive disclosure Anvil uses: a `skills` prompt section listing each usable
// skill's name and description (Anvil's buildSkillsIndex), and a `skill` tool that loads one skill's
// full instructions on demand. The library and its gate (Sentinel-clean, active or stale) are the
// host's; `list` and `read` come from naklios.experimental_skills through the page.

import { obj, str } from '@earendil-works/pi-schema';
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { buildSkillsIndex } from '../../../sys/ai/skills.mjs';

// Where a loaded skill's folder is written in Pi's storage, so its references and scripts can be read
// and run. Rewritten on every load, so the copy always matches what the host's gate passed.
export const SKILL_FOLDER_ROOT = '.pi/skills';

export function createSkillsExtension({ list, read }, { fs = null } = {}) {
  async function writeFolder(skill) {
    const root = `${SKILL_FOLDER_ROOT}/${skill.name}`;
    const files = (skill.files || []).filter((f) => f && f.path && !String(f.path).split('/').some((seg) => !seg || seg === '.' || seg === '..'));
    await fs.write(`${root}/SKILL.md`, `---\nname: ${skill.name}\ndescription: ${String(skill.description || '').replace(/\s+/g, ' ').trim()}\n---\n${skill.body}\n`, { createParents: true });
    for (const f of files) await fs.write(`${root}/${f.path}`, String(f.content ?? ''), { createParents: true });
    return { folder: '/' + root, paths: files.map((f) => f.path) };
  }
  const skillTool = defineTool({
    name: 'skill',
    description: 'Load the full instructions of one skill from the NakliOS skills library, by its exact name from the Skills list. Call it before doing a task that a listed skill covers.',
    parameters: obj({ name: str({ description: 'The skill name exactly as listed' }) }),
    execute: async (args) => {
      const skill = await read(String(args.name || ''));
      if (!skill) throw new Error(`No usable skill named "${args.name}". Use a name from the Skills list.`);
      if (skill.blocked) throw new Error(`Skill "${skill.name}" did not pass the safety scan and will not load: ${skill.blocked}`);
      let head = `# Skill: ${skill.name}`;
      if (fs && skill.files && skill.files.length) {
        const { folder, paths } = await writeFolder(skill);
        head += `\n\nSkill folder: ${folder} (its files: ${paths.join(', ')}). Where the skill says $SKILL or "this skill's directory", use ${folder}; read its files from there.`;
      }
      return { output: [{ type: 'text', text: `${head}\n\n${skill.body}` }] };
    },
  });
  return defineExtension({
    name: 'naklios-skills',
    tools: [skillTool],
    // Rendered before each request; pi-durable re-sends it only when the list changed.
    sections: [section('skills', async () => {
      let catalog = [];
      try { catalog = await list(); } catch (_) { catalog = []; }
      const text = buildSkillsIndex(catalog || []);
      return text ? text.trim() : undefined;
    }, { tag: false })],
  });
}

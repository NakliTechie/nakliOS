// skills-extension.mjs — the NakliOS skills library in Pi, as a pi-durable extension.
//
// pi-durable has no skills of its own (Pi's skills live in its CLI, which NakliOS does not ship). This
// gives Pi the same progressive disclosure Anvil uses: a `skills` prompt section listing each usable
// skill's name and description (Anvil's buildSkillsIndex), and a `skill` tool that loads one skill's
// full instructions on demand. The library and its gate (Sentinel-clean, active or stale) are the
// host's; `list` and `read` come from naklios.experimental_skills through the page.

import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { buildSkillsIndex } from '../../../sys/ai/skills.mjs';

export function createSkillsExtension({ list, read }) {
  const skillTool = defineTool({
    name: 'skill',
    description: 'Load the full instructions of one skill from the NakliOS skills library, by its exact name from the Skills list. Call it before doing a task that a listed skill covers.',
    parameters: Type.Object({ name: Type.String({ description: 'The skill name exactly as listed' }) }),
    execute: async (args) => {
      const skill = await read(String(args.name || ''));
      if (!skill) throw new Error(`No usable skill named "${args.name}". Use a name from the Skills list.`);
      return { output: [{ type: 'text', text: `# Skill: ${skill.name}\n\n${skill.body}` }] };
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

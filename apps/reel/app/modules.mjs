/* Every feature module, in install order. index.html installs them; scripts/build-commands.mjs
 * imports them in Node to write commands.json. Order matters only for mount placement. */
import * as rung from './rung/index.mjs';
import * as subtitles from './subtitles/index.mjs';
import * as transport from './transport/index.mjs';
import * as picture from './picture/index.mjs';
import * as platform from './platform/index.mjs';
import * as queue from './queue/index.mjs';
import * as help from './help/index.mjs';
import { COMMANDS as CORE_COMMANDS } from './core/commands.mjs';

export const MODULES = [
  { id: 'rung', mod: rung },
  { id: 'subtitles', mod: subtitles },
  { id: 'transport', mod: transport },
  { id: 'picture', mod: picture },
  { id: 'platform', mod: platform },
  { id: 'queue', mod: queue },
  { id: 'help', mod: help },
];

export function allCommandDefinitions() {
  return [...CORE_COMMANDS, ...MODULES.flatMap(({ mod }) => mod.COMMANDS)];
}

// Registers every command handler on the bus. A handler is registered only when its effect reaches the
// rendered image or the saved file; commands without one answer `unsupported` and stay off the rail.

import { register as core } from './core.js';
import { register as layers } from './layers.js';
import { register as develop } from './develop.js';
import { register as look } from './look.js';
import { register as files } from './files.js';
import { register as select } from './select.js';
import { register as views } from './views.js';
import { register as ai } from './ai.js';
import { register as aiPixels } from './ai-pixels.js';
import { register as aiLibrary } from './ai-library.js';
import { register as aiScene } from './ai-scene.js';
import { register as aiPortrait } from './ai-portrait.js';
import { register as library } from './library.js';
import { register as lens } from './lens.js';
import { register as print } from './print.js';
import { register as styles } from './styles.js';
import { register as warp } from './warp.js';
import { register as actions } from './actions.js';
import { register as recipes } from './recipes.js';
import { register as assist } from './assist.js';
import { register as plugins } from './plugins.js';
import { register as merge } from './merge.js';
import { register as tether } from './tether.js';
import { register as vector } from './vector.js';
import { register as motion } from './motion.js';
import { register as brush } from './brush.js';
import { createStore } from '../document.js';

// ctx: { store, renderer, storage(), host(), engine, sync(), setView(view), staged: Map, jobs: Map, clipboard, snapshots: Map }
export function registerAll(bus, ctx) {
  for (const r of [core, layers, develop, look, files, select, views, aiPixels, aiLibrary, aiScene, aiPortrait, ai, library, lens, print, styles, warp, actions, recipes, assist, plugins, merge, tether, vector, motion, brush]) r(bus, ctx);
}

export function nodeContext() {
  return { store: createStore(), view: {}, renderer: null, storage: () => null, host: () => ({}), engine: null, sync: async () => null, setView: () => {}, staged: new Map(), jobs: new Map(), clipboard: null, snapshots: new Map() };
}

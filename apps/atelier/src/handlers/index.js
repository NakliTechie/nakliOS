// Registers every command handler on the bus. A handler is registered only when its effect reaches the
// rendered image or the saved file; commands without one answer `unsupported` and stay off the rail.

import { register as core } from './core.js';
import { register as layers } from './layers.js';
import { register as develop } from './develop.js';
import { register as look } from './look.js';
import { register as files } from './files.js';
import { register as select } from './select.js';
import { createStore } from '../document.js';

// ctx: { store, renderer, storage(), host(), engine, sync(), setView(view), staged: Map, jobs: Map, clipboard, snapshots: Map }
export function registerAll(bus, ctx) {
  for (const r of [core, layers, develop, look, files, select]) r(bus, ctx);
}

export function nodeContext() {
  return { store: createStore(), view: {}, renderer: null, storage: () => null, host: () => ({}), engine: null, sync: async () => null, setView: () => {}, staged: new Map(), jobs: new Map(), clipboard: null, snapshots: new Map() };
}

// Thin wrapper over the vendored Mol* viewer.
//
// `vendor/molstar/5.13.1/molstar.js` is an IIFE bundle that assigns a global, so it is read from
// `window.molstar` rather than imported. Everything else in `app/` talks to the viewer through
// this file, so swapping the viewer later touches one module.

let viewer = null;

function bundle() {
  const ms = window.molstar;
  if (!ms || !ms.Viewer) {
    throw new Error('The Mol* bundle did not load. Check vendor/molstar/5.13.1/molstar.js is present.');
  }
  return ms;
}

export function version() {
  return window.molstar && window.molstar.version ? window.molstar.version : 'unknown';
}

export async function create(host) {
  viewer = await bundle().Viewer.create(host, {
    layoutIsExpanded: false,
    layoutShowControls: false,
    layoutShowSequence: false,
    layoutShowLog: false,
    layoutShowLeftPanel: false,
    viewportShowExpand: true,
    viewportShowSelectionMode: true,
    viewportShowAnimation: false,
    pdbProvider: 'rcsb',
    emdbProvider: 'rcsb',
  });
  followColourScheme();
  return viewer;
}

// Match the viewport to the page so the app reads as one surface. The page is light whatever the
// operating system is set to, so this is a fixed colour and not a media query.
// The bundle does not export Mol*'s `Color` helper, but a `Color` is a plain packed RGB integer.
function followColourScheme() {
  try {
    viewer.plugin.canvas3d.setProps({ renderer: { backgroundColor: 0xfafaf8 } });
  } catch {
    // A viewport stuck on Mol*'s default background is cosmetic, never worth failing over.
  }
}

function need() {
  if (!viewer) throw new Error('The viewer is not ready yet.');
  return viewer;
}

/**
 * Work out the Mol* format name and whether the payload is binary, from a file name.
 * @returns {{format: string, binary: boolean, gzipped: boolean}}
 */
export function detectFormat(filename) {
  let name = filename.toLowerCase();
  let gzipped = false;

  if (name.endsWith('.gz')) {
    gzipped = true;
    name = name.slice(0, -3);
  }

  const table = [
    ['.bcif', 'bcif', true],
    ['.cif', 'mmcif', false],
    ['.mmcif', 'mmcif', false],
    ['.pdb', 'pdb', false],
    ['.ent', 'pdb', false],
    ['.pdbqt', 'pdbqt', false],
    ['.gro', 'gro', false],
    ['.mol', 'mol', false],
    ['.sdf', 'sdf', false],
  ];

  for (const [ext, format, binary] of table) {
    if (name.endsWith(ext)) return { format, binary, gzipped };
  }
  throw new Error(`Protavia does not know the format of "${filename}". Use .pdb, .cif or .bcif.`);
}

export async function loadData(data, format, label) {
  await need().loadStructureFromData(data, format, { dataLabel: label });
}

export async function loadPdbId(id) {
  await need().loadPdb(id);
}

export async function clear() {
  await need().plugin.clear();
}

export function handleResize() {
  if (viewer) viewer.handleResize();
}

/** The `Structure` for what is currently loaded, or null. */
export function loadedStructure() {
  const current = need().plugin.managers.structure.hierarchy.current;
  const first = current && current.structures && current.structures[0];
  const data = first && first.cell && first.cell.obj && first.cell.obj.data;
  return data || null;
}

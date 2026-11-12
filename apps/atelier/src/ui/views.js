// Mounts the view features: a Views button group in the header (compare, before and after, node view,
// slideshow, print, web gallery, map, command palette) and the Scopes and Preset previews sections in the
// side panel. Each button's data-view-label is its parity-table row, so the palette can find it.

import { h } from './dom.js';
import { createScopes } from './scopes.js';
import { createPalette } from './palette.js';
import { createViewer } from './compare.js';
import { createPresetPreview } from './presetpreview.js';
import { createNodeView } from './nodes.js';
import { createModules } from './modules.js';
import { createRecipes } from './recipes.js';

export function mountViews(ui) {
  const aside = document.querySelector('aside');
  const scopes = createScopes(aside, ui);
  const presets = createPresetPreview(aside, ui);
  const palette = createPalette(ui);
  const viewer = createViewer(ui);
  const nodes = createNodeView(ui);
  const selection = () => ui.filmstrip?.selected ?? [];
  const modules = createModules(ui, { selection });

  const recipes = createRecipes(aside, ui, { viewer, selection });
  const b = (label, text, title, onclick) => h('button', { dataset: { viewLabel: label }, title, onclick }, text);
  const bar = h('div', { class: 'seg views-bar', role: 'group', 'aria-label': 'Views' },
    b('Compare view: 2 to 4 selected photos side by side, synced zoom', 'Compare', 'Compare 2 to 4 photos selected in the filmstrip', () => viewer.compare(selection())),
    b('Before and after: split or side by side', 'Before/after', 'Before (no develop) and after, split', () => ui.send('set_view', { beforeAfter: 'split' })),
    b('Node view of the layer stack', 'Nodes', 'The layer stack as a node graph', () => nodes.open()),
    b('Slideshow (filmstrip selection, timed, full window)', 'Slideshow', 'Full-window slideshow of the selection, or the folder', () => modules.startSlideshow()),
    b('Print: contact sheet or one photo per page', 'Print…', 'Print or save as PDF through the browser', () => modules.print()),
    b('Web gallery export…', 'Gallery…', 'Write a static web gallery into the workspace', () => modules.gallery()),
    b('Map of photos by GPS', 'Map', 'Photos placed by their EXIF GPS', () => modules.map()),
    b('Book: make a Paginella photo book of the selected photos', 'Book…', 'One photo per page; opens in Paginella in NakliOS', () => modules.book()),
    b('Command palette (Ctrl+K)', '⌘K', 'Search commands by task (Ctrl+K or Cmd+K)', () => palette.open()));
  ui.ctx.showBeforeAfter = (mode) => viewer.setBeforeAfter(mode);   // set_view beforeAfter draws here
  const header = document.querySelector('header');
  header.insertBefore(bar, header.querySelector('.grow'));

  return {
    scopes, presets, palette, viewer, nodes, modules, recipes,
    render() { scopes.render(); presets.render(); recipes.render(); if (nodes.isOpen) nodes.render(); },
  };
}

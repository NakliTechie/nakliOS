// The parity table (spec 002 §6.3, §9.5): every UI control maps to a manifest command, to `view` (it
// changes only what the panel shows, never the document or a file), or to `person: <reason>` (an act only
// the person can do). tests/ui.test.mjs checks that every command named here exists in the manifest and
// that every command the UI sends appears here. scripts/build-commands-json.mjs can publish it as
// commands.json `parity`.

export const PARITY = [
  // header
  ['Develop / Composite mode switch (Ctrl+1, Ctrl+2)', 'set_view'],
  ['Undo (Ctrl+Z)', 'undo'],
  ['Redo (Ctrl+Shift+Z)', 'redo'],
  ['New document', 'new_document'],
  ['Save (Ctrl+S) and autosave', 'save_document'],
  ['Export dialog (Ctrl+Shift+E in Develop)', 'export_image'],
  ['Open folder', 'person: File System Access needs a user gesture (grant_folder)'],
  ['Storage settings when hosted', 'person: the host owns the Folder or Crate connection (grant_folder)'],
  // filmstrip
  ['Filmstrip filters (rating, flag, label) and page', 'list_folder'],
  ['Filmstrip tile click', 'open_photo'],
  ['Filmstrip Ctrl/Shift click multi-select', 'view'],
  ['Star rating, pick, reject, colour label (0–5, P, X, U, 6–9)', 'set_rating'],
  ['Place as layer', 'open_photo'],
  ['Sync… (copy then sync to the selection)', 'sync_settings'],
  // develop panel
  ['Basic, Effects, Parametric curve, Detail, Lens, Transform and Calibration sliders', 'set_develop'],
  ['Tone curve point editor and channel reset', 'set_tone_curve'],
  ['Curve channel menu', 'view'],
  ['Colour mixer bands and mode', 'set_color_mixer'],
  ['Mixer Hue / Saturation / Luminance tabs', 'view'],
  ['Colour grading wheels, luminance, blending, balance', 'set_color_grading'],
  ['Crop aspect, straighten, reset; develop crop tool (R)', 'set_crop'],
  ['Linear (M) and radial (Shift+M) mask tools', 'set_mask'],
  ['Brush mask tool (K)', 'paint_mask'],
  ['Mask adjustment sliders', 'set_mask_adjustments'],
  ['Mask list: choose a mask', 'view'],
  ['Mask list: show or hide', 'set_layer'],
  ['Mask list: delete', 'delete_layer'],
  ['Apply preset menu', 'apply_preset'],
  ['Preset menu contents', 'list_presets'],
  ['Save preset', 'save_preset'],
  ['Copy settings (Ctrl+Shift+C)', 'copy_settings'],
  ['Paste settings (Ctrl+Shift+V)', 'sync_settings'],
  ['Reset all', 'reset_develop'],
  ['Panel values (read back)', 'get_develop'],
  // layers panel
  ['Layer visibility, lock, opacity, blend mode, rename', 'set_layer'],
  ['Layer click (make active)', 'set_active'],
  ['Layer Ctrl click multi-select', 'view'],
  ['Layer drag to reorder', 'move_layer'],
  ['New layer, New group', 'add_layer'],
  ['Group (Ctrl+G), Ungroup (Ctrl+Shift+G)', 'group_layers'],
  ['Duplicate (Ctrl+J)', 'duplicate_layer'],
  ['Merge down (Ctrl+E), merge picked, merge visible (Ctrl+Shift+E in Composite)', 'merge_layers'],
  ['Delete layer', 'delete_layer'],
  // tools
  ['Tool bar buttons and tool keys', 'view'],
  ['Tool options (size, hardness, opacity, flow, colours, tolerance, mode)', 'view'],
  ['Move tool drag', 'transform_layer'],
  ['Rectangle, ellipse, lasso, wand; Select all (Ctrl+A), Deselect (Ctrl+D)', 'set_selection'],
  ['Invert (Ctrl+Shift+I), Feather…', 'refine_selection'],
  ['Brush and eraser strokes', 'paint_stroke'],
  ['Fill bucket and gradient', 'fill'],
  ['Type tool click', 'add_layer'],
  ['Type tool placement', 'transform_layer'],
  ['Crop tool (composite)', 'crop_document'],
  ['Hand, zoom, wheel, Fit (Ctrl+0), 100%, zoom keys (Ctrl+=, Ctrl+-)', 'set_view'],
  // staged and durability
  ['Staged action Confirm', 'person: confirming a staged write is the person’s decision (confirm_staged)'],
  ['Staged action Discard', 'person: discarding a staged write is the person’s decision'],
  ['Changed-elsewhere dialog: Reload', 'open_photo'],
  ['Changed-elsewhere dialog: Keep mine', 'save_document'],
  ['Changed-elsewhere dialog: Later', 'view'],
  ['Disconnected notice: Save to this browser', 'person: choosing a different storage location copies data, so the person decides'],
];

export const parityCommands = () => [...new Set(PARITY.map(([, c]) => c).filter((c) => c !== 'view' && !c.startsWith('person:')))];

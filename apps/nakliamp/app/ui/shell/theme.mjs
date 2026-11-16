// theme.mjs — which theme the page shows (V4). Light is the standalone default.
//
// settings.theme is 'system' | 'light' | 'dark'. 'system' means the NakliOS host
// theme when hosted, and light otherwise (Chirag prefers light app UIs, so the
// browser's own dark preference does not switch a standalone page).
// Inside NakliOS on 'system', the host's colours also replace the page tokens.

/** 'light' | 'dark' for a setting, the hosted flag and the host theme (`{ mood }`). */
export function resolveTheme(setting, { hosted = false, host = null } = {}) {
  if (setting === 'light' || setting === 'dark') return setting;
  if (hosted && host) return isDarkHost(host) ? 'dark' : 'light';
  return 'light';
}

/** Chartella's rule for a host theme: dark and cool moods are dark; warm is dark on a dark body. */
export function isDarkHost(host) {
  const mood = host?.mood;
  const body = String(host?.colors?.BODY ?? '');
  return mood === 'dark' || mood === 'cool' || (mood === 'warm' && /^#[0-3]/.test(body));
}

/**
 * CSS custom properties for a host theme's colours, or {} when it has none.
 * Derived tokens use color-mix so contrast follows the host's ink and panel.
 */
export function hostTokens(host) {
  const c = host?.colors;
  if (!c || typeof c !== 'object') return {};
  const out = {};
  const set = (name, value) => { if (typeof value === 'string' && value) out[name] = value; };
  set('--bg', c.BODY);
  set('--panel', c.PANEL);
  set('--text', c.INK);
  set('--ink', c.INK);
  set('--line', c.ROW);
  set('--accent', c.ACT);
  if (c.PANEL && c.INK) set('--panel-2', `color-mix(in srgb, ${c.INK} 7%, ${c.PANEL})`);
  if (c.INK) {
    set('--muted', `color-mix(in srgb, ${c.INK} 66%, transparent)`);
    set('--faint', `color-mix(in srgb, ${c.INK} 55%, transparent)`);
  }
  return out;
}

export const HOST_TOKEN_NAMES = Object.freeze(['--bg', '--panel', '--panel-2', '--text', '--ink', '--line', '--accent', '--muted', '--faint']);

/**
 * Apply the theme to `root` (document.documentElement): data-theme, color-scheme
 * and, for a hosted page on 'system', the host colours. Returns the theme applied.
 */
export function applyTheme(root, setting, { hosted = false, host = null } = {}) {
  const theme = resolveTheme(setting, { hosted, host });
  root.dataset.theme = theme;
  const tokens = setting === 'system' && hosted ? hostTokens(host) : {};
  for (const name of HOST_TOKEN_NAMES) {
    if (tokens[name]) root.style.setProperty(name, tokens[name]);
    else root.style.removeProperty(name);
  }
  return theme;
}

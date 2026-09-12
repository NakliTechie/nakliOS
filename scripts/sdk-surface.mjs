// The SDK's public surface, read out of sdk/naklios.js by running it standalone (window.parent ===
// window, so every call is a no-op) and walking `window.naklios`. This is what docs/sdk-api-audit.md
// must account for, member by member — never a list typed by hand.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function sdkSurface(source = readFileSync(new URL('../sdk/naklios.js', import.meta.url), 'utf8')) {
  const win = {
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    location: { search: '', href: 'http://app.test/', origin: 'http://app.test' },
    document: { referrer: '', addEventListener() {}, documentElement: { dataset: {}, style: {} }, querySelector() { return null; } },
    navigator: { userAgent: '' }, setTimeout, clearTimeout, console,
  };
  win.window = win; win.parent = win; win.self = win; win.top = win; win.globalThis = win;
  vm.runInNewContext(source, win, { filename: 'naklios.js' });
  if (!win.naklios) throw new Error('sdk/naklios.js did not define window.naklios when run standalone');
  const out = [];
  const walk = (o, prefix, depth) => {
    for (const k of Object.getOwnPropertyNames(o)) {
      const d = Object.getOwnPropertyDescriptor(o, k);
      const p = prefix ? prefix + '.' + k : k;
      if (d.get) out.push({ member: p, kind: 'getter' });
      else if (typeof d.value === 'function') out.push({ member: p, kind: 'function' });
      else if (d.value && typeof d.value === 'object' && !Array.isArray(d.value)) {
        // a namespace deeper than the walk goes would hide its members as a "field" for ever — refuse
        if (depth >= 3) throw new Error(`${p} is an object at depth ${depth + 1}; raise the walk depth in scripts/sdk-surface.mjs so its members are audited`);
        out.push({ member: p, kind: 'namespace' }); walk(d.value, p, depth + 1);
      }
      else out.push({ member: p, kind: 'field' });
    }
  };
  walk(win.naklios, '', 0);
  return out;
}

import { TEX_VERSION } from '../sys/tex/version.mjs';

// naklios.dev's Worker: static assets, plus the TeX engine files. Those stay on a GitHub Release, because release files
// carry no CORS header and two of them exceed GitHub's 100 MB repo limit, so this Worker streams them to the same origin.
const RELEASE = `https://github.com/NakliTechie/naklios-tex/releases/download/engine-${TEX_VERSION}/`;
const TYPES = { js:'text/javascript; charset=utf-8', wasm:'application/wasm', data:'application/octet-stream', txt:'text/plain; charset=utf-8', cnf:'text/plain; charset=utf-8', profile:'text/plain; charset=utf-8' };

export async function texAsset(request, load = fetch) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status:405, headers:{ Allow:'GET, HEAD' } });
  const [, version, name] = /^\/tex\/([^/]+)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(new URL(request.url).pathname) || [];
  const type = TYPES[name?.split('.').pop()];
  if (version !== TEX_VERSION || !type) return new Response('Not found', { status:404 });
  const range = request.headers.get('Range');
  const upstream = await load(RELEASE + name, { method:request.method, redirect:'follow', headers:range ? { Range:range } : {} });
  if (upstream.status !== 200 && upstream.status !== 206) return new Response('Not found', { status:upstream.status === 404 ? 404 : 502 });
  const headers = new Headers({ 'Content-Type':type, 'Cache-Control':'public, max-age=31536000, immutable', 'X-Content-Type-Options':'nosniff' });
  for (const key of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag']) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }
  return new Response(upstream.body, { status:upstream.status, headers });
}

export default {
  fetch(request, env) {
    return new URL(request.url).pathname.startsWith('/tex/') ? texAsset(request) : env.ASSETS.fetch(request);
  },
};

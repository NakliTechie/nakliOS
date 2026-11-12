// The network guard every model worker installs before transformers.js loads (spec 002 §9.4: nothing leaves
// the device except the model download itself, and only for a model the person consented to).
// hfGuard is stringified into the worker source, so it must stay self-contained (no imports, no closures).

// url: the request URL; repos: a Set of consented Hugging Face repo ids. → { ok, reason }
export function hfGuard(url, repos) {
  let u;
  try { u = new URL(url, 'https://invalid.invalid/'); } catch { return { ok: false, reason: `blocked: unparsable URL ${url}` }; }
  if (u.protocol === 'blob:' || u.protocol === 'data:') return { ok: true, reason: 'local' };
  if (u.protocol !== 'https:') return { ok: false, reason: `blocked: ${u.protocol} request ${url}` };
  // The model library and its WebAssembly runtime come from the pinned CDN path.
  if (u.hostname === 'cdn.jsdelivr.net' && (u.pathname.startsWith('/npm/@huggingface/') || u.pathname.startsWith('/npm/onnxruntime-'))) return { ok: true, reason: 'library' };
  if (u.hostname === 'huggingface.co' || u.hostname === 'hf.co') {
    for (const repo of repos) if (u.pathname.startsWith(`/${repo}/resolve/`)) return { ok: true, reason: `model ${repo}` };
    return { ok: false, reason: `blocked: ${u.pathname.split('/').slice(1, 3).join('/')} is not a model the person downloaded` };
  }
  return { ok: false, reason: `blocked: ${u.hostname} is not a model host` };
}

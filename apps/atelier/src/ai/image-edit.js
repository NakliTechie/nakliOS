// Text-prompted generative fill (P42) through the person's own image-edit endpoint (BYOK). It reuses the
// BYOK record of src/ai/text.js (endpoint, key; on only when the person turned it on) and adds one setting
// of its own, the image model id, kept in this browser only. With either missing the feature is off.
// The request is the OpenAI-compatible POST <endpoint>/images/edits (multipart: model, prompt, image,
// mask, n, size); the reply carries data[0].b64_json or data[0].url. Nothing is sent unless the person
// set this up; tests use a fake provider on localhost.

import { readByok } from './text.js';

const KEY = 'atelier.ai.imageModel';
export function readImageModel(storage = globalThis.localStorage) { try { return String(storage?.getItem(KEY) || '').trim(); } catch { return ''; } }
export function writeImageModel(v, storage = globalThis.localStorage) { const s = String(v || '').trim(); if (s) storage?.setItem(KEY, s); else storage?.removeItem(KEY); return s; }

// settings(): { enabled, endpoint, key }; imageModel(): the model id. → null when off, else the route.
export function imageEditRoute({ settings = () => readByok(), imageModel = () => readImageModel() } = {}) {
  const s = settings(); const m = imageModel();
  if (!s?.enabled || !/^https?:\/\//.test(s.endpoint || '') || !m) return null;
  return { endpoint: s.endpoint.replace(/\/+$/, ''), key: s.key || '', model: m, label: `${m} at ${new URL(s.endpoint).host}` };
}

// image, mask: PNG bytes of the same square size; the mask is transparent where the model may paint.
// Returns the edited image as PNG (or other encoded) bytes.
export async function imageEdit(route, { prompt, image, mask, size }, { fetchFn = (...a) => fetch(...a), signal } = {}) {
  const form = new FormData();
  form.append('model', route.model); form.append('prompt', prompt); form.append('n', '1'); form.append('size', `${size}x${size}`);
  form.append('image', new Blob([image], { type: 'image/png' }), 'image.png');
  form.append('mask', new Blob([mask], { type: 'image/png' }), 'mask.png');
  const res = await fetchFn(`${route.endpoint}/images/edits`, { method: 'POST', body: form, signal, headers: route.key ? { Authorization: `Bearer ${route.key}` } : {} });
  if (!res.ok) throw new Error(`the image endpoint answered ${res.status}`);
  const j = await res.json(); const d = j?.data?.[0];
  if (d?.b64_json) { const b = atob(d.b64_json); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  if (d?.url) return new Uint8Array(await (await fetchFn(d.url, { signal })).arrayBuffer());
  throw new Error('the image endpoint returned no image');
}

// The square region sent for a hole box b in a W × H image: the box grown by half its larger side (at
// least 64 px), made square, clamped inside the image (shrunk if the image is smaller).
export function editSquare(b, W, H) {
  const m = Math.max(64, Math.round(Math.max(b.w, b.h) / 2));
  let side = Math.min(Math.max(b.w, b.h) + 2 * m, W, H);
  const cx = b.x + b.w / 2; const cy = b.y + b.h / 2;
  let x = Math.round(cx - side / 2); let y = Math.round(cy - side / 2);
  x = Math.max(0, Math.min(W - side, x)); y = Math.max(0, Math.min(H - side, y)); side = Math.round(side);
  return { x, y, w: side, h: side };
}

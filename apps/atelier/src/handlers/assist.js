// AI describe and rate (L65) and the AI edit assistant (L67), through src/ai/text.js (host AI or the
// person's own key). Both are removable: with no AI set up they answer `unsupported` and the app is unchanged.
// describe returns a suggestion only; the person's Accept writes it with set_keywords, set_rating and
// set_caption. The assistant's settings are validated against set_develop's schema and applied by
// dispatching set_develop once, so they are one undoable step that names the AI as its caller.

import { textAi, firstJson } from '../ai/text.js';
import { validate } from '../bus.js';
import { DEVELOP_RENDERED } from '../../vendor/tessella/src/model.js';
import { photoDocument } from './views.js';
import { sidecarPath, normalizeSidecar, sidecarText, baseName } from '../files/workspace.js';
import { needDoc, needLayer, fail, stageOrRun } from './util.js';
import { serial } from '../storage.js';

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

export const DESCRIBE_PROMPT = 'You describe photographs for a photo library. Answer with one JSON object only: {"caption": one plain sentence of at most 25 words, "keywords": 3 to 10 lowercase single words or short phrases, "rating": an integer 1 to 5 for technical and visual quality}.';

export function checkDescription(j) {
  if (!j || typeof j !== 'object') return { error: 'the reply held no JSON object' };
  const caption = typeof j.caption === 'string' ? j.caption.trim().slice(0, 300) : '';
  const keywords = Array.isArray(j.keywords) ? [...new Set(j.keywords.filter((k) => typeof k === 'string').map((k) => k.trim().toLowerCase().replace(/[,;]/g, ' ').slice(0, 100)).filter(Boolean))].slice(0, 10) : [];
  const rating = Number.isInteger(j.rating) && j.rating >= 1 && j.rating <= 5 ? j.rating : null;
  if (!caption && !keywords.length && rating === null) return { error: 'the reply had no caption, keywords or rating' };
  return { caption, keywords, rating };
}

export function register(bus, ctx) {
  const ai = () => {
    const a = ctx.aiText ? ctx.aiText() : textAi();
    if (!a.available) fail('unsupported', 'no AI is set up: turn on your own key in AI settings, or use Atelier in NakliOS with AI on; Atelier works fully without it', 'use_ui_control', 'get_capabilities');
    return a;
  };
  async function jpegOf(doc, maxEdge = 768) {
    const r = ctx.renderer;
    if (!r) fail('unsupported', 'this command needs the WebGPU engine', 'get_state', 'get_capabilities');
    try {
      await r.sync(doc);
      const im = await r.resize(await r.image8(r.lodFor(doc, maxEdge), null, 0.18), maxEdge);
      return `data:image/jpeg;base64,${b64(await r.encode(im, 'image/jpeg', 0.85))}`;
    } finally { if (ctx.store.doc) await r.sync(ctx.store.doc); }
  }

  // Photo pixels leave the device only on the person's say: through the person's own key, a call from any
  // door other than their own click (window, modelContext, a plugin) is staged for them to confirm. The
  // NakliOS host route is unchanged, because the host reviews what reaches its broker.
  const gate = (engine, door, tool, summary, run) => (engine.route === 'own key' ? stageOrRun(ctx, { door }, tool, summary, run) : run());

  bus.register('ai.describe', async (a, { door }) => {
    const engine = ai();
    let doc; let path = a.path ?? ctx.store.doc?.photo?.path ?? null;
    if (a.path) { if (!ctx.storage()) fail('unsupported', 'no workspace storage', 'use_ui_control', 'grant_folder'); doc = await photoDocument(ctx, a.path); } else doc = structuredClone(needDoc(ctx));
    return gate(engine, door, 'ai_describe', `send ${path ?? 'the open photo'} (768 px JPEG) to your own AI endpoint (${engine.label}) for a caption, keywords and rating`, async () => {
      const image = await jpegOf(doc);
      const text = await engine.chat([{ role: 'system', content: DESCRIBE_PROMPT }, { role: 'user', content: [{ type: 'text', text: 'Describe this photo.' }, { type: 'image_url', image_url: { url: image } }] }], { max_tokens: 400 });
      const d = checkDescription(firstJson(text));
      if (d.error) fail('outcome_unknown', `${d.error}; nothing written`, 'get_state', 'ai_describe');
      return { path, suggestion: d, route: engine.route, model: engine.label, note: 'a suggestion: nothing is written until the person accepts it (set_keywords, set_rating, set_caption)' };
    });
  });

  // The caption is the sidecar's `caption` field (<photo>.atelier.json beside the photo); an empty
  // caption removes it. Every check runs before the first write, so a bad path writes nothing. Each sidecar
  // read-modify-write runs under the per-path lock (serial), as library.js does, so a concurrent set_rating
  // or set_keywords on the same photo is not lost.
  bus.register('library.caption', async (a, { viewOnly }) => {
    viewOnly();
    const s = ctx.storage(); if (!s) fail('unsupported', 'no workspace storage', 'use_ui_control', 'grant_folder');
    for (const p of a.paths) if (!(await s.exists(p))) fail('invalid', `no file ${p}`, 'fix_argument', 'list_folder');
    const caption = String(a.caption).trim().slice(0, 2000);
    const out = [];
    for (const p of a.paths) {
      const sp = sidecarPath(p);
      out.push(await serial(sp, async () => {
        let raw = {};
        if (await s.exists(sp)) { try { raw = JSON.parse(await s.readText(sp)); } catch { fail('invalid', `${sp} is not valid JSON; fix or remove it first`, 'fix_argument', 'list_folder'); } }
        const next = normalizeSidecar({ ...raw, caption }, DEVELOP_RENDERED);
        if (!caption) delete next.caption;
        await s.write(sp, new TextEncoder().encode(sidecarText(next, baseName(p))));
        return { path: p, sidecar: sp, caption: next.caption ?? null };
      }));
    }
    return { photos: out };
  });

  bus.register('ai.develop', async (a, { viewOnly, door }) => {
    viewOnly();   // the change itself is the set_develop dispatched below
    const engine = ai();
    const doc = needDoc(ctx);
    const l = needLayer(ctx, a.layerId ?? doc.activeLayerId);
    if (l.kind !== 'raw' || l.localOf) fail('unsupported', 'the assistant suggests develop settings for a RAW layer', 'change_target', 'open_photo');
    const schema = bus.manifest.tools.find((t) => t.name === 'set_develop').inputSchema.properties.params;
    const allowed = Object.entries(schema.properties).filter(([k]) => DEVELOP_RENDERED.includes(k)).map(([k, v]) => `${k} (${v.minimum ?? '?'} to ${v.maximum ?? '?'})`).join(', ');
    // The suggestion is for the document as it is when the work starts: the inner set_develop carries that
    // revision, so an edit made while the AI answers makes it answer stale instead of being overwritten.
    return gate(engine, door, 'ai_suggest_develop', `send the open photo (768 px JPEG) to your own AI endpoint (${engine.label}) and apply its develop suggestion`, async () => {
      const rev0 = bus.state.revision;
      const image = await jpegOf(structuredClone(doc));
      const ask = `Suggest develop settings for this photo${a.instruction ? `; the person asks: ${String(a.instruction).slice(0, 500)}` : ''}. Current settings: ${JSON.stringify(l.develop || {})}. Answer with one JSON object of settings to change, only these keys and ranges: ${allowed}.`;
      const text = await engine.chat([{ role: 'system', content: 'You are a photo editor. Answer with JSON only.' }, { role: 'user', content: [{ type: 'text', text: ask }, { type: 'image_url', image_url: { url: image } }] }], { max_tokens: 400 });
      const params = firstJson(text);
      if (!params || !Object.keys(params).length) fail('outcome_unknown', 'the reply held no settings; nothing applied', 'get_state', 'ai_suggest_develop');
      const bad = validate(schema, params);
      if (bad) fail('invalid', `the AI suggested ${bad.field} = ${JSON.stringify(bad.sent)}, outside ${JSON.stringify(bad.allowed)}; nothing applied`, 'fix_argument', 'ai_suggest_develop');
      const unrendered = Object.keys(params).filter((k) => !DEVELOP_RENDERED.includes(k));
      if (unrendered.length) fail('unsupported', `the AI suggested settings Atelier does not render (${unrendered.join(', ')}); nothing applied`, 'fix_argument', 'ai_suggest_develop');
      const r = await bus.dispatch('set_develop', { revision: rev0, layerId: l.id, params }, { door, caller: `AI assistant (${engine.route})` });
      if (r.status !== 'ok') fail(r.status, r.error?.message ?? (r.status === 'stale' ? 'the document changed while the AI answered; nothing applied' : 'set_develop refused the suggestion'), 'get_state', 'get_develop');
      return { layerId: l.id, applied: params, route: engine.route, model: engine.label, undo: 'one undo step' };
    });
  });
}

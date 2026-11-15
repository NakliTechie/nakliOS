// The image-input rail (2026-11-15, for Loquella): an agent request's user turn may carry
// OpenAI image_url parts with a base64 data URL. Endpoints receive them as sent (OpenAI shape)
// or as Anthropic base64 image blocks; the browser models refuse them with the reason.
//
// Before this rail normaliseAgentMessages refused any non-text content, so no app could
// show a model a picture.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normaliseAgentMessages, parseImageDataUrl, messagesHaveImages, IMAGE_LIMITS,
} from '../sys/ai/agent-protocol.mjs';
import { toAnthropicRequest } from '../sys/ai/anthropic-protocol.mjs';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const sdk = await readFile(new URL('../sdk/naklios.js', import.meta.url), 'utf8');

// a 1×1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const url = `data:image/png;base64,${PNG}`;
const turn = { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url, detail: 'high' } }] };

// ── normalising ───────────────────────────────────────────────────────
{
  const [out] = normaliseAgentMessages([turn]);
  assert.deepEqual(out, turn, 'a valid parts array passes unchanged');
  assert.equal(messagesHaveImages([turn]), true);
  assert.equal(messagesHaveImages([{ role: 'user', content: 'text' }]), false);
  assert.equal(parseImageDataUrl(url).bytes, 70, 'bytes are the decoded size');
}
assert.throws(() => normaliseAgentMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }]),
  /base64 data: URL/, 'remote image URLs are refused: the host does not fetch for the app');
assert.throws(() => normaliseAgentMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/svg+xml;base64,${PNG}` } }] }]),
  /not accepted/, 'only PNG, JPEG, WebP and GIF');
assert.throws(() => normaliseAgentMessages([{ role: 'user', content: [] }]), /must not be empty/);
assert.throws(() => normaliseAgentMessages([{ role: 'user', content: [{ type: 'audio', data: 'x' }] }]), /text or image_url/);
assert.throws(() => normaliseAgentMessages([{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }]),
  /must be text/, 'only user turns carry parts');
{
  const big = 'A'.repeat(Math.ceil((IMAGE_LIMITS.maxImageBytes + 4) / 3) * 4);
  assert.throws(() => parseImageDataUrl(`data:image/png;base64,${big}`), /at most 8 MB/);
}
{
  const many = Array.from({ length: IMAGE_LIMITS.maxImages + 1 }, () => ({ type: 'image_url', image_url: { url } }));
  assert.throws(() => normaliseAgentMessages([{ role: 'user', content: many }]), /at most 16 images/);
}
{
  const [out] = normaliseAgentMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url, detail: 'bogus' } }] }]);
  assert.equal('detail' in out.content[0].image_url, false, 'an unknown detail value is dropped');
}

// ── Anthropic conversion ──────────────────────────────────────────────
{
  const body = toAnthropicRequest({ messages: [{ role: 'system', content: 's' }, turn], maxTokens: 100 });
  const blocks = body.messages[0].content;
  assert.deepEqual(blocks[0], { type: 'text', text: 'What is this?' });
  assert.deepEqual(blocks[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
}

// ── host wiring ───────────────────────────────────────────────────────
assert.match(html, /proto\.messagesHaveImages\(messages\) && model\.runtime !== 'endpoint'/,
  'the browser models refuse image parts before queueing');
assert.match(html, /experimental_aiVision:aiModel\.runtime === 'endpoint'/);
assert.match(sdk, /capabilities\.experimental_aiVision = msg\.experimental_aiVision === true/);

console.log('test-ai-image-inputs: ok');

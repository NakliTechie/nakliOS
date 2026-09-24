import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const sdkSource = await readFile(new URL('sdk/naklios.js', root), 'utf8');
const catalogSource = await readFile(new URL('vendor/localmind/host-model-catalog.js', root), 'utf8');

assert.match(html, /vendor\/localmind\/host-model-catalog\.js/);
assert.match(html, /new URL\(`vendor\/localmind\/\$\{model\.worker\}`, document\.baseURI\)/);
assert.match(html, /const AI_MAX_QUEUE = 12/);
assert.match(html, /const AI_MAX_QUEUE_PER_APP = 3/);
assert.match(html, /function aiNextRequest\(\)[\s\S]*?request\.appId !== aiHost\.lastAppId/);
assert.match(html, /function aiNormaliseMessages\(messages\)/);
assert.match(html, /function aiHostCancelSource\(source\)/);
assert.match(html, /aiHostCancelSource\(iframe\.contentWindow\)/);
assert.match(html, /max_tokens:request\.maxTokens,[\s\S]*?reset:true/,
  'every app request clears model conversation state');
assert.match(html, /aiPermissions: JSON\.parse\(localStorage\.getItem\('nakliOS\.aiPermissions\.v1'\)/);
assert.match(html, /const AI_SETTINGS_KEY = 'nakliOS\.aiSettings\.v1'/);
assert.match(html, /const AI_SESSION_KEY = 'nakliOS\.aiEndpointKey\.session\.v1'/);
assert.match(html, /const AI_REMEMBERED_KEY = 'nakliOS\.aiEndpointKey\.remembered\.v1'/);
assert.match(html, /const AI_IMAGE_PROTOCOL = 'localmind\.image\.v1'/);
assert.match(html, /const AI_MAX_IMAGE_PROMPT_CHARS = 8000/);
assert.match(html, /function aiCredentialId\(baseUrl\)/);
assert.match(html, /function aiReadCredentialStore\(storage, key\)/);
assert.match(html, /function aiForgetEndpointKey\(baseUrl\)/);
assert.match(html, /function aiDiscoverEndpointModels\(config, apiKey = ''\)/);
assert.match(html, /function aiGenerateEndpoint\(request\)/);
assert.match(html, /function aiGenerateEndpointImage\(request\)/);
assert.match(
  html,
  /function aiHostSubmitImage\(source, msg, appId, hostOptions = \{\}\)/,
);
assert.match(html, /hostOptions\.trustedHost === true/);
assert.match(html, /function aiCreateImageWorker\(model\)/);
assert.match(html, /function aiImagePermissionScope\(model = aiSelectedImageModel\(\)\)/);
assert.match(html, /function aiHostImageNative\(prompt, options = \{\}\)/);
assert.match(html, /function aiPermissionScope\(model = aiSelectedModel\(\)\)/);
assert.match(html, /local-endpoint/);
assert.match(html, /external/);
assert.match(html, /id="ai-model-select"/);
assert.match(html, /id="ai-endpoint-key" type="password"/);
assert.match(html, /id="ai-forget-key"/);
assert.match(html, /id="ai-image-model-select"/);
assert.match(html, /id="ai-image-endpoint-key" type="password"/);
assert.match(html, /id="ai-image-apply-model"/);
assert.match(html, /id="ai-image-test"/);
assert.match(html, /Remember API key on this device/);

const catalogContext = vm.createContext({});
vm.runInContext(catalogSource, catalogContext, { filename:'host-model-catalog.js' });
const modelKeys = Array.from(
  catalogContext.LocalMindHostCatalog.models,
  model => model.key,
);
assert.deepEqual(
  modelKeys,
  ['lfm2-230m-webgpu', 'gemma4-e2b', 'gemma4-e4b', 'qwen35-4b'],
);
const qwen35 = catalogContext.LocalMindHostCatalog.get('qwen35-4b');
assert.equal(qwen35.id, 'onnx-community/Qwen3.5-4B-ONNX-OPT');
assert.equal(qwen35.modelClass, 'qwen3_5');
assert.equal(catalogContext.LocalMindHostCatalog.defaultKey, 'lfm2-230m-webgpu');
assert.equal(
  catalogContext.LocalMindHostCatalog.defaultImageKey,
  'flux2-klein-4b-webgpu',
);
assert.deepEqual(
  Array.from(
    catalogContext.LocalMindHostCatalog.imageModels,
    model => model.key,
  ),
  ['flux2-klein-4b-webgpu'],
);

const serializeStart = html.indexOf('function serializeState()');
const serializeEnd = html.indexOf('async function fsWriteState', serializeStart);
const serializeSource = html.slice(serializeStart, serializeEnd);
assert.doesNotMatch(
  serializeSource,
  /aiPermissions|aiSettings|aiEndpointKey/,
  'AI grants, provider settings, and keys must not sync through Folder state.json',
);
assert.match(
  html,
  /The shared \$\{image \? AI_IMAGE_MODEL_LABEL : AI_MODEL_LABEL\} model runs in this browser[\s\S]*?\$\{contentName\} stay in this tab/,
  'first use explains the model download and prompt boundary',
);
assert.match(
  html,
  /\$\{contentName\} will leave this device[\s\S]*?NakliOS keeps your API key hidden from apps/,
  'external providers get a distinct disclosure',
);
assert.match(html, /Image prompts and generated images/);
assert.match(html, /This app did not declare the inference permission/);
assert.match(html, /event:'token'/);
assert.match(html, /event:'done'/);
assert.match(html, /event:'error'/);
assert.match(html, /id="pad-ai"/, 'Notepad exposes a local AI action');
assert.match(html, /Nothing changes until you choose Replace or Insert/);
assert.match(html, /aiHostChatNative\(APP_ID/, 'host-native apps use the same broker');

const posted = [];
const listeners = new Map();
const parent = {
  postMessage(message) { posted.push(message); },
};
const windowObject = {
  parent,
  addEventListener(type, callback) { listeners.set(type, callback); },
};
const context = vm.createContext({
  window:windowObject,
  console,
  Map,
  Set,
  Promise,
  Symbol,
  Error,
  Date,
  Object,
  Array,
  String,
  setTimeout,
  clearTimeout,
});
vm.runInContext(sdkSource, context, { filename:'sdk/naklios.js' });

const dispatch = (data, source = parent) => {
  const listener = listeners.get('message');
  assert.ok(listener, 'SDK message listener is installed');
  listener({ data, source });
};

dispatch({
  type:'naklios:capabilities',
  fs:false,
  ai:true,
  aiModel:'LiquidAI/LFM2.5-230M-GGUF',
  aiModelLabel:'LFM2.5 230M',
  aiProvider:'custom-webgpu',
  aiLocal:true,
  aiState:'idle',
  aiImages:true,
  aiImageModel:'prism-ml/bonsai-image-ternary-4B-mlx-2bit',
  aiImageModelLabel:'Bonsai Image · FLUX.2-Klein 4B',
  aiImageProvider:'custom-webgpu-image',
  aiImageLocal:true,
  aiImageState:'idle',
});
assert.equal(windowObject.naklios.capabilities.ai, true);
assert.equal(windowObject.naklios.capabilities.aiModelLabel, 'LFM2.5 230M');
assert.equal(windowObject.naklios.capabilities.aiProvider, 'custom-webgpu');
assert.equal(windowObject.naklios.capabilities.aiLocal, true);
assert.equal(windowObject.naklios.capabilities.aiImages, true);
assert.equal(
  windowObject.naklios.capabilities.aiImageModelLabel,
  'Bonsai Image · FLUX.2-Klein 4B',
);

// A non-parent window cannot forge host capabilities or inference replies.
dispatch({ type:'naklios:capabilities', ai:false }, { postMessage() {} });
assert.equal(windowObject.naklios.capabilities.ai, true);

const statuses = [];
const stream = await windowObject.naklios.ai.chat.completions.create({
  messages:[{ role:'user', content:'Hello' }],
  max_tokens:64,
  stream:true,
  onStatus(status) { statuses.push(status); },
});
const chat = posted.find(message => message.type === 'naklios:ai:chat');
assert.ok(chat?.requestId, 'SDK posts a correlated Local AI request');
assert.equal(chat.maxTokens, 64);

dispatch({ type:'naklios:ai:event', requestId:chat.requestId, event:'status', status:'queued' });
dispatch({ type:'naklios:ai:event', requestId:chat.requestId, event:'token', token:'Hello ' });
dispatch({ type:'naklios:ai:event', requestId:chat.requestId, event:'token', token:'locally.' });
dispatch({
  type:'naklios:ai:event',
  requestId:chat.requestId,
  event:'done',
  finishReason:'stop',
});

let streamed = '';
let finishReason = null;
for await (const chunk of stream) {
  streamed += chunk.choices[0].delta.content || '';
  finishReason = chunk.choices[0].finish_reason || finishReason;
}
assert.equal(streamed, 'Hello locally.');
assert.equal(finishReason, 'stop');
assert.deepEqual(statuses, ['queued']);

const cancellable = await windowObject.naklios.ai.chat.completions.create({
  messages:[{ role:'user', content:'Wait' }],
  stream:true,
});
cancellable.cancel();
const cancel = posted.at(-1);
assert.equal(cancel.type, 'naklios:ai:cancel');
assert.ok(cancel.requestId);

const imageStatuses = [];
const imagePromise = windowObject.naklios.ai.images.generate({
  prompt:'A small paper-cut city',
  size:'512x512',
  seed:42,
  steps:4,
  onStatus(status, progress) {
    imageStatuses.push([status, progress]);
  },
});
const imageRequest = posted.find(message => message.type === 'naklios:ai:image');
assert.ok(imageRequest?.requestId, 'SDK posts a correlated image request');
assert.equal(imageRequest.prompt, 'A small paper-cut city');
assert.equal(imageRequest.size, '512x512');
assert.equal(imageRequest.seed, 42);

dispatch({
  type:'naklios:ai:image:event',
  requestId:imageRequest.requestId,
  event:'status',
  status:'generating',
  progress:{ step:2, total:4 },
});
dispatch({
  type:'naklios:ai:image:event',
  requestId:imageRequest.requestId,
  event:'result',
  model:'prism-ml/bonsai-image-ternary-4B-mlx-2bit',
  image:{
    b64_json:'iVBORw0KGgo=',
    mime_type:'image/png',
    width:512,
    height:512,
    seed:42,
    created:123,
  },
});
const imageResult = await imagePromise;
assert.equal(imageResult.created, 123);
assert.equal(imageResult.data[0].b64_json, 'iVBORw0KGgo=');
assert.equal(imageResult.data[0].width, 512);
assert.equal(imageResult.data[0].seed, 42);
assert.deepEqual(imageStatuses, [['generating', { step:2, total:4 }]]);

// ── Agent tier: raised caps + tool-calling (system apps only) ──────────
// Broker + SDK source contracts for the additive agent path.
assert.match(html, /function aiAppIsSystem\(appId\)/, 'agent tier gates on system apps');
assert.match(html, /Agent-tier inference is restricted to system apps/,
  'third-party apps are refused the agent tier');
assert.match(html, /const wantsAgent = msg\.agent === true/, 'agent tier is opt-in per request');
assert.match(html, /Tool-calling requires an OpenAI-compatible endpoint model/,
  'on-device model + tools is refused, not silently dropped');
assert.match(html, /toolAcc\.absorbDelta\(choice\?\.delta\)/, 'streamed tool-calls are accumulated');
assert.match(html, /request\.toolCalls\?\.length \? \{ toolCalls:request\.toolCalls \}/,
  'tool-calls ride back on the done event');
assert.match(sdkSource, /if \(options\.agent === true\) chatMsg\.agent = true/,
  'SDK forwards the agent flag');
assert.match(sdkSource, /chatMsg\.tools = options\.tools/, 'SDK forwards tools');
assert.match(sdkSource, /message\.tool_calls = toolCalls/,
  'SDK surfaces tool_calls on the completion');

// Pure protocol core — behavioral smoke (full coverage in sys/ai/test/agent-protocol.test.mjs).
const proto = await import(new URL('../sys/ai/agent-protocol.mjs', import.meta.url));
assert.ok(
  proto.AGENT_LIMITS.maxMessages > 32 &&
    proto.AGENT_LIMITS.maxInputChars > 24000 &&
    proto.AGENT_LIMITS.maxOutputTokens > 768,
  'agent caps strictly exceed the narrow-chat caps (32 / 24k / 768)',
);
const acc = proto.createToolCallAccumulator();
acc.absorbDelta({ tool_calls:[{ index:0, id:'c1', function:{ name:'ls', arguments:'' } }] });
acc.absorbDelta({ tool_calls:[{ index:0, function:{ arguments:'{}' } }] });
assert.deepEqual(
  acc.finalize(),
  [{ type:'function', function:{ name:'ls', arguments:'{}' }, id:'c1' }],
  'accumulator reassembles a streamed tool-call from deltas',
);

// SDK end-to-end: an agent request carries tools; the completion surfaces tool_calls.
const agentPromise = windowObject.naklios.ai.chat.completions.create({
  agent:true,
  messages:[{ role:'user', content:'list the files' }],
  tools:[{ type:'function', function:{ name:'ls', description:'list', parameters:{ type:'object' } } }],
  tool_choice:'auto',
});
const agentChat = posted.filter(message => message.type === 'naklios:ai:chat').at(-1);
assert.equal(agentChat.agent, true, 'SDK posts agent:true');
assert.equal(agentChat.tools[0].function.name, 'ls', 'SDK posts the tools array');
assert.equal(agentChat.tool_choice, 'auto', 'SDK posts tool_choice');
dispatch({
  type:'naklios:ai:event',
  requestId:agentChat.requestId,
  event:'done',
  finishReason:'tool_calls',
  toolCalls:[{ id:'c1', type:'function', function:{ name:'ls', arguments:'{}' } }],
});
const agentResult = await agentPromise;
assert.equal(agentResult.choices[0].finish_reason, 'tool_calls', 'finish_reason surfaced');
assert.deepEqual(
  agentResult.choices[0].message.tool_calls,
  [{ id:'c1', type:'function', function:{ name:'ls', arguments:'{}' } }],
  'completion surfaces tool_calls',
);

// Chunk W (2026-09-24): Ferrule is a provider preset — NakliOS holds a frl_ token, the provider keys
// stay in Ferrule's vault, and spend/egress are Ferrule's own panel. The preset is evaluated, not grepped.
{
  const block = /const AI_ENDPOINT_PRESETS = (Object\.freeze\(\{[\s\S]*?\n\}\));/.exec(html);
  assert.ok(block, 'the preset table is extractable');
  const presets = vm.runInNewContext('(' + block[1] + ')');
  assert.equal(presets.ferrule.baseUrl, 'http://127.0.0.1:8899/v1', 'Ferrule\'s endpoint');
  assert.equal(presets.ferrule.keyRequired, true, 'a Ferrule token is required — its /v1 refuses without one');
  assert.match(presets.ferrule.note, /frl_/, 'the note says what goes in the key box');
  assert.match(presets.ferrule.note, /never a provider key/, 'and what never does');
  assert.match(presets.ferrule.note, /localhost:8899/, 'and where spend and egress are shown');
  assert.match(html, /note\.textContent = preset\.note \|\| ''; note\.hidden = !preset\.note;/, 'the note follows the picked provider');
  assert.ok(Object.entries(presets).filter(([, v]) => v.note).length === 1, 'only Ferrule carries a note today');
}

console.log('NakliOS AI broker, providers, model catalog, and SDK contract: PASS');

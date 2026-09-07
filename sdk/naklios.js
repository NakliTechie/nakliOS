/*!
 * naklios.js — cooperative SDK for apps hosted inside NakliOS (Immersive mode)
 *
 * Drop this file into your app's <head> or copy its contents inline. The
 * surface is a no-op when the app loads standalone (window.parent === window),
 * so the same source works in both contexts:
 *
 *   <script src="https://naklios.dev/sdk/naklios.js"></script>
 *   <script>
 *     naklios.ready();                          // signal "I'm loaded"
 *     naklios.title('My app — unlocked');       // update host window title
 *     naklios.close();                          // self-close from a Done button
 *     naklios.theme.onChange(t => paint(t));    // restyle on host theme change
 *
 *     // Filesystem (when hosted with a connected Folder or Crate):
 *     if (naklios.capabilities.fs){
 *       await naklios.fs.write('vault.json', JSON.stringify(vault));
 *       const data = await naklios.fs.read('vault.json');
 *       const stop = await naklios.fs.subscribe('', event => refresh(event));
 *     }
 *
 *     // Shared host inference (when the user grants this app access):
 *     if (naklios.capabilities.ai) {
 *       const stream = await naklios.ai.chat.completions.create({
 *         messages: [{ role: 'user', content: 'Summarise this note.' }],
 *         stream: true,
 *       });
 *       for await (const chunk of stream) {
 *         render(chunk.choices[0].delta.content || '');
 *       }
 *
 *       const image = await naklios.ai.images.generate({
 *         prompt: 'A risograph poster of a city after monsoon rain',
 *         size: '1024x1024',
 *         signal: abortController.signal,
 *       });
 *       preview.src = image.data[0].b64_json
 *         ? 'data:image/png;base64,' + image.data[0].b64_json
 *         : image.data[0].url;
 *     }
 *   </script>
 *
 * naklios.capabilities.hosted is true only when running inside NakliOS.
 * naklios.capabilities.fs is true when hosted storage is available to the app.
 * naklios.capabilities.fsBackends lists connected Folder/Crate choices, and
 * naklios.capabilities.fsBackend is the app's current binding (or null).
 * Apps may call naklios.fs.useBackend(id); NakliOS confirms the change.
 * Listen for changes via naklios.onCapabilitiesChange(cb).
 *
 * Paths in fs methods are relative to apps/<your-app-id>/ on the selected backend.
 * Traversal (../) is blocked at the host.
 *
 * Single source of truth: https://naklios.dev/sdk/naklios.js
 *   (repo: NakliTechie/nakliOS → sdk/naklios.js)
 * Vendor it inline in each app to keep the no-network-dependency ethos.
 *
 * @naklios-sdk-version 2
 *   Vendored copies are spliced between two HTML comment markers and kept fresh
 *   by each app's own CI — never hand-edited. See docs/app-contract.md "Vendoring
 *   the SDK" and plan/sdk-vendoring.md. In the app's HTML, an "naklios-sdk:begin"
 *   comment (carrying ver= and sha256=) and an "naklios-sdk:end" comment bracket
 *   the inlined <script>; scripts/vendor-naklios-sdk.mjs rewrites everything
 *   between them (escaping this file's closing script tags). The literal marker
 *   syntax is only shown in the docs — never here, so it can't be mistaken for a
 *   real marker once this header is itself inlined.
 *
 *   v2 = learn-on-contact origin + ?naklios flag (no-referrer-safe). v1 (pre-2026-08)
 *   posted to '*' and skipped inbound-origin checks — a v1 copy is a drift bug.
 * License: MIT.
 */
(function () {
  // A real host FRAME is what the transports talk to (postMessage to parent), so
  // it gates every send/rpc — `inNakliOS`. The `?naklios` URL flag is the host's
  // EXPLICIT signal (it appends it to embed URLs) and a deliberate opt-in for
  // testing; it sets capabilities.hosted so an app KNOWS to route through NakliOS,
  // but it never fakes a channel that isn't there — a bare `?naklios` top-level tab
  // has no host, so fs/ai capabilities stay false (no handshake) and the app's
  // adapter falls back to its own APIs. No hang, no breakage.
  var inNakliOS = false;
  try { inNakliOS = !!(window.parent && window.parent !== window); } catch (_) {}
  var naklFlag = false;
  try { naklFlag = new URLSearchParams(window.location.search).has('naklios'); } catch (_) {}
  // Targeted postMessage origin, LEARNED on first contact — the NakliOS shell embeds
  // apps with referrerpolicy="no-referrer", so document.referrer is empty and can't
  // be used to verify the parent (that path breaks hosted detection — it is the
  // Lorewell iframe bug). Instead the first `naklios:*` message from window.parent
  // locks trustedParentOrigin, and every later send targets that origin (not '*').
  // The only pre-lock send is `ready`, which carries no app data.
  var trustedParentOrigin = null;

  var currentTheme = null;
  var themeListeners = new Set();
  var capListeners = new Set();
  var beforeCloseCb = null;
  var capabilities = {
    // hosted honours the ?naklios flag as well as a real embed, so an app can
    // decide to route through NakliOS; the fs/ai flags below only flip true after
    // a real host handshake, so the adapter still self-corrects with no channel.
    hosted: inNakliOS || naklFlag,
    flagged: naklFlag,
    version: 1,
    fs: false,
    fsBackends: [],
    fsBackend: null,
    // system: this app is a same-origin system app (non-third-party).
    // sysFs: system-scoped filesystem is available — the whole store, not just
    // apps/<your-id>/. Only true for system apps with a connected backend.
    system: false,
    sysFs: false,
    ai: false,
    aiModel: null,
    aiModelLabel: null,
    aiProvider: null,
    aiLocal: true,
    aiState: 'idle',
    aiImages: false,
    aiImageModel: null,
    aiImageModelLabel: null,
    aiImageProvider: null,
    aiImageLocal: true,
    aiImageState: 'idle',
    aiSearchState: 'idle',
    aiSearch: false,
    // net: a sovereign egress backend (the user's own Worker or local bridge) is
    // configured + permitted, so naklios.net.fetch can reach cross-origin hosts the
    // browser blocks. Stays false until a host advertises one — the SDK seam.
    net: false,
    netBackend: null,
  };

  // Request/reply correlation for fs RPCs
  var pendingRpc = new Map();   // requestId → { resolve, reject }
  var rpcCounter = 0;
  var fsSubscriptions = new Map(); // subscriptionId → callback
  var aiRequests = new Map(); // requestId → streamed request state
  var aiImageRequests = new Map(); // requestId → image request state
  var ragSearches = new Map();     // requestId → semantic-search progress callback
  var fileOpenListeners = new Set(); // exact-file grants delivered by the host
  var pendingFileGrants = [];

  function send(type, data) {
    if (!inNakliOS) return;
    try {
      var msg = Object.assign({ type: type }, data || {});
      window.parent.postMessage(msg, trustedParentOrigin || '*');
    } catch (_) {}
  }

  function rpc(type, payload, timeoutMs) {
    if (!inNakliOS) return Promise.reject(new Error('Not hosted — naklios.* unavailable standalone'));
    return new Promise(function (resolve, reject) {
      var requestId = 'r' + (++rpcCounter) + '_' + Date.now();
      pendingRpc.set(requestId, { resolve: resolve, reject: reject });
      send(type, Object.assign({ requestId: requestId }, payload || {}));
      // Default 30s safety net; long operations (index building) pass more.
      setTimeout(function () {
        if (pendingRpc.has(requestId)) {
          pendingRpc.delete(requestId);
          reject(new Error('naklios RPC timeout: ' + type));
        }
      }, timeoutMs || 30000);
    });
  }

  // Typed egress error so an app can branch (fall back / prompt to connect) rather
  // than parse a message. code is 'ENOEGRESS' (no backend / not hosted) or 'EINVAL'.
  function mkEgressErr(code, message) {
    var e = new Error(message);
    e.code = code;
    e.egress = true;
    return e;
  }

  // Bind each operation to the backend visible when it was issued. The host
  // rejects it if the app is rebound before the message is processed, which
  // prevents a delayed save from crossing Folder/Crate boundaries.
  function fsPayload(data) {
    return Object.assign({ backend: capabilities.fsBackend }, data || {});
  }

  function makeAiStream(options) {
    if (!inNakliOS) throw new Error('Not hosted — naklios.ai unavailable standalone');
    if (!capabilities.ai) throw new Error('NakliOS Local AI is unavailable or not permitted');
    options = options || {};
    var requestId = 'a' + (++rpcCounter) + '_' + Date.now();
    var queued = [];
    var waiters = [];
    var complete = false;
    var failure = null;

    function deliver(item) {
      if (waiters.length) waiters.shift().resolve({ value: item, done: false });
      else queued.push(item);
    }
    function finish() {
      complete = true;
      while (waiters.length) waiters.shift().resolve({ value: undefined, done: true });
    }
    function fail(error) {
      failure = error;
      complete = true;
      while (waiters.length) waiters.shift().reject(error);
    }

    var stream = {
      next: function () {
        if (queued.length) return Promise.resolve({ value: queued.shift(), done: false });
        if (failure) return Promise.reject(failure);
        if (complete) return Promise.resolve({ value: undefined, done: true });
        return new Promise(function (resolve, reject) {
          waiters.push({ resolve: resolve, reject: reject });
        });
      },
      cancel: function () {
        send('naklios:ai:cancel', { requestId: requestId });
      },
    };
    stream[Symbol.asyncIterator] = function () { return stream; };
    aiRequests.set(requestId, {
      deliver: deliver,
      finish: finish,
      fail: fail,
      onStatus: typeof options.onStatus === 'function' ? options.onStatus : null,
    });
    var chatMsg = {
      requestId: requestId,
      messages: Array.isArray(options.messages) ? options.messages : [],
      maxTokens: options.max_tokens || options.maxTokens,
    };
    // Agent tier (system apps only): raised caps + tool-calling. The host
    // refuses agent:true from a third-party app, so passing it is harmless.
    if (options.agent === true) chatMsg.agent = true;
    if (options.tools != null) chatMsg.tools = options.tools;
    if (options.tool_choice != null) chatMsg.tool_choice = options.tool_choice;
    send('naklios:ai:chat', chatMsg);
    if (options.signal) {
      if (options.signal.aborted) stream.cancel();
      else options.signal.addEventListener('abort', function () { stream.cancel(); }, { once: true });
    }
    return stream;
  }

  async function createAiCompletion(options) {
    options = options || {};
    var stream = makeAiStream(options);
    if (options.stream === true) return stream;
    var content = '';
    var finishReason = 'stop';
    var toolCalls = null;
    var usage = null;
    for await (var chunk of stream) {
      var choice = chunk.choices && chunk.choices[0];
      if (choice && choice.delta && choice.delta.content) content += choice.delta.content;
      if (choice && choice.delta && choice.delta.tool_calls) toolCalls = choice.delta.tool_calls;
      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
    var message = { role: 'assistant', content: content };
    if (toolCalls) message.tool_calls = toolCalls;
    return {
      id: 'naklios-local',
      object: 'chat.completion',
      model: capabilities.aiModel || 'localmind',
      choices: [{
        index: 0,
        message: message,
        finish_reason: finishReason,
      }],
      // top level, as the OpenAI completion shape has it; null when the provider said nothing
      usage: usage,
    };
  }

  function createAiImage(options) {
    if (!inNakliOS) {
      return Promise.reject(new Error('Not hosted — naklios.ai unavailable standalone'));
    }
    if (!capabilities.aiImages) {
      return Promise.reject(new Error('NakliOS image generation is unavailable or not permitted'));
    }
    options = options || {};
    var requestId = 'i' + (++rpcCounter) + '_' + Date.now();
    return new Promise(function (resolve, reject) {
      var abortHandler = function () {
        send('naklios:ai:cancel', { requestId: requestId });
      };
      aiImageRequests.set(requestId, {
        resolve: resolve,
        reject: reject,
        onStatus: typeof options.onStatus === 'function' ? options.onStatus : null,
        signal: options.signal || null,
        abortHandler: abortHandler,
      });
      send('naklios:ai:image', {
        requestId: requestId,
        prompt: String(options.prompt || ''),
        size: options.size,
        quality: options.quality,
        n: options.n,
        seed: options.seed,
        steps: options.steps,
      });
      if (options.signal) {
        if (options.signal.aborted) abortHandler();
        else options.signal.addEventListener('abort', abortHandler, { once: true });
      }
    });
  }

  function settleAiImage(requestId, callback) {
    var request = aiImageRequests.get(requestId);
    if (!request) return null;
    aiImageRequests.delete(requestId);
    if (request.signal && request.abortHandler) {
      request.signal.removeEventListener('abort', request.abortHandler);
    }
    callback(request);
    return request;
  }

  window.addEventListener('message', function (e) {
    if (inNakliOS && e.source !== window.parent) return;
    var msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    // Lock the trusted parent origin on the first naklios:* message, then verify
    // every later message against it (no-referrer-safe; see the detection note).
    if (inNakliOS && typeof msg.type === 'string' && msg.type.indexOf('naklios:') === 0) {
      if (!trustedParentOrigin) trustedParentOrigin = e.origin;
      else if (e.origin !== trustedParentOrigin) return;
    }
    if (msg.type === 'naklios:theme') {
      currentTheme = { id: msg.theme, colors: msg.colors, mood: msg.mood };
      themeListeners.forEach(function (cb) {
        try { cb(currentTheme); } catch (_) {}
      });
    } else if (msg.type === 'naklios:beforeclose') {
      var closeWork;
      try { closeWork = beforeCloseCb ? beforeCloseCb() : null; } catch (_) { closeWork = null; }
      Promise.resolve(closeWork).catch(function () {}).then(function () {
        send('naklios:beforeclose-ready', { requestId: msg.requestId });
      });
    } else if (msg.type === 'naklios:capabilities') {
      if (typeof msg.fs === 'boolean') capabilities.fs = msg.fs;
      if (Array.isArray(msg.fsBackends)) capabilities.fsBackends = msg.fsBackends;
      capabilities.fsBackend = typeof msg.fsBackend === 'string' ? msg.fsBackend : null;
      capabilities.system = msg.system === true;
      capabilities.sysFs = msg.sysFs === true;
      if (typeof msg.ai === 'boolean') capabilities.ai = msg.ai;
      capabilities.aiModel = typeof msg.aiModel === 'string' ? msg.aiModel : null;
      capabilities.aiModelLabel = typeof msg.aiModelLabel === 'string' ? msg.aiModelLabel : null;
      capabilities.aiProvider = typeof msg.aiProvider === 'string' ? msg.aiProvider : null;
      capabilities.aiLocal = msg.aiLocal !== false;
      capabilities.aiState = typeof msg.aiState === 'string' ? msg.aiState : 'idle';
      capabilities.aiImages = msg.aiImages === true;
      capabilities.aiImageModel = typeof msg.aiImageModel === 'string' ? msg.aiImageModel : null;
      capabilities.aiImageModelLabel = typeof msg.aiImageModelLabel === 'string'
        ? msg.aiImageModelLabel
        : null;
      capabilities.aiImageProvider = typeof msg.aiImageProvider === 'string'
        ? msg.aiImageProvider
        : null;
      capabilities.aiImageLocal = msg.aiImageLocal !== false;
      capabilities.aiImageState = typeof msg.aiImageState === 'string'
        ? msg.aiImageState
        : 'idle';
      capabilities.aiSearchState = typeof msg.aiSearchState === 'string'
        ? msg.aiSearchState
        : 'idle';
      capabilities.aiSearch = msg.aiSearch === true;
      capabilities.net = msg.net === true;
      capabilities.netBackend = typeof msg.netBackend === 'string' ? msg.netBackend : null;
      capListeners.forEach(function (cb) {
        try { cb(capabilities); } catch (_) {}
      });
    } else if (msg.type === 'naklios:rag:event' && msg.requestId) {
      var ragRequest = ragSearches.get(msg.requestId);
      if (ragRequest && msg.event === 'indexing') {
        try {
          ragRequest.onIndexing && ragRequest.onIndexing({
            done: msg.done, total: msg.total, path: msg.path,
          });
        } catch (_) {}
      }
    } else if (msg.type === 'naklios:ai:event' && msg.requestId) {
      var aiRequest = aiRequests.get(msg.requestId);
      if (!aiRequest) return;
      if (msg.event === 'status') {
        try { aiRequest.onStatus && aiRequest.onStatus(msg.status, msg.progress || null); } catch (_) {}
      } else if (msg.event === 'token') {
        aiRequest.deliver({
          id: msg.requestId,
          object: 'chat.completion.chunk',
          model: msg.model || capabilities.aiModel || 'localmind',
          choices: [{
            index: 0,
            delta: { content: String(msg.token || '') },
            finish_reason: null,
          }],
        });
      } else if (msg.event === 'done') {
        aiRequest.deliver({
          id: msg.requestId,
          object: 'chat.completion.chunk',
          model: msg.model || capabilities.aiModel || 'localmind',
          choices: [{
            index: 0,
            delta: msg.toolCalls && msg.toolCalls.length ? { tool_calls: msg.toolCalls } : {},
            finish_reason: msg.finishReason || 'stop',
          }],
          // The provider's token count, where the OpenAI shape puts it. An app that budgets
          // on estimated characters cannot see tool schemas or the host's own preamble.
          usage: msg.usage || null,
        });
        aiRequests.delete(msg.requestId);
        aiRequest.finish();
      } else if (msg.event === 'error') {
        aiRequests.delete(msg.requestId);
        aiRequest.fail(new Error(msg.error || 'NakliOS Local AI failed'));
      }
    } else if (msg.type === 'naklios:ai:image:event' && msg.requestId) {
      var imageRequest = aiImageRequests.get(msg.requestId);
      if (!imageRequest) return;
      if (msg.event === 'status') {
        try {
          imageRequest.onStatus && imageRequest.onStatus(msg.status, msg.progress || null);
        } catch (_) {}
      } else if (msg.event === 'result' && msg.image) {
        settleAiImage(msg.requestId, function (request) {
          request.resolve({
            created: Number(msg.image.created) || Math.floor(Date.now() / 1000),
            model: msg.model || capabilities.aiImageModel || 'localmind-image',
            data: [{
              b64_json: msg.image.b64_json || null,
              url: msg.image.url || null,
              revised_prompt: msg.image.revised_prompt || null,
              mime_type: msg.image.mime_type || 'image/png',
              width: Number(msg.image.width) || null,
              height: Number(msg.image.height) || null,
              seed: msg.image.seed == null ? null : Number(msg.image.seed),
            }],
          });
        });
      } else if (msg.event === 'done' && msg.finishReason === 'cancelled') {
        settleAiImage(msg.requestId, function (request) {
          var error = new Error('Image generation cancelled');
          error.name = 'AbortError';
          request.reject(error);
        });
      } else if (msg.event === 'error') {
        settleAiImage(msg.requestId, function (request) {
          request.reject(new Error(msg.error || 'NakliOS image generation failed'));
        });
      }
    } else if (msg.type === 'naklios:file:grant' && msg.grant) {
      var grant = {
        token: String(msg.grant.token || ''),
        name: String(msg.grant.name || 'Untitled'),
        path: String(msg.grant.path || ''),
        sourceAppId: String(msg.grant.sourceAppId || ''),
        backend: String(msg.grant.backend || ''),
      };
      if (!grant.token) return;
      if (!fileOpenListeners.size) pendingFileGrants.push(grant);
      else fileOpenListeners.forEach(function (cb) {
        try { cb(grant); } catch (_) {}
      });
    } else if ((msg.type === 'naklios:fs:reply' || msg.type === 'naklios:file:reply' ||
                msg.type === 'naklios:rag:reply' || msg.type === 'naklios:net:reply') && msg.requestId) {
      var p = pendingRpc.get(msg.requestId);
      if (!p) return;
      pendingRpc.delete(msg.requestId);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    } else if (msg.type === 'naklios:fs:event' && msg.subscriptionId) {
      var listener = fsSubscriptions.get(msg.subscriptionId);
      if (listener) {
        try { listener(msg.event || {}); } catch (_) {}
      }
    } else if (msg.type === 'naklios:fs:subscription-ended' && msg.subscriptionId) {
      var endedListener = fsSubscriptions.get(msg.subscriptionId);
      fsSubscriptions.delete(msg.subscriptionId);
      if (endedListener) {
        try { endedListener({ op: 'disconnected', reason: msg.reason || 'Storage subscription ended' }); } catch (_) {}
      }
    }
  });

  window.naklios = {
    version: 1,
    capabilities: capabilities,   // mutated in place; read fields directly
    ready: function () {
      send('naklios:ready', {
        features: {
          beforeCloseAck: true,
          fsSubscribe: true,
          aiStream: true,
          aiImages: true,
          aiSearch: true,
        },
      });
    },
    title: function (s) { send('naklios:title', { title: String(s) }); },
    close: function () { send('naklios:close'); },
    openSettings: function (section) {
      send('naklios:open-settings', { section: String(section || '') });
    },
    beforeClose: function (cb) { beforeCloseCb = typeof cb === 'function' ? cb : null; },
    theme: {
      get current() { return currentTheme; },
      onChange: function (cb) {
        if (typeof cb !== 'function') return function () {};
        themeListeners.add(cb);
        if (currentTheme) { try { cb(currentTheme); } catch (_) {} }
        return function () { themeListeners.delete(cb); };
      },
      request: function () { send('naklios:theme-request'); },
    },
    onCapabilitiesChange: function (cb) {
      if (typeof cb !== 'function') return function () {};
      capListeners.add(cb);
      try { cb(capabilities); } catch (_) {}
      return function () { capListeners.delete(cb); };
    },
    requestCapabilities: function () { send('naklios:capabilities-request'); },
    fs: {
      // All paths are app-relative (under apps/<your-id>/ in the host folder).
      // Returns Promises. Reject if no folder connected, permission denied,
      // or path tries to traverse.
      read:       function (path)       { return rpc('naklios:fs:read', fsPayload({ path: path })); },
      readBinary: function (path)       { return rpc('naklios:fs:readBinary', fsPayload({ path: path })); },
      write:      function (path, data) { return rpc('naklios:fs:write', fsPayload({ path: path, data: data })); },
      append:     function (path, line) { return rpc('naklios:fs:append', fsPayload({ path: path, line: line })); },
      list:       function (prefix)     { return rpc('naklios:fs:list', fsPayload({ prefix: prefix || '' })); },
      delete:     function (path)       { return rpc('naklios:fs:delete', fsPayload({ path: path })); },
      exists:     function (path)       { return rpc('naklios:fs:exists', fsPayload({ path: path })); },
      // Watch an app-relative path or directory. Crate events are immediate;
      // Folder changes are detected by a lightweight host poll. Resolves to
      // an unsubscribe function.
      subscribe: async function (path, cb) {
        if (typeof cb !== 'function') throw new Error('naklios.fs.subscribe requires a callback');
        var subscriptionId = await rpc(
          'naklios:fs:subscribe',
          fsPayload({ path: path || '' }),
        );
        fsSubscriptions.set(subscriptionId, cb);
        var active = true;
        return function () {
          if (!active) return;
          active = false;
          fsSubscriptions.delete(subscriptionId);
          send('naklios:fs:unsubscribe', { subscriptionId: subscriptionId });
        };
      },
      // Explicit backend changes are always confirmed by the NakliOS host.
      // Switching changes the app-scoped view; it never copies or deletes data.
      useBackend: function (backend)    { return rpc('naklios:fs:selectBackend', { backend: backend }); },
    },
    // System-scoped filesystem — the WHOLE store on the active backend, not just
    // this app's apps/<id>/ namespace. Available to same-origin system apps only
    // (capabilities.sysFs); the host rejects the call otherwise. Paths are
    // full-from-store-root (e.g. 'apps/anvil/ws/demo/main.py', 'state.json'),
    // and list() returns full paths. This is the primitive behind the OS-level
    // file manager: one app can see every other app's files.
    sys: {
      fs: {
        read:       function (path)       { return rpc('naklios:sysfs:read', fsPayload({ path: path })); },
        readBinary: function (path)       { return rpc('naklios:sysfs:readBinary', fsPayload({ path: path })); },
        write:      function (path, data) { return rpc('naklios:sysfs:write', fsPayload({ path: path, data: data })); },
        append:     function (path, line) { return rpc('naklios:sysfs:append', fsPayload({ path: path, line: line })); },
        list:       function (prefix)     { return rpc('naklios:sysfs:list', fsPayload({ prefix: prefix || '' })); },
        delete:     function (path)       { return rpc('naklios:sysfs:delete', fsPayload({ path: path })); },
        exists:     function (path)       { return rpc('naklios:sysfs:exists', fsPayload({ path: path })); },
      },
    },
    files: {
      // Ask NakliOS to open one app-relative file in another cooperative app.
      // The target gets a window-lifetime token for exactly that file; it does
      // not receive the source app's namespace or a Folder/Crate credential.
      openWith: function (appId, path) {
        return rpc('naklios:file:openWith', fsPayload({
          appId: String(appId || ''),
          path: String(path || ''),
        }));
      },
      onOpen: function (cb) {
        if (typeof cb !== 'function') return function () {};
        fileOpenListeners.add(cb);
        var queued = pendingFileGrants.splice(0);
        queued.forEach(function (grant) {
          try { cb(grant); } catch (_) {}
        });
        return function () { fileOpenListeners.delete(cb); };
      },
      read: function (token) {
        return rpc('naklios:file:read', { token: String(token || '') });
      },
      write: function (token, data) {
        return rpc('naklios:file:write', { token: String(token || ''), data: data });
      },
      release: function (token) {
        send('naklios:file:release', { token: String(token || '') });
      },
    },
    ai: {
      chat: {
        completions: {
          create: createAiCompletion,
        },
      },
      images: {
        generate: createAiImage,
      },
      // Semantic search over the app's own namespace on the connected
      // backend. The host builds/refreshes a local embedding index on first
      // use (one consent prompt) and returns ranked chunks.
      search: function (options) {
        if (!inNakliOS) {
          return Promise.reject(new Error('Not hosted — naklios.ai unavailable standalone'));
        }
        if (!capabilities.aiSearch) {
          return Promise.reject(new Error('NakliOS semantic search is unavailable or not permitted'));
        }
        options = options || {};
        var requestId = 's' + (++rpcCounter) + '_' + Date.now();
        return new Promise(function (resolve, reject) {
          ragSearches.set(requestId, {
            onIndexing: typeof options.onIndexing === 'function' ? options.onIndexing : null,
          });
          pendingRpc.set(requestId, { resolve: resolve, reject: reject });
          send('naklios:rag:search', {
            requestId: requestId,
            query: String(options.query || ''),
            limit: options.limit,
            prefix: options.prefix,
          });
          // Index building embeds every changed chunk locally; allow 15 min.
          setTimeout(function () {
            if (pendingRpc.has(requestId)) {
              pendingRpc.delete(requestId);
              reject(new Error('naklios RPC timeout: naklios:rag:search'));
            }
          }, 15 * 60 * 1000);
        }).finally(function () {
          ragSearches.delete(requestId);
        });
      },
      searchStatus: function () {
        return rpc('naklios:rag:status', {});
      },
      cancelAll: function () {
        aiRequests.forEach(function (_, requestId) {
          send('naklios:ai:cancel', { requestId: requestId });
        });
        aiImageRequests.forEach(function (_, requestId) {
          send('naklios:ai:cancel', { requestId: requestId });
        });
      },
    },

    // Sovereign egress — a cross-origin HTTP request the browser's Same-Origin
    // Policy blocks (git push, arbitrary-host fetch, no-CORS APIs). The host routes
    // it to the user-configured backend (their own Worker or the local bridge); it
    // is NEVER a naklios-hosted proxy. Grant-gated + History-logged host-side.
    // This is the SDK seam: until a host advertises a backend (capabilities.net),
    // every call fails fast with a typed ENOEGRESS — no 30s RPC timeout.
    net: {
      // Synchronous check an app can gate its UI on.
      available: function () { return capabilities.net === true; },
      // { backend: 'worker'|'bridge', roams } — no secrets; null when unavailable.
      info: function () {
        if (!inNakliOS || !capabilities.net) return Promise.resolve(null);
        return rpc('naklios:net:info', {});
      },
      // fetch({ url, method, headers, body }) -> { status, statusText, headers, body }.
      // Binary bodies as ArrayBuffer/Uint8Array; text as string. Buffered in v1.
      fetch: function (req) {
        req = req || {};
        if (!req.url) return Promise.reject(mkEgressErr('EINVAL', 'net.fetch requires a url'));
        if (!inNakliOS || !capabilities.net) {
          return Promise.reject(mkEgressErr('ENOEGRESS', inNakliOS
            ? 'No egress backend configured — connect one in NakliOS settings'
            : 'Not hosted — naklios.net unavailable standalone'));
        }
        return rpc('naklios:net:fetch', {
          url: String(req.url),
          method: req.method || 'GET',
          headers: req.headers || {},
          body: req.body != null ? req.body : null,
        }, req.timeoutMs);
      },
    },
  };
})();

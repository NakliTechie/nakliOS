# Vendored LocalMind inference runtime

NakliOS owns the app-facing inference broker, while LocalMind owns the model
runtime. The checked-in JavaScript files in this directory are exact copies
from the LocalMind commit and hashes recorded in `manifest.json`. This includes
the chat workers, conservative model catalog, and the generated Bonsai
FLUX.2-Klein image worker.

To update the runtime:

1. update and test LocalMind first;
2. copy every file listed in `manifest.json` from that tagged commit. Since LocalMind's single-file
   roll-in (`16a7ad4`, 2026-10-06) the app deploys as one `index.html`, but these runtime files are
   still separate sources there, no longer at the repo root:

   | Vendored file | LocalMind source |
   |---|---|
   | `inference-worker.js` | `src/inference-worker.js` |
   | `host-model-catalog.js` | `host/host-model-catalog.js` |
   | `onnx-inference-worker.js` | `host/onnx-inference-worker.js` |
   | `image-inference-worker.js` | `host/image-inference-worker.js` |

3. update the commit and SHA-256 values in `manifest.json`;
4. run `node scripts/test-localmind-vendor.mjs` and the NakliOS test suite.

Do not patch the vendored files only in NakliOS. Runtime changes belong
upstream in LocalMind so the workbench and operating system cannot drift.

Since 2026-10-31 (LocalMind `a1615bb`) `inference-worker.js` loads every model through anyformer from npm
(0.4.22, which also keeps run-time adapters in Cache Storage): LFM2.5 230M by repo id, and catalog entries such as LFM2.5 24B-A2B + Pi adapter by their anyformer
`entry`. It no longer needs `lfm2_5.js`.

Standing NakliOS patch (2026-10-28): `onnx-inference-worker.js` carries one
NakliOS-only change, listed under `localPatches`, so coding agents can call
tools on LFM3 1.7B in the browser: an agent request with `tools` passes them
and the tool messages to the model's chat template. LocalMind keeps its own
tool handling, so this patch stays here: every re-vendor of this file must
re-apply it and update its hash.

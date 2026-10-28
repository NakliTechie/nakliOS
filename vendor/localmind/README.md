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
   | `lfm2_5.js` | `src/lfm2_5.js` |
   | `host-model-catalog.js` | `host/host-model-catalog.js` |
   | `onnx-inference-worker.js` | `host/onnx-inference-worker.js` |
   | `image-inference-worker.js` | `host/image-inference-worker.js` |

3. update the commit and SHA-256 values in `manifest.json`;
4. run `node scripts/test-localmind-vendor.mjs` and the NakliOS test suite.

Do not patch the vendored files only in NakliOS. Runtime changes belong
upstream in LocalMind so the workbench and operating system cannot drift.

Current override (2026-10-28): the owner chose to make LFM3 1.7B the NakliOS
default here first and upstream it later. Two files differ from the pinned
LocalMind commit, and `manifest.json` lists them under `localPatches`:
`host-model-catalog.js` (LFM3 1.7B entry and default key) and
`onnx-inference-worker.js` (Transformers.js 4.3.2, the first release with
`lfm3`). The next LocalMind update must carry both changes upstream and then
remove `localPatches`.

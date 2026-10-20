# Vendored libraries

Every runtime dependency is committed here at a pinned version, with its licence. The app loads
these files by relative path, so nothing is fetched from a CDN when the page runs.

To check a file is what it claims to be: `shasum -a 256 vendor/<path>` and compare below.

## Mol* (`molstar`) 5.13.1

A structure viewer. Used to show the target protein.

| | |
|---|---|
| Package | `molstar` 5.13.1, published 2026-10-08 |
| Licence | MIT — `molstar/5.13.1/LICENSE`, Copyright (c) 2017 - now, Mol* contributors |
| Source | https://registry.npmjs.org/molstar/-/molstar-5.13.1.tgz |
| Project | https://github.com/molstar/molstar |
| Tarball SHA-256 | `08e9292fb427bbebe9e1ecaef9e1b1066e2323dc4327e83692c4a5c3f14fff4e` |

Taken from the tarball's prebuilt viewer bundle, `package/build/viewer/`:

| File | Size | SHA-256 |
|---|---|---|
| `molstar/5.13.1/molstar.js` | 5.0 MB | `4fc6493c2471db8834dcc391151b344d7017e4eb8a4eb76c152be5f9dbd23874` |
| `molstar/5.13.1/molstar.css` | 72 KB | `22fbf73b75c11ef57687d08437c95dbfe8430ea895264f6da2b9b01e28bacc49` |
| `molstar/5.13.1/LICENSE` | 1 KB | `aa42900c6ea7bfcf22d25a4c369025e01a526c66501fd9193f9a8aecee7a0753` |

Why the prebuilt bundle and not the ES-module sources: `molstar.js` is one self-contained file that
needs no build step, which `AGENTS.md` requires. It is an IIFE that assigns a global `molstar`, not
an ES module, so `app/viewer.js` reads `window.molstar` instead of importing it. Protavia's own code
stays native ES modules.

Not vendored from this package: the viewer's themes, example HTML, skybox images and favicon, and
the `lib/` ES-module tree. Add a file here, with its hash, if the app comes to need it.

## proteinmpnn-web 0.1.0, built from commit `10849c13`

The ProteinMPNN inference library: structure adapters, neighbour-graph construction, autoregressive
sampling and the ONNX session plumbing. `app/design.js` is a thin policy layer over it.

| | |
|---|---|
| Project | https://github.com/MurrellGroup/webProteinMPNN |
| Commit | `10849c13a9af990edeb9dc45ff15f764971d6f82`, 2026-09-08 (the only commit; no tags or releases) |
| Licence | MIT — `proteinmpnn-web/0.1.0-10849c13/LICENSE`, plus `THIRD_PARTY_NOTICES.md` |
| Source tarball SHA-256 | `17490671dc285fc9f9466cd031d80fe43606cb0a2458563ef4a2eb005852fa43` |

Not published to npm, and the repository ships no `dist/`, so the vendored JavaScript was built
here from that commit:

```sh
npm install --no-save --ignore-scripts typescript@5.9.3 onnxruntime-web@1.24.3
npx tsc -p tsconfig.json          # emits dist/*.js, exit 0, no diagnostics
```

The eight emitted ES modules were copied in unchanged; declaration files and source maps were not.
They import each other by relative path and reach ONNX Runtime through the bare specifiers
`onnxruntime-web` and `onnxruntime-web/webgpu`, which `index.html` resolves with an import map.

| File | SHA-256 |
|---|---|
| `index.js` | `07db9b7399de33a57c6f6b7f316f3300316b08f32663ffa18e48284139c18189` |
| `model.js` | `d5cd3e6d91e9b2dcd8db26cc468996842254619e4868aaaabdc1437b0c2b5fbc` |
| `onnx.js` | `5fb3805c618cb11b7caf1c85204dbeb1ce757cb9196f2a55494abfdfe6042053` |
| `structure.js` | `6eae01b5255d263ed7b3fc90f2ea4e64f8c89c452c41c20b0db02b9cc2f73612` |
| `math.js` | `6b618adb44147acedfbb017e00d5d28723b2947c573b93b592897f18d3ba686a` |
| `constraints.js` | `cf55f1b9a46c4e374f2feb7a1451bed276c169230563b3bc8f7aad142280221f` |
| `types.js` | `d4cdd76d13dc5cb189211799ad7d26ff7e9ea4883094e3c6f38d1b8fa79c17f2` |
| `legacy.js` | `193c9053a3f5cc7ae0b7a548e1ba2231d163e1fde5aa2d9fb9bc520fa038a65e` |

## ONNX Runtime Web 1.24.3

Runs the ONNX graphs. 1.24.3 is the version the model conversions were tested against, per the
bundle's `catalog.json`, so it is pinned there rather than at the newest release.

| | |
|---|---|
| Package | `onnxruntime-web` 1.24.3 |
| Licence | MIT — `onnxruntime-web/1.24.3/LICENSE`, Copyright (c) Microsoft Corporation |
| Source | https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.24.3.tgz |
| Project | https://github.com/microsoft/onnxruntime |

Three of the package's many `dist/` files are vendored. The WebGPU bundle registers both the
`webgpu` and `wasm` execution providers, so one build covers both backends; in 1.24.x it loads the
**asyncify** WebAssembly pair, not the `jsep` one.

| File | Size | SHA-256 |
|---|---|---|
| `ort.webgpu.bundle.min.mjs` | 114 KB | `4aa071e26a290e5147a07b39834fe923f1e810eb69a26faa7ca66ad811ba8ffd` |
| `ort-wasm-simd-threaded.asyncify.mjs` | 47 KB | `dee69056fbfedf946ba0d9026e191c1361c5455895355e03f4346bf9308e58eb` |
| `ort-wasm-simd-threaded.asyncify.wasm` | 26 MB | `f33595b9f7ea51aa6f646dd5a2bde6fbb1c7bcde0b9d2b5f240011a09c1830d0` |

The app sets `numThreads: 1`. Multi-threaded WebAssembly needs cross-origin isolation (the
`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` response headers), which a plain
static file server does not send. Raising the thread count means serving those headers first.

## Upgrading

1. Download the new tarball from the registry and record its SHA-256.
2. Extract into `vendor/molstar/<new-version>/` beside the old one.
3. Point `index.html` at the new path, check the viewer still loads a structure, then delete the old
   directory in the same commit.

## Model weights

### ProteinMPNN `v_48_020`

The default ProteinMPNN checkpoint: 48 neighbours, 0.20 Å training backbone noise. Converted to
ONNX by the webProteinMPNN authors; the network itself is ProteinMPNN by Dauparas et al. (Science,
2022), not a model they trained.

| | |
|---|---|
| Source | https://huggingface.co/MurrellLab/webports, revision `b02389db87d2b94709f980911294287fb87b8736` |
| Path in that repo | `webProteinMPNN/models/proteinmpnn/v_48_020/` |
| Licence | MIT — `proteinmpnn/v_48_020/LICENSE.ProteinMPNN`, plus `THIRD_PARTY_NOTICES.md` |
| Upstream | https://github.com/dauparas/ProteinMPNN at commit `8907e667` |
| Source checkpoint SHA-256 | `c9cb4a671d79604111231f8dbfc7c590e06f1197453b7a6854ac6661a642f5bd` |

`manifest.json` carries a SHA-256 for each of the four binary files. All four were checked against
it when vendored, and `app/design.js` passes `verifyIntegrity: true` so the runtime checks them
again on every load. To re-check by hand:

```sh
cd vendor/proteinmpnn/v_48_020 && shasum -a 256 encoder.onnx decoder-step.onnx decoder-full.onnx embedding.bin
```

| File | Size |
|---|---|
| `encoder.onnx` | 3.8 MB |
| `decoder-full.onnx` | 2.7 MB |
| `decoder-step.onnx` | 2.7 MB |
| `embedding.bin` | 10.5 KB (21 tokens × 128 dims × float32) |

Eight other checkpoints exist in that repository — solubleMPNN, CA-only, and other noise levels.
Add one here, with its hashes, when the app offers a choice.

## Repository size

`vendor/` is about 40 MB, most of it the 26 MB WebAssembly runtime and 9.2 MB of model weights.
That is the direct cost of `AGENTS.md`'s rule that nothing is fetched from a CDN at runtime: the
app has to serve these from its own origin, so they have to be in the repository. Git LFS would
keep clones small without changing what the app serves, if the size becomes a problem.

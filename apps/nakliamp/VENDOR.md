# Vendored playback engine

NakliAmp vendors Reel's public engine boundary without modification.

- Upstream repository: `https://github.com/NakliTechie/reel`
- Reel commit: `292b0916d7f139f6f27fe14661772a7dee43da7d`
- Reel engine: `engine/reel-engine.mjs`
- Mediabunny release: `1.51.0`
- Mediabunny license: MPL-2.0
- libav.js release: `6.10.9.0`, variant `nakliamp`
- libav.js license: LGPL-2.1 (ffmpeg configured without `--enable-gpl`)

## Integrity

| Path | SHA-256 |
|---|---|
| `engine/reel-engine.mjs` | `791a691fd8d0d95c9cf7fd27adf3bad2469c918f15e30ed9e57f05d0dad4c175` |
| `vendor/mediabunny/mediabunny-1.51.0.min.mjs` | `1cd761e442a173c461b1a63cba29cb0816383f3b93b78d64b6e44c6dbce85d2b` |
| `vendor/mediabunny/LICENSE-MPL-2.0.txt` | `3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04` |
| `vendor/libav/libav-6.10.9.0-nakliamp.wasm.wasm` | `cdc5ce039f8e584f01a22d94e5026a17caa61d870978920a29c898ac39b46cd3` |
| `vendor/libav/libav-6.10.9.0-nakliamp.wasm.mjs` | `6248df5db8d7d91f30ce4b678c851fe6030747496407a2e6deabb16ad0cf6b1a` |
| `vendor/libav/libav-6.10.9.0-nakliamp.loader.mjs` | `272cef7c32705b2e70290cf4698350e2c888b00b789f11a97386195aa5d0b691` |
| `vendor/libav/LICENSE-LGPL-2.1.txt` | `20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95` |
| `vendor/libav/LICENSE-LGPL-NOTICE.md` | `afb8d248e345d343a45f74a5666f850d1920fb5a0006621a5a45e570687933bf` |

Keep the three paths together. NakliAmp imports only `engine/reel-engine.mjs`.
The engine remains the sole Mediabunny ingress. Engine changes land upstream in
Reel, pass Reel's gate, then arrive here as a new exact commit and hash set.

## libav.js — the R3 software decoder

Built from `https://github.com/Yahweasel/libav.js` at tag `v6.10.9.0` with a
custom variant, because no prebuilt variant carries these codecs:

```sh
node configs/mkconfig.js nakliamp '["avformat","avcodec","avfilter","swresample",
  "audio-filters","demuxer-asf","decoder-wmav1","decoder-wmav2","decoder-wmapro",
  "decoder-wmalossless","demuxer-wavpack","decoder-wavpack","demuxer-ape",
  "decoder-ape","demuxer-mpc","demuxer-mpc8","decoder-mpc7","decoder-mpc8",
  "demuxer-tta","decoder-tta","demuxer-dsf","decoder-dsd_lsbf","decoder-dsd_msbf",
  "decoder-dsd_lsbf_planar","decoder-dsd_msbf_planar","demuxer-mov","decoder-alac"]'
make build-nakliamp
```

The four library components come first and are not optional: without
`avformat`, `avcodec`, `avfilter` and `swresample` the frontend binds none of
its high-level helpers and the instance is unusable.

Build it inside libav.js's own `emscripten/emsdk` Docker image. The current binary (since v1, adding ALAC through `demuxer-mov` and `decoder-alac`) was built with `emscripten/emsdk@sha256:6bd7aef93408b10bf7b36642cb7c91119b302f720b9ec2d20439f73cf07fe894` (emcc 7.0.0); run `node mkconfig.js` from inside `configs/`. A local
Homebrew emscripten 6.0.1 produces an **empty `libavutil.a`** and the link
fails; the pinned toolchain is the supported path.

**LGPL-2.1 obligations.** The library must stay replaceable, so be precise
about where it actually is:

- **In this repository** the `.wasm` is its own file at
  `vendor/libav/libav-6.10.9.0-nakliamp.wasm.wasm`, alongside its glue and the
  full LGPL-2.1 text. Replacing it is a file copy plus a hash update in
  `scripts/verify-vendor.mjs`.
- **In `dist/nakliamp-full.html`** it is embedded as base64, because that
  artifact's whole purpose is to be one file. Relinking is served by the
  separate copy above plus the build recipe: the configuration given here and
  the tagged upstream reproduce this exact binary, and rebuilding the artifact
  with a replacement `.wasm` in `vendor/libav/` is a single command.
- **The hosted build and the lean artifact do not contain it at all.** They
  register only the in-house PCM decoder, so there is no library to replace.
  An earlier version of this file claimed the hosted build shipped a swappable
  `.wasm`; it never did.

Corresponding source is `https://github.com/Yahweasel/libav.js` at tag
`v6.10.9.0` plus the configuration above. Do not substitute a build configured
with `--enable-gpl`: that would relicense NakliAmp itself.

Corresponding Mediabunny source is available from the upstream release and
package URLs recorded in Reel's `VENDOR.md` at the pinned commit. Recipients may
also obtain the source from `https://github.com/Vanilagy/mediabunny/tree/v1.51.0`.

## music-metadata: tag writing (since v1)

- Package: `music-metadata` 12.5.0, MIT, `https://github.com/Borewit/music-metadata`.
- Vendored: only the browser write entry (`updateBuffer` and its error classes), bundled once with
  esbuild 0.24.0: `npx esbuild entry.mjs --bundle --format=esm --platform=browser --minify --legal-comments=none --target=es2022`.
- Bundled dependencies: strtok3 10.8.0, token-types 6.2.0, file-type 22.3.0, @tokenizer/inflate 0.6.1,
  @borewit/text-codec 0.2.3, uint8array-extras 1.6.0, debug 4.4.3, ms 2.1.3 (all MIT), ieee754 1.2.1
  (BSD-3-Clause). All licence texts are in `vendor/music-metadata/LICENSES.txt`.
- Reading tags stays with NakliAmp's own parser (`app/library/metadata.mjs`).

| Path | SHA-256 |
|---|---|
| `vendor/music-metadata/music-metadata-12.5.0-write.min.mjs` | `3ad39ca1d79786792a249f4adf96092c1a4dec8c7bb5cfdbde7956ebe783d747` |
| `vendor/music-metadata/LICENSES.txt` | `20ecb284b32a4d5e911b4694d1c97ee0400637990f06e84edd75d77fa07d6d48` |

## Butterchurn: Milkdrop visualiser (since v1)

- `butterchurn` 3.0.0-beta.5, MIT, `https://github.com/jberg/butterchurn`, npm gitHead
  `63e587a7ba3093382e456cce4538e70babcd7197`; `dist/butterchurn.min.js` copied byte for byte. A pinned
  beta, because 3.x is an ES module that compiles preset equations to WebAssembly and needs only
  `'wasm-unsafe-eval'`, where the stable 2.6.7 needs `'unsafe-eval'`.
- `butterchurn-presets` 3.0.0-beta.4, MIT (the package licence file); 10 presets. The presets were written
  by third parties credited in the package; NakliAmp relies on the package licence.
- Loaded only when the Milkdrop mode is first chosen.

| Path | SHA-256 |
|---|---|
| `vendor/butterchurn/butterchurn-3.0.0-beta.5.min.mjs` | `b5353af542b95cb5264069a0a4f52a23174e45745b58c48e245a3557d229b640` |
| `vendor/butterchurn/presets-3.0.0-beta.4.mjs` | `a500b2b85493c37a4001033544294bdb288d0607cc591ec438562149adce4b5e` |
| `vendor/butterchurn/LICENSE-MIT.txt` | `e5c204814d7119c939d9f111691e0c2008607d09c2f4679691e6dc5a10f24b98` |
| `vendor/butterchurn/LICENSE-presets-MIT.txt` | `e5c204814d7119c939d9f111691e0c2008607d09c2f4679691e6dc5a10f24b98` |

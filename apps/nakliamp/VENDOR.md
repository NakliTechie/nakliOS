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
| `vendor/libav/libav-6.10.9.0-nakliamp.wasm.wasm` | `e2a952132a942ee59f7d7624378e4f60568d120157e428e82a59e06b5ead7829` |
| `vendor/libav/libav-6.10.9.0-nakliamp.wasm.mjs` | `4c679eab179d5f9307611fb349edca62cf264a511ebbf66aaa94ea795a6cd4b6` |
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
  "decoder-dsd_lsbf_planar","decoder-dsd_msbf_planar"]'
make build-nakliamp
```

The four library components come first and are not optional: without
`avformat`, `avcodec`, `avfilter` and `swresample` the frontend binds none of
its high-level helpers and the instance is unusable.

Build it inside libav.js's own `emscripten/emsdk` Docker image. A local
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

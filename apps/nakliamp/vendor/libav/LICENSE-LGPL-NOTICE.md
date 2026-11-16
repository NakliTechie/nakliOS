# libav.js in NakliAmp: LGPL-2.1 corresponding-source notice

NakliAmp's software decoder for WMA, WavPack, APE, Musepack, TTA, DSD and ALAC is
libav.js, a WebAssembly build of FFmpeg. FFmpeg and libav.js are licensed under the
GNU Lesser General Public License version 2.1 or later. The full licence text is in
`vendor/libav/LICENSE-LGPL-2.1.txt` and, in `dist/nakliamp-full.html`, in the block
with id `libav-lgpl-licence`.

## Which files contain it

- `vendor/libav/libav-6.10.9.0-nakliamp.wasm.wasm` (the library),
  `vendor/libav/libav-6.10.9.0-nakliamp.wasm.mjs` (its glue) and
  `vendor/libav/libav-6.10.9.0-nakliamp.loader.mjs` (its frontend), in the NakliAmp
  repository at `https://github.com/NakliTechie/nakliamp`.
- `dist/nakliamp-full.html`, which embeds the same `.wasm` as base64 and the two
  modules as text.
- The lean `dist/nakliamp.html` and the hosted page do not load it.

## Corresponding source

- libav.js: `https://github.com/Yahweasel/libav.js`, tag `v6.10.9.0`, which builds
  FFmpeg 9.0. The libav.js release fetches the FFmpeg 9.0 source during the build.
- Variant name: `nakliamp`. FFmpeg is configured without `--enable-gpl`,
  `--enable-nonfree` or `--enable-version3`, so the build is LGPL-2.1-or-later.
- Component configuration, run from the `configs/` directory of that tag:

```sh
node mkconfig.js nakliamp '["avformat","avcodec","avfilter","swresample",
  "audio-filters","demuxer-asf","decoder-wmav1","decoder-wmav2","decoder-wmapro",
  "decoder-wmalossless","demuxer-wavpack","decoder-wavpack","demuxer-ape",
  "decoder-ape","demuxer-mpc","demuxer-mpc8","decoder-mpc7","decoder-mpc8",
  "demuxer-tta","decoder-tta","demuxer-dsf","decoder-dsd_lsbf","decoder-dsd_msbf",
  "decoder-dsd_lsbf_planar","decoder-dsd_msbf_planar","demuxer-mov","decoder-alac"]'
```

- Build command, from the root of that tag:

```sh
make build-nakliamp
```

- Toolchain: libav.js's `emscripten/emsdk` Docker image,
  `emscripten/emsdk@sha256:6bd7aef93408b10bf7b36642cb7c91119b302f720b9ec2d20439f73cf07fe894`
  (emcc 7.0.0).
- NakliAmp does not modify libav.js or FFmpeg source. The only change is the
  configuration above.

## Replacing the library

Build a replacement with the recipe above (or your own modified FFmpeg), copy the
`.wasm`, `.wasm.mjs` and `.loader.mjs` files over the ones in `vendor/libav/`, update
their SHA-256 values in `scripts/verify-vendor.mjs` and `VENDOR.md`, and run
`node scripts/build-single-file.mjs --full` to rebuild `dist/nakliamp-full.html`.

## Upstream note

libav.js ships the licence in its source file headers and keeps a short `LICENSE` note
in its repository. That note asks anyone who distributes builds with changes beyond
configuration to share those changes. NakliAmp distributes configuration changes only.

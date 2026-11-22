# Vendored playback engine

NakliAmp vendors Reel's public engine boundary without modification.

- Upstream repository: `https://github.com/NakliTechie/reel`
- Reel commit: `292b0916d7f139f6f27fe14661772a7dee43da7d`
- Reel engine: `engine/reel-engine.mjs`
- Reel licence: MIT. Reel's copyright holder (Chirag Patnaik, NakliTechie) licensed Reel under MIT on
  2026-11-17 (Reel commit `1496ba67fb1a33892dc5845322c9b56b75f8bfce`, `LICENSE`), which covers the pinned file.
  `engine/LICENSE-reel.txt` carries that text beside the file, and both single-file builds carry it (block id
  `reel-licence`). The engine itself stays pinned at the commit above.
- Mediabunny release: `1.51.0`
- Mediabunny license: MPL-2.0
- libav.js release: `6.10.9.0`, variant `nakliamp`
- libav.js license: LGPL-2.1 (ffmpeg configured without `--enable-gpl`)

## Integrity

| Path | SHA-256 |
|---|---|
| `engine/reel-engine.mjs` | `791a691fd8d0d95c9cf7fd27adf3bad2469c918f15e30ed9e57f05d0dad4c175` |
| `engine/LICENSE-reel.txt` | `741108235dce3ce3947f4fb000e40cb8de7a4a3f02a18790f2cd91bbe99399bc` |
| `vendor/mediabunny/mediabunny-1.51.0.min.mjs` | `1cd761e442a173c461b1a63cba29cb0816383f3b93b78d64b6e44c6dbce85d2b` |
| `vendor/mediabunny/LICENSE-MPL-2.0.txt` | `3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04` |
| `vendor/libav/libav-6.10.9.0-nakliamp.wasm.wasm` | `cdc5ce039f8e584f01a22d94e5026a17caa61d870978920a29c898ac39b46cd3` |
| `vendor/libav/libav-6.10.9.0-nakliamp.wasm.mjs` | `6248df5db8d7d91f30ce4b678c851fe6030747496407a2e6deabb16ad0cf6b1a` |
| `vendor/libav/libav-6.10.9.0-nakliamp.loader.mjs` | `272cef7c32705b2e70290cf4698350e2c888b00b789f11a97386195aa5d0b691` |
| `vendor/libav/LICENSE-LGPL-2.1.txt` | `20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95` |
| `vendor/libav/LICENSE-LGPL-NOTICE.md` | `a433962c03da35a986364c456529354d682b9bd596f0a0396174526b1376f463` |

Keep the three paths together. NakliAmp imports only `engine/reel-engine.mjs`.
The engine remains the sole Mediabunny ingress. Engine changes land upstream in
Reel, pass Reel's gate, then arrive here as a new exact commit and hash set.

## libav.js — the R3 software decoder

Built from `https://github.com/Yahweasel/libav.js` at tag `v6.10.9.0` (FFmpeg 9.0) with a
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
- **The hosted page and the lean artifact never load it.** `index.html`
  imports no libav module and registers only the in-house PCM decoder; only
  the full build adds `libavDecoder`. A host that mirrors the repository may
  still copy the three libav files (the NakliOS mirror at
  `naklios.dev/apps/nakliamp/` did on 2026-11-17); a copy that includes them
  must include `LICENSE-LGPL-2.1.txt` and `LICENSE-LGPL-NOTICE.md` beside them.
  An earlier version of this file claimed the hosted build shipped a swappable
  `.wasm`; the page never loaded one.

Corresponding source is `https://github.com/Yahweasel/libav.js` at tag
`v6.10.9.0` plus the configuration above. `vendor/libav/LICENSE-LGPL-NOTICE.md`
states the same facts (tag, FFmpeg version, component configuration, build
command, toolchain digest and this repository's URL) and travels inside
`dist/nakliamp-full.html` as block `libav-lgpl-notice`. Do not substitute a build configured
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

## Webamp: classic skin face (since v1.x)

- `webamp` 2.3.1, MIT, Jordan Eldredge, `https://github.com/captbaritone/webamp`. Source: npm tarball
  `webamp-2.3.1.tgz` (integrity
  `sha512-u2NpSKYsUfDKltcvteF3vDbAzp+kDiymr5Sn0Vgfl+Uk9Kvd4GmuaF3stOxKNLbDH+RkJ2YZfus7O3W2axq4Qg==`, tarball
  SHA-256 `d45a3d46cbd3e4bdd39a9b71656d87341ddac48b4a4c4a61356ec065a6bba7c0`), file `built/webamp.bundle.min.mjs`,
  upstream SHA-256 `41817e47fdb1f969a74e0202135e72d080d73236f5f0a7709f17b696784e0035`.
- NakliAmp drives it through Webamp's `__customMediaClass` option, so NakliAmp's engine plays every sound and
  Webamp only draws the skin. Loaded only when the person picks a `.wsz` file; not inlined in the single-file
  builds.
- Patched art (Chirag's decision, 2026-11-17: "Patch the webamp bundle."). Upstream compiles Nullsoft's base
  2.91 skin into the bundle as the fallback for sheets a user skin lacks. `scripts/patch-webamp-skin.mjs`
  replaces all of it with neutral art drawn in that script (flat greys, plain transport shapes, its own pixel
  font, the title "NAKLIAMP", no Nullsoft or Winamp artwork or branding), at the same sprite sizes as Webamp's
  sprite map, so layout and hit areas are unchanged. Webamp's code is unchanged. What changes:
  - 350 `background-image` data URLs in the built-in skin CSS (319 sprites across MAIN, TITLEBAR, CBUTTONS,
    NUMBERS, NUMS_EX, TEXT, POSBAR, VOLUME, BALANCE, SHUFREP, MONOSTER, PLAYPAUS, PLEDIT, EQMAIN, EQ_EX, GEN
    including its 52 letter sprites);
  - 18 cursor data URLs (6 distinct upstream cursors) become two drawn cursors, an arrow and a resize arrow;
  - the 52 GEN letter width rules, to fit the new letters;
  - the default skin object: `EQ_PREAMP_LINE` and `EQ_GRAPH_LINE_COLORS` images, the 24 visualiser colours
    (VISCOLOR) and the playlist style (PLEDIT.TXT) become neutral greys;
  - five user-visible strings (coordinator request 2026-11-17, spec row V5: the face is never named Winamp):
    `"Winamp Menu"` (options button tooltip and accessible name) becomes `"Menu"`; `"Winamp 2.91"` (marquee text
    when nothing else shows) becomes `"NakliAmp"`; `"WINAMP"` (heading of the exported playlist page) becomes
    `"NakliAmp"`; `<title>Winamp Generated PlayList</title>` becomes `<title>NakliAmp playlist</title>`;
    `"Winamp Playlist.html"` (its download name) becomes `"NakliAmp playlist.html"`;
  - the last line, the `sourceMappingURL` comment, is removed so the browser requests no map file.
  Kept on purpose, because they are code, not wording: the Redux action types `CLOSE_WINAMP`, `OPEN_WINAMP`,
  `MINIMIZE_WINAMP`; the CSS classes `winamp-active`, `winamp-button`; and the `.eqf` file signature
  `Winamp EQ library file v1.1`, which every `.eqf` reader checks (NakliAmp's `app/audio/eqf.mjs` too). The
  bundle contains no "Nullsoft" text. The bundle has no GENEX, VIDEO, AVS, MB or REGION art and no animated
  cursors; Webamp's built-in GENEX colour values are unchanged. `test/webamp-patch.test.mjs` checks that none of
  the 311 distinct upstream asset payloads (stored there as SHA-256 only) remain, that the vendored file is the
  script's fixed point, and that the bundle parses as a module.
- Bundled third-party code: the bundle contains 38 package versions besides Webamp's own code: 34 that the
  source map in the same tarball (`built/webamp.bundle.min.mjs.map`) names under `node_modules`, ani-cursor
  and winamp-eqf from Webamp's own repository, and pako and setimmediate inside JSZip's prebuilt file. `vendor/webamp/LICENSES-bundled.txt`
  holds each one's licence text from its npm tarball at the bundled version. All are MIT except ieee754 1.2.1
  (BSD-3-Clause), tinyqueue 3.0.0 and winamp-eqf 2.3.1 (ISC), pako 1.0.11 (MIT, with zlib's licence for its
  zlib port) and jszip 3.10.1 (MIT or GPL-3.0-or-later; NakliAmp uses it under MIT). React 19.1.0,
  react-dom 19.1.0, scheduler 0.26.0, react-is 16.13.1 and 18.3.1, use-sync-external-store 1.2.2, redux 5.0.1,
  react-redux 8.1.3, redux-thunk 3.1.0, reselect 3.0.1, lodash 4.17.21, classnames 2.5.1, invariant 2.2.4,
  jszip 3.10.1 (whose prebuilt file carries pako, setimmediate 1.0.5, lie 3.3.0 and immediate 3.0.6),
  music-metadata 11.6.0 and its readers (strtok3 10.3.1, token-types 6.0.3, file-type 21.0.0,
  @tokenizer/inflate 0.2.7, uint8array-extras 1.4.0, content-type 1.0.5, media-typer 1.1.0, debug 4.4.1,
  ms 2.1.3, ieee754 1.2.1), the RIFF readers (riff-file 1.0.3, byte-data 18.1.1, endianness 8.0.2,
  ieee754-buffer 2.0.0, utf8-buffer 1.0.0), fflate 0.8.2, tinyqueue 3.0.0, and Webamp's own packages
  ani-cursor 2.3.1 and winamp-eqf 2.3.1, which ship no licence file (their package.json declares the licence
  and author; the notice uses that). JSZip 3.10.1 does not record the exact pako 1.0.x it bundled; the text is
  pako 1.0.11's. The bundle is not inlined in the single-file builds, so this file travels only with the
  repository and any mirror that copies the bundle.
- With that fallback, NakliAmp loads any `.wsz` that contains at least `MAIN.BMP`. The Winamp name and interface
  are Nullsoft's (Webamp README); NakliAmp says "classic skins".
- Command (output bytes depend on Node's zlib build; made with Node v22.23.4, zlib 1.3.1-e00f703):

  ```sh
  cd "$(mktemp -d)" && npm pack webamp@2.3.1 && mkdir pkg && tar xzf webamp-2.3.1.tgz -C pkg
  node /Users/chiragpatnaik/Code/nakliamp/scripts/patch-webamp-skin.mjs pkg/package/built/webamp.bundle.min.mjs
  ```

| Path | SHA-256 |
|---|---|
| `vendor/webamp/webamp-2.3.1.bundle.min.mjs` | `15915991ffc5334e57ec7011a92a75e811a5e701c6358db682e2d5c8d1a3d100` |
| `vendor/webamp/LICENSE-MIT.txt` | `fc7f2696d3e70b5c04659de0a843c1d7defebbb14eb2a07a38808fead88d9279` |
| `vendor/webamp/LICENSES-bundled.txt` | `e129f54a59cc33a73737886ec2e2f40e6401bca7757976f82cdc844d85061365` |

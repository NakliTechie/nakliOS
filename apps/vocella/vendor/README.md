# Vendored libraries

Pinned copies, served from this folder. Nothing loads from a CDN at runtime. To update one: read its release notes, replace the file, update this table, and run `npm test`.

| File | Package | Source | SHA-256 |
|---|---|---|---|
| `sql-wasm.js` | [sql.js](https://github.com/sql-js/sql.js) 1.14.2 (SQLite 3.49.1) | `dist/sql-wasm.js`, copied from xenohunter/ankigen `vendor/` at faab49b | `f1c84000dbc856c9d87f4f3aabc4d3654bd436165db4be3da13751db3a9c20d7` |
| `sql-wasm.wasm` | sql.js 1.14.2 | `dist/sql-wasm.wasm`, same copy | `38c14f6e379210bc942bdc4ebca44e7bfdb4318ecc1c72ca666a28fdce96670a` |
| `fflate.js` | [fflate](https://github.com/101arrowz/fflate) 0.8.3 | `esm/browser.js`, same copy | `b7ca4450b19559a1d50eb381adcee94b82449674be4cd17789d9beba7e6122a1` |
| `katex.mjs` | [KaTeX](https://github.com/KaTeX/KaTeX) 0.19.0 | `dist/katex.mjs` from the npm tarball (integrity `sha512-v6Tznz3zJ7u3niRCoDTsumM2+HA2XXcCu+WAacCeHD2z3p9A9Ks987o5FzfTGBN0e8A0vjEgIDvLbICrXpdw/Q==`, checked; published 2026-10-01) | `e5bc26598084ad869939ecaa262673814f26ed586312a409b5f8427c01e4f681` |
| `ts-fsrs.mjs` | [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) 5.4.2 | `dist/index.mjs` from the npm tarball (integrity `sha512-z4qop4pzTcyTzuJ566d9EaX/4bZZzhYfeaPImfVr+xcYT65c5oBgFDijUhCE/D+C78eaolHIhKRZ04/RwF+v2g==`, checked; published 2026-09-01) | `ad4a4b3b7e259fcbf02764454c8f9db4ea3bf5aae2f473198129ecb7728f1a19` |
| `fzstd.js` | [fzstd](https://github.com/101arrowz/fzstd) 0.1.1 | `esm/index.mjs` from the npm tarball (integrity `sha512-dkuVSOKKwh3eas5VkJy1AW1vFpet8TA/fGmVA5krThl8YcOVE/8ZIoEA1+U1vEn5ckxxhLirSdY837azmbaNHA==`, checked) | `1a901fc5a58c349bbdb4f2aa1e688637ef56891ec58243a9f0cd863166b0d2a4` |

The sql.js and fflate hashes match the table in AnkiGen's `vendor/README.md`. Check them with `shasum -a 256 vendor/*.js vendor/*.wasm`.

Licences: `LICENSE-sql.js` (MIT; SQLite itself is public domain), `LICENSE-fflate` (MIT), `LICENSE-fzstd` (MIT), `LICENSE-katex` (MIT), `LICENSE-ts-fsrs` (MIT).

How they load:
- `sql-wasm.js` is a classic script that defines `initSqlJs`. The page adds it on the first file open (`src/app.js`); the tests load it through `tests/lib/sqljs.mjs`, which is copied from AnkiGen's `tools/lib/sqljs.mjs` (MIT).
- `fflate.js` and `fzstd.js` are ES modules imported by `src/apkg.js`. fzstd decompresses `collection.anki21b`, the format current Anki exports, and its media.
- `katex.mjs` is imported by `src/reader.js` only when an opened package has formulas; `src/math.js` renders them as MathML.
- `ts-fsrs.mjs` is imported by `src/reader.js` for study-mode scheduling.

`vendor/ankigen/` is AnkiGen's deck builder and data bundles for the deck picker, copied unmodified by `tools/vendor-ankigen.mjs`; its own `README.md` lists the commit, licences and each file's SHA-256.

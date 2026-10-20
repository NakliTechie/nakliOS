# Vendored libraries

Pinned copies, served from this folder. Nothing loads from a CDN at runtime. To update one: read its release notes, replace the file, update this table, and run `npm test`.

| File | Package | Source | SHA-256 |
|---|---|---|---|
| `sql-wasm.js` | [sql.js](https://github.com/sql-js/sql.js) 1.14.2 (SQLite 3.49.1) | `dist/sql-wasm.js`, copied from xenohunter/ankigen `vendor/` at faab49b | `f1c84000dbc856c9d87f4f3aabc4d3654bd436165db4be3da13751db3a9c20d7` |
| `sql-wasm.wasm` | sql.js 1.14.2 | `dist/sql-wasm.wasm`, same copy | `38c14f6e379210bc942bdc4ebca44e7bfdb4318ecc1c72ca666a28fdce96670a` |
| `fflate.js` | [fflate](https://github.com/101arrowz/fflate) 0.8.3 | `esm/browser.js`, same copy | `b7ca4450b19559a1d50eb381adcee94b82449674be4cd17789d9beba7e6122a1` |
| `fzstd.js` | [fzstd](https://github.com/101arrowz/fzstd) 0.1.1 | `esm/index.mjs` from the npm tarball (integrity `sha512-dkuVSOKKwh3eas5VkJy1AW1vFpet8TA/fGmVA5krThl8YcOVE/8ZIoEA1+U1vEn5ckxxhLirSdY837azmbaNHA==`, checked) | `1a901fc5a58c349bbdb4f2aa1e688637ef56891ec58243a9f0cd863166b0d2a4` |

The sql.js and fflate hashes match the table in AnkiGen's `vendor/README.md`. Check them with `shasum -a 256 vendor/*.js vendor/*.wasm`.

Licences: `LICENSE-sql.js` (MIT; SQLite itself is public domain), `LICENSE-fflate` (MIT), `LICENSE-fzstd` (MIT).

How they load:
- `sql-wasm.js` is a classic script that defines `initSqlJs`. The page adds it on the first file open (`src/app.js`); the tests load it through `tests/lib/sqljs.mjs`, which is copied from AnkiGen's `tools/lib/sqljs.mjs` (MIT).
- `fflate.js` and `fzstd.js` are ES modules imported by `src/apkg.js`. fzstd decompresses `collection.anki21b`, the format current Anki exports.

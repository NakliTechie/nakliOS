# sql.js (vendored)

SQLite compiled to WebAssembly. Atelier loads it only when the person imports a Lightroom catalog
(`.lrcat`, a SQLite file); nothing else in Atelier touches it.

- Package: `sql.js` 1.15.2 (published 2026-10-26), MIT licence (`LICENSE` in this folder).
- Source: https://registry.npmjs.org/sql.js/-/sql.js-1.15.2.tgz
- Tarball integrity (npm): `sha512-ZmMYFsZPZWDKIJUh3A5rdnpRV3hB/r7AijwAzSzLnfv/9CSx4obUmDtA8brAjWJWjGtUVh43nIEJ+6nl6HuOUg==`
- Tarball SHA-256: `74fbdd373ad7eb2bbe74c7807581c1c39e424ee53ed95042a02208cbc96d72fd`
- Files copied unchanged from the tarball's `package/`:

| File | From | SHA-256 |
|---|---|---|
| `sql-wasm.js` | `dist/sql-wasm.js` | `b46d4bddfdde8a787fc4764bd0a405cdfdf96fbd77e6a4e95446106826ecfa47` |
| `sql-wasm.wasm` | `dist/sql-wasm.wasm` | `0dfeecda2070b36da0cd4f6afa250af9453de528a983770f85b13d5d6b667572` |
| `LICENSE` | `LICENSE` | `60a3f6e4d7b29b4321359e683b36cf198d24f58e24582070f56e6fa89d5ee2be` |

To update: download the new tarball, check its `dist.integrity` against `npm view sql.js@<v> dist.integrity`,
copy the same three files, and replace the hashes above.

`package.json` here (`{ "type": "commonjs" }`) is Atelier's own: it lets node tests `require` the UMD
`sql-wasm.js`, which Atelier's `"type": "module"` would otherwise load as an ES module. The browser loads
`sql-wasm.js` with a script tag and ignores it.

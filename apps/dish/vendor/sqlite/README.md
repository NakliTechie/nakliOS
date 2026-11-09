# SQLite (WebAssembly) for Dish

`index.mjs` and `sqlite3.wasm` are `dist/` files from `@sqlite.org/sqlite-wasm` 3.54.1-build1 (Apache-2.0, sqlite.org),
npm integrity `sha512-foW427VBLJ3G87bsnvQTZCc9zYe0Fq1wH0pz1I6BlKLKXcArIAyTkHtq0iT2llmhcMQt9T/p6l5PpQQh+6O8uQ==`.
SQLite itself is in the public domain. Dish's Worker loads them after boot for dsh's session search
(`scripts/dish/sqlite.ts`). To update, replace both files from the new package and change the version and hash here.

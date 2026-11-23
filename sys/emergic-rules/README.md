# Emergic rules in NakliOS

Emergic's common rules, loaded in the browser as WebAssembly: the day a deadline in plain words names ("by Friday"), the moment a reminder names ("tomorrow at 3pm"), dated promises in mail in both directions, and whether a later reply closes one. Emergic owns the rules (`atrium-solutions/emergic-app`, `src-tauri/crates/emergic-rules`); NakliOS adds no rules of its own and writes no TypeScript copy (decided 2026-11-22).

```js
import { loadEmergicRules } from '/sys/emergic-rules/rules.mjs';
const rules = await loadEmergicRules();
rules.dueInMail('Will revert by Friday.', '2026-11-19');   // { due: '2026-11-20', inferred: false }
rules.promisesIn({ from, to: [..], reply_to: '', body, sent_on: '2026-11-19' }, 'me@example.com');
```

- `emergic-rules.wasm`: built from `crate/` (a JSON-in, JSON-out wrapper) at the crate commit named in `build.json`.
- `rules.mjs`: the loader and the seven calls (`due`, `dueInMail`, `hasTimeWords`, `when`, `promisesIn`, `closes`, `closedFromWord`).
- `test/fixtures/`: Emergic's shared follow-ups corpus (emergic repo `tests/fixtures/followups`).

Rebuild after Emergic changes the crate: move `rev` in `crate/Cargo.toml` to the new emergic-app commit, then run `node scripts/build-emergic-rules.mjs` (needs cargo, the `wasm32-unknown-unknown` target and read access to the private emergic-app repo) and `node scripts/test-emergic-rules.mjs`. CI runs the test against the committed wasm; it cannot rebuild, because it has no access to emergic-app.

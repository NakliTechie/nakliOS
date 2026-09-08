# Postings-memory bench (residue of the SQL search spike)

Measures what one posting-list representation costs against another, over a real
workspace. It is what established that the shipped trigram index was spending
258 MiB of heap on a 38 MiB workspace, and it is the regression check for the fix
in `dc5d41f`.

    node --expose-gc prototypes/sql-search-spike/bench-postings.mjs <corpusRoot> set|setid|ids

    set    Map<hash, Set<pathString>>   what shipped before dc5d41f
    setid  Map<hash, Set<fileId>>       strings dropped, O(1) delete kept
    ids    Map<hash, Uint32Array>       what plan/anvil-indexed-search.md §2 asked for

Each mode runs in its **own process** on purpose. Measuring two in one gave a
negative delta, because the first variant's garbage was collected across the
second's baseline.

Measured on `naklios-universe`, 1,328 files / 38.27 MiB:

| mode | postings memory | × corpus |
|---|---:|---:|
| `set` | 125.4 MiB | 3.27× |
| `setid` | 125.2 MiB | 3.27× |
| `ids` | 42.7 MiB | 1.12× |

The middle row is the point. A V8 `Set` costs ~34 B per entry whether it holds a
string or a small integer, so dropping the path strings buys nothing — only the
typed array does. That is why the fix had to take on an overlay and a fold rather
than just swapping what goes in the Set.

## What used to be here

This directory began as a spike asking whether SQLite FTS5's `trigram` tokenizer
should replace or join Anvil's trigram index. **It should not** — 554 KB gzipped,
6.2× the whole Anvil app, for an advantage that was mostly a data-structure fix
Anvil's own design had already specified. Full numbers, including where FTS5 is
genuinely still better, are in `plan/anvil-sql-search-spike.md`.

The FTS5 harness (`bench.mjs`) and its planner copy (`trigram-lit.mjs`) were
removed once that question was answered. `trigram-lit.mjs` was a 430-line copy of
`sys/rig/fileops/trigram.mjs` — the most reviewed file in the module — and it had
already diverged by 83 lines within a day. A stale duplicate of that file is worse
than no copy at all: it reads as authoritative and is not. The commit history
(`75ec27d`) still has both if the comparison ever needs re-running.

The directory keeps its name because two commit messages and the plan document
refer to it by that path.

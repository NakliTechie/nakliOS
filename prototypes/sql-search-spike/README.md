# SQL search spike — harness

Measures the **shipped** trigram index (`sys/rig/fileops/fileops.mjs`) against
**SQLite FTS5 `trigram`**, to decide whether an in-browser SQL index should
replace or join it. Findings and verdict: `plan/anvil-sql-search-spike.md` (local,
gitignored).

    node --expose-gc prototypes/sql-search-spike/bench.mjs [corpusRoot]
    node --expose-gc prototypes/sql-search-spike/bench-postings.mjs <corpusRoot> set|ids

Nothing here is wired into Anvil. It is measurement only.

## Why it is a fair comparison

Both engines run the **same** hardened query planner. `trigram-lit.mjs` is a copy
of `sys/rig/fileops/trigram.mjs` with exactly one addition — a `TRI` node also
carries its folded literal, so the plan can be rendered as an FTS5 `MATCH`
expression. Plan quality is therefore held constant and the index engine is the
only variable.

Both paths verify every candidate with the real regex, so neither can invent a
match, and `bench.mjs` asserts the two engines return identical match counts. A
`MISMATCH` line means the comparison is void, not that one engine is faster.

## What it does NOT measure

`node:sqlite` provides the same SQLite and the same FTS5 trigram tokenizer without
the wasm bundle, so these numbers describe FTS5's **algorithmic** behaviour only.
Wasm bundle size and boot cost are measured separately and reported in the plan
document — and they are the numbers that decide the question.

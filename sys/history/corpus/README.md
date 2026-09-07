# The replay corpus

Real agent runs, recorded once from a live endpoint, replayed in the gate with **zero model
calls**. Captured 2026-09-07 from Ollama `qwen3:8b`.

Every other test in this repo drives a scripted model, which proves the loop does what the
script says. These prove it still does what a real model made it do.

## What a replay checks

1. **Same answers.** `replayInfer` serves the recorded response for a request hash. Build a
   different request and the hash misses — the replay throws.
2. **Same shape.** `compareRuns` walks both records event by event: verb, input hash, output
   hash. Reaching the same end by a different route is a regression.
3. **Nothing left over.** `assertConsumed()` at teardown. A scenario that drives FEWER calls
   than the run did passes 1 and 2 by stopping early; this is what catches it.

## Adding or re-capturing a scenario

    node scripts/record-corpus.mjs                 # all scenarios (needs a live endpoint)
    node scripts/record-corpus.mjs --only <name>
    OLLAMA=http://127.0.0.1:11434/v1 MODEL=qwen3:8b node scripts/record-corpus.mjs

That is the only thing here that needs a model. Re-capture when a scenario is added, or
deliberately, when the loop's recorded behaviour is meant to change — **never to make a red
lane green**. A red lane means the loop changed; decide whether that was intended.

An entry replays against **its own opening** — the messages and tools out of its `run.started`,
never today's app prompt. So rewording Anvil's system prompt does not stale the corpus. What
the corpus pins is the LOOP, not the prompt.

## The two failure modes a record cannot hold

A settled transcript can only show a run that produced responses. Two paths never do, and they
are declared per entry in an override rather than faked into a record:

- `throwBeforeFirstChunk` — the endpoint fails before emitting anything. The loop does not
  propagate it: it records `run.stopped {stop:'error'}` and returns. That behaviour is the
  thing being pinned.
- `hangUntil` + `released()` — the call never returns until the harness lets it, so a test can
  assert the loop's own deadline or abort without waiting on a real clock.

See `sys/history/test/replay-corpus.test.mjs`.

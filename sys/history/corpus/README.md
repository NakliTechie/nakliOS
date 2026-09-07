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

## Chunk 0's 2b gate conditions (S1)

Three of these entries are the conditions Chunk 0 could previously only close by driving Anvil
by hand and reading the result — which meant re-proving them cost another live run:

| Entry | Condition | What it pins |
|---|---|---|
| `failing-gate` | 0.0 | the model calls `task_done`; the loop intercepts it before executeTool, runs the gate, refuses, and stops `unverified` at the rounds cap |
| `gate-on-prose` | 0.0b | the OTHER route to the gate: the model stops calling tools, and the verdict comes back as a `[coordination]` USER turn |
| `budget-stop` | 0.2 | the budget ends the run, on the **turns** axis |
| `act-or-nudge` | 0.3 | two loops on ONE chain: a prose-only run is nudged and re-entered |

Two of those needed something new:

- **A budget is not in the record.** It sits in `<name>.opts.json`, written at capture. The axis
  is **turns** on purpose — turns and tokens are functions of the transcript and trip at the same
  point under replay; **wall-clock never will**, because a replay is instant. That axis stays a
  live-only check and the corpus does not pretend otherwise.
- **A gate verdict is** in the record, as `verify.passed` / `verify.failed`. `replayVerify` serves
  them in order, so no gate command is ever run.

`gate-on-prose` exists because a mutation found the gap: deleting the loop's `convo.push(fb)` —
feeding a failing verdict back on a no-tool-call turn — survived the whole suite, because
`failing-gate` reaches the gate through the `task_done` interception, which pushes a TOOL message
instead. Two routes into the same refusal, two entries.

## The two failure modes a record cannot hold

A settled transcript can only show a run that produced responses. Two paths never do, and they
are declared per entry in an override rather than faked into a record:

- `throwBeforeFirstChunk` — the endpoint fails before emitting anything. The loop does not
  propagate it: it records `run.stopped {stop:'error'}` and returns. That behaviour is the
  thing being pinned.
- `hangUntil` + `released()` — the call never returns until the harness lets it, so a test can
  assert the loop's own deadline or abort without waiting on a real clock.

See `sys/history/test/replay-corpus.test.mjs`.

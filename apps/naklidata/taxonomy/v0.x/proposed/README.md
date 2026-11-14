# Proposed types

Candidate semantic types that are **not** in the bundle. Each file is a
`nakli-type-proposal` document produced by "Propose to taxonomy" in the
Define-type dialog or by an agent's `proposeType` verb, downloaded by a human
from the schema toolbar → Type proposals.

Nothing in this folder is loaded by the app, read by the classifier, or
exported in the SKOS profile. A file here is a request, not a type.

## Promoting a proposal

1. Read `type.description` and the detectors; check the id against
   `../../v0.1/types.jsonl` and, in `../../v0.1/relationships.json`, the
   `confusable_with` pairs it may collide with (add one if the new type is
   a known confusion).
2. Pick a domain (`type.domain` is `unplaced` until you do) and add the id to
   that domain file under `../../v0.1/domains/`.
3. Copy `type` as one line into `../../v0.1/types.jsonl`, setting
   `created` to today's date and dropping `review` once you have checked the
   detectors against real headers and values.
4. Add a crosswalk row in `../../v0.1/universal/crosswalk.jsonl`.
5. Add a `MIGRATIONS.md` line, bump `edition` in `index.json`, and delete the
   proposal file.

`npm run test` enforces the bundle rules (`validateTypeSpecs`,
`validateUniversalLayer`, `validateRelationships`).

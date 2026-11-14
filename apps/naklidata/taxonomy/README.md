# NakliData taxonomy

`v0.1/` is the shipped bundle: `index.json` (edition, domain list), `types.jsonl`
(one type per line), `domains/*.json`, `relationships.json`, and the Tier-3
`universal/` layer (`universal-terms.jsonl` + `crosswalk.jsonl`). A type is a
JSONL line + a domain-file entry — no code.

The first review-only local suggestion ranks type names, descriptions and
keywords with a TF-IDF index built in the browser from this bundle. It needs
no model download. After a user starts local identification, the queued MiniLM pass uses
`v0.1/semantic-vectors.json`: precomputed q8 embeddings of the same house
types. The asset loads lazily and excludes generated standards-pack fields,
whose exact header detectors own those names. When a house type changes, run
`npm run taxonomy:vectors` to regenerate the asset; `npm run check` refuses a
stale type list, descriptor, model revision, or malformed vector. The browser
uses the same pinned model revision to embed one unresolved column per click.
Two-valued numeric 0/1 columns may surface `yes_no_flag` for review; that
value shape does not trigger automatic assignment. Unitless durations and
broad price/value/total headers likewise require review (spec A63).

## Fields on a type (`types.jsonl`)

| field | required | meaning |
|---|---|---|
| `id`, `display_name`, `domain`, `sql_compat`, `detectors`, `confidence_floor` | yes | the detector contract (spec §3.2) |
| `description` | yes for bundled types | one sentence saying what the type **is** — not how it is detected; feeds the schema-panel hover, `define-type` and `skos:definition` |
| `keywords` | recommended | lowercase header phrases and aliases; `skos:altLabel` |
| `created` | **yes** | ISO date the type entered the bundle (`validateTypeSpecs` rejects a type without one) |
| `updated` | when changed | ISO date of the last detector / crosswalk change — see the migration rule |
| `seed_origin` | machine-seeded only | where a non-human-authored type came from (`agent_v1.0`, `user-defined`) |
| `review` | while owed | `pending` until a human has checked a machine-seeded type against the published format |

## Editions and the migration rule

`index.json` carries `edition`, the date of the current bundle. The first dated
edition is **2026-09-12**; every type carries `created: 2026-09-12` from it.
The current edition is **2026-09-22** after numeric flag SQL compatibility
was added; the migration is recorded in `MIGRATIONS.md`.

When a type's detectors, `sql_compat`, `confidence_floor`, or crosswalk entry
change:

1. set `updated` to the change date;
2. add one line to `MIGRATIONS.md` (this folder): `YYYY-MM-DD · <type id> · <what
   changed> · <what a saved workbook may see differently>`;
3. bump `edition` in `index.json`.

Adding a type needs only `created` and a domain-file entry. Renaming an id is a
breaking change for saved `.naklidata` files and needs a migration line plus
an alias in the old id's `keywords`.

## Standards packs (`packs/`, `v0.1/packs/`)

Published field registries are structurally the same artefact as
`types.jsonl`, so they ship as generated domains (workplan O15):

| pack | registry | edition shipped | license |
|---|---|---|---|
| `otel-semconv` | OpenTelemetry semantic conventions | stable attributes | Apache-2.0 |
| `ecs` | Elastic Common Schema | core-level fields | Apache-2.0 |

`packs/<pack>/registry.json` is the compact snapshot extracted from a named
upstream commit by `scripts/pin-taxonomy-pack-registry.py` (Python 3 +
PyYAML, maintainer-only); `manifest.json` records the commit, the version
label, the snapshot date, the license and the registry's SHA-384. `scripts/generate-taxonomy-packs.mjs` turns each registry into
`v0.1/packs/<pack>.jsonl` (types, ids prefixed `otel_` / `ecs_`, dotted name
as `display_name` and header alias), `<pack>.aliases.json` (names that already
belong to a house type — the house id wins, the dotted name becomes its
alias — spelled collisions and the `SEMANTIC_ALIASES` twins such as
`http.request.method` → `http_method`; bare single-word names such as
`message` are skipped, since the house keeps generic words unassigned),
`<pack>.crosswalk.jsonl`, and `domains/<pack>.json`. `npm run check`
runs it with `--check`, so a committed pack can never drift from its
registry. Re-pin with `scripts/pin-taxonomy-pack-registry.py <pack> <commit> "<label>"`,
then `npm run taxonomy:packs`.

Packs are merged at load (`index.json` → `packs`, `default_enabled`), on by
default, and can be turned off per pack in Settings → Standards packs
(applies at the next load). The house bundle is unchanged by a pack:
`realdata:drive` classifies the same 66/67 with both packs on. Splunk CIM
is not a pack: it ships as a Splunkbase add-on under Splunk's license, not
as an open registry.

## Proposing a type (`v0.x/proposed/`)

The lesson by contrast: OpenAlex's taxonomy is fixed and documents no way to
add a topic. NakliData's has a documented door, and it is a one-way door for
machines:

- A user's Define-type form has **Propose to taxonomy**; an agent has the
  `proposeType` verb (`workspace:propose`). Both produce a
  `nakli-type-proposal` document queued on the workbook — never a user type,
  never a bundle change, never a re-typed column.
- A human downloads it from the schema toolbar → **Type proposals** into
  `v0.x/proposed/<id>.json` and promotes it by hand
  (`v0.x/proposed/README.md`, five steps). The agent surface can propose; only
  a person installs.

Dataset sweeps use a separate staging area under `candidates/`. These registers
record reusable meanings and exact source fields without loading them into the
app or changing an evaluation's label space. Once that evaluation has a frozen
baseline, accepted entries enter the same `v0.x/proposed/` human-promotion path.

## Relationships (`relationships.json`)

Edges between types. Kinds in use: `identifies`, `embeds`, `implies`,
`pairs_with`, `scopes`, `contextualizes`, `performs`, and `confusable_with`.

`confusable_with` is the misconception layer: a pair users and detectors mix up
(gstin↔pan, ifsc↔swift_bic, city↔district_neighbourhood). Each edge carries a
`note` naming the deterministic tie-breaker. `disambiguate-type` walks these
before it calls a model; `explain-error` names the confusion. Edges are
undirected and validated (`validateRelationships`): both ends exist, no
self-loops, no duplicates, note required.

## What detectors may and may not read

Detectors read the header and the values of the column they score. They do
**not** read domain membership: a type being listed in `domains/banking.json`
is a curriculum fact (an industry's scheduling of types), not evidence that a
column is that type. The two maps stay apart: domain files are the curriculum
map, `relationships.json` and the universal layer are the knowledge map.

Domain membership enters a score through exactly one door, the `domain_prior`
detector kind (T4):

- `index.json` → `domain_prior.weight` is the bundle default (0.15); a type may
  declare its own `{"kind":"domain_prior","weight":…}` to override it. Weight
  is capped at 0.2 (`DOMAIN_PRIOR_MAX_WEIGHT`), and the prior enters a score
  only after an ordinary detector has actually scored for that type — so a
  prior alone never makes a type a candidate, all-null columns included.
- The prior fires only on a **second pass**: the first pass runs prior-free,
  the domains of its confidently settled columns (≥ 2 columns and ≥ 25 % of
  the settled ones) become the table's active domains, and only the columns
  the first pass did not settle are re-scored with that list attached.
- A second prior, the **usage prior** (T7), walks through the same door under
  the same gate: an on-device count of how often the user accepted or
  overrode a column *to* each type, kept in this browser's IndexedDB, capped
  at weight 0.1 (`USAGE_PRIOR_MAX_WEIGHT`), saturating at 20 assignments. It
  is written only from a choice the user made by hand — never from detector
  auto-assignment, a sidecar pick, or a `confusable_with` tie-break (all
  self-reinforcing) — never leaves the tab, clears with site data, and can be
  reset from Settings → Classification memory → Forget usage counts.
- In the score breakdown a prior is always the line `Prior, not evidence: …`.
  It never counts as the type having recognised the column (it cannot rescue
  a column from `not_classifiable`, and it is not strict evidence for a
  `confusable_with` tie-break).

## Universal layer (`universal/`)

69 `ut:` concepts with `broader` chains, a `roleFamily`, the canonical
`sensitivity`, and cross-vocabulary links: `exactMatch` for identity,
`closeMatch` for overlap (schema.org, ISO 20022, FHIR, OCDS, dbt). Every
bundled type has exactly one crosswalk row. When a column's leaf is ambiguous
but every candidate descends from one universal term, that term is reported
as the column's family.

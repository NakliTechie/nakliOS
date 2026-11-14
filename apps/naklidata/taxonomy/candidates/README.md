# Dataset-derived taxonomy candidates

Files in this directory are candidate registers awaiting promotion review. They are not runtime
types, proposal documents, standards packs, or classifier inputs.

Each register preserves meanings exposed by evaluation datasets without
changing the target label space during that evaluation. After a baseline is
retained, accepted entries move one at a time through
`taxonomy/v0.x/proposed/README.md` and the normal promotion checks.

The register must name its source manifest, evaluation boundary, promotion
gate, suggested domain, universal term, and exact source fields. A candidate
may remain logged indefinitely. Logging never implies acceptance.

The wave-2 independent review is retained in `dataset-wave2-independent-review.json`.
It reviews all 42 entries: 17 ready for proposal drafting, 18 needing definitions, and seven deferred.
Every entry retains human review and independent-source-or-workflow gates. No entry authorizes installation.
The review records mapping concerns, collisions, sensitivity defaults, and exact frozen sample counts without publishing sample values.

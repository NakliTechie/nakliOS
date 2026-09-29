# js-yaml

Version: 5.4.2. License: MIT, included in `LICENSE`.
Source: https://github.com/nodeca/js-yaml/tree/5.4.2 .

The unmodified self-contained `dist/js-yaml.mjs` comes from the npm release.
`PROVENANCE.json` records the tarball URL, verified SHA-512 integrity and file SHA-256 digests.
The shell imports this local module. It never downloads YAML code at runtime.

The consumer selects `CORE_SCHEMA`, explicit parser/alias limits and duplicate-key rejection.
It then accepts only JSON-compatible values, rejecting nonfinite numbers such as `.inf` and `.nan`.
It counts every alias occurrence and rejects cycles before serialization.
It does not enable merge, timestamp, binary, JavaScript or custom tags.

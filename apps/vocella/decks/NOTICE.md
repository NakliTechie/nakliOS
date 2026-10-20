# Deck notices

The decks in this folder are built from **AnkiGen vocabulary, https://github.com/xenohunter/ankigen**, licensed under [Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/). The `.apkg` files are adaptations of that data (packaged as Anki decks), so they are shared under the same licence. Vocella's code stays MIT (`../LICENSE`).

Upstream notes that the vocabulary was drafted with an AI model and is being reviewed by people, so it may contain errors.

| File | Language, for English speakers | Notes |
|---|---|---|
| `es-en-core-1.apkg` | Spanish, Core I | 483 |
| `fr-en-core-1.apkg` | French, Core I | 473 |
| `de-en-core-1.apkg` | German, Core I | 481 |
| `ja-en-core-1.apkg` | Japanese, Core I | 489 |
| `zh-en-core-1.apkg` | Chinese, Core I | 492 |
| `ko-en-core-1.apkg` | Korean, Core I | 483 |

Source: AnkiGen commit `faab49b542ee88f61e25de1d82677785e95865e7`, data version `2026.10.18`, built with AnkiGen's own `tools/apkg.mjs` and the configuration in each deck's `ankigen` entry in `catalog.json` (Core I module, forward cards, default fields). `catalog.json` also records each file's SHA-256, which the app checks before opening it.

Rebuild: check out that AnkiGen commit, then run `node tools/build-decks.mjs <path to the checkout>`. The export clock is fixed, so the files come out byte-identical.

## The deck picker's data

`vendor/ankigen/bundles/` holds AnkiGen's data bundles at the same commit and data version, under the same CC BY-SA 4.0 licence and attribution, so the picker can build any AnkiGen deck on the device. `vendor/ankigen/README.md` lists each file's SHA-256.

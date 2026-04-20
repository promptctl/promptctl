# Session format schemas

Two committed artifact pairs describe the on-disk shape of AI coding-assistant conversation files that promptctl reads and edits:

| Provider | Schema (JSON)                    | Doc (Markdown)      |
|----------|----------------------------------|---------------------|
| Claude   | [`claude.schema.json`](./claude.schema.json)   | [`claude.md`](./claude.md)   |
| Gemini   | [`gemini.schema.json`](./gemini.schema.json)   | [`gemini.md`](./gemini.md)   |

## What's in each artifact

- **Schema JSON** — corpus-derived description: record kinds, fields, value kinds, presence rates, discriminated-union variants, enum-like fields, reference edges with orphan rates, and API contracts with observed-violation counts.
- **Doc Markdown** — human-readable rendering of the same schema. Always regenerated from the JSON; never hand-edited.

## Regeneration

```sh
npm run schema:extract         # writes both providers
npm run schema:check           # exits non-zero if committed artifacts drift from corpus
```

The extractor lives at [`scripts/schema/`](../../scripts/schema/). It reads:

- Claude sessions from `~/.claude/projects/*/*.jsonl`
- Gemini sessions from `~/.gemini/tmp/*/chats/*.json`

Both defaults can be overridden with `--root <path>`.

## Idempotence

The extractor is deterministic over the same corpus: sorted keys at every depth, stable sample selection by distinct kind-signature, one-newline-terminated JSON. Running twice without corpus changes produces byte-equal output (except the `corpusMeta.extractedAt` timestamp, stripped during `--check`).

Integration tests in [`scripts/schema/__tests__/run.integration.test.ts`](../../scripts/schema/__tests__/run.integration.test.ts) seed a tmp corpus, extract twice, and byte-compare.

## PII

Samples and enum values flow through tiered redaction in [`scripts/schema/core/redact.ts`](../../scripts/schema/core/redact.ts):

- UUIDs → `<UUID>`, timestamps → `<TIMESTAMP>`
- Paths, emails, URLs, well-known secret formats → replaced inline
- Dynamic object keys (file paths used as map keys) → `<dyn>` in descriptors
- Strings > 120 chars → descriptor `<text: ~N chars>`
- Secret-named fields (`apiKey`, `token`, `password`, …) → `<SECRET>` unconditionally
- Objects with > 50 distinct field names → represented as a map, per-key detail dropped

Before committing a regenerated schema, `git diff docs/session-formats/` and scan for any raw path, email, or secret that leaked past the filters.

## Trust levels inside each artifact

Each statement in the schema has an explicit provenance:

| Section                | Source              | What it means                                                |
|------------------------|---------------------|--------------------------------------------------------------|
| `records`              | Corpus-derived      | Observed field shapes and presence rates from the real data. |
| `references`           | Declared + verified | Edges we asserted exist, verified by value-overlap in corpus. High orphan rate → contract is broken or outdated. |
| `suggestedReferences`  | Automatic           | Field pairs with ≥95% value overlap that aren't declared. Requires human review before trusting. |
| `invariants`           | Hand-authored       | API contracts (`source: "api-contract"`). The extractor counts violations but cannot prove them. Zero violations ≠ proof. |

Each invariant cites the adapter line that enforces it. The adapter remains the single source of enforcement; these statements document what readers of the session format can rely on.

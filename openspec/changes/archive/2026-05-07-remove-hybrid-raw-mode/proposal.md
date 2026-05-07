## Why

The current three-mode matrix (`fts-raw`, `hybrid-raw`, `digest-mode`) embeds a low-value middle tier — `hybrid-raw` mode embeds raw transcript text, which the parent change `add-digest-driven-indexing` was specifically introduced to replace because raw-transcript embeddings give poor semantic recall. Keeping `hybrid-raw` available creates two problems:

1. **Wasted compute on a known-inferior strategy.** Users who configure an embedder but no digest model land in `hybrid-raw`, generating thousands of low-quality embeddings against the very content the digest pipeline was designed to distill. This is the regression `add-digest-driven-indexing` set out to fix.
2. **Three-way mode resolution makes partial config a silent footgun.** Today, dropping a `digest.json` without an embedder (or vice versa) silently demotes to a different mode than the user expected. There is no visible signal that the user's intended configuration is incomplete.

Additionally, when running in `digest-mode` today, the FTS sidecar indexes only the digest body. Literal-text recall (file paths, error messages, identifiers, library names that the LLM may not have surfaced) is impossible. The digest is a great semantic lens; it's a lossy lexical lens.

## What Changes

- **BREAKING** Remove `hybrid-raw` mode. The middle tier is gone.
- **BREAKING** Rename `digest-mode` to `digest-hybrid` to better reflect that it fuses semantic (cosine over digest) with lexical (BM25 over digest + raw) search.
- **BREAKING** Mode resolution becomes binary: `fts-raw` (no embedder, no digest model) OR `digest-hybrid` (both configured). Partial configuration (exactly one of embedder / digest model) is a hard misconfiguration error. Verdict resolution is async with one bounded retry (~1 s) to handle pi-coding-agent's registry-population race. Search/digest commands and tools, while always registered at module load, return the misconfigured remediation message when invoked in misconfigured state; the extension also displays a persistent error status line. **Recovery commands** (`/session-embeddings-setup`, `/digest:settings`) work in misconfigured state by design — they ARE the in-pi recovery path. The `missing` field in the misconfigured verdict can be `"embedder" | "digest" | "both"` to cover the both-broken edge case.
- **BREAKING** In `digest-hybrid` mode the FTS sidecar (`hybrid-fts.db`) gains a second indexed column for raw session content. Weighted BM25 column scoring with the normative inequality `digest_body weight > raw_content weight` makes digest matches generally rank higher than equivalent raw-only matches. The specific numeric ratio is implementation-defined and lives in design.md / implementation, NOT in spec text; it MAY change based on calibration without breaking the spec contract. Embeddings remain digest-only. The `raw_content` column uses a **dedicated FTS-shaped concat** (`buildRawFtsContent`), NOT the legacy `buildEmbeddingText` raw concat — see design.md D3 for the field budget and exclusions.
- **BREAKING (refactor, not user-visible)** All `pi.registerCommand`, `pi.registerTool`, AND `pi.on(...)` calls in `src/index.ts` are kept at module-load (registered exactly once per process). Command/tool bodies and lifecycle handler bodies branch on a closure-shared `currentVerdict`. Search/digest commands return the misconfigured remediation message when invoked in misconfigured state; recovery commands (`/session-embeddings-setup`, `/digest:settings`) work in all states. This avoids `pi.on(...)` handler-array accumulation (verified `loader.js` uses append semantics, no unregister API).
- **BREAKING** Index format `INDEX_VERSION` bumps 4 → 5. ANY v4 file triggers an automatic wipe of `session-index.json` + `hybrid-fts.db` on next load — `lastMode` discriminates only the user-facing notify text (hybrid-raw-removal vs format-upgrade vs generic-stale). Digests on disk are preserved (the LLM work is sunk cost; embeddings re-derive cheaply from digests). The migration is **two-phase** (FTS rebuild first, JSON write last) and `FtsSide` introspects `sqlite_master.sql` on every load to self-heal interrupted migrations.
- Remove `markAllDirtyAndClearEmbeddings` lifecycle dependency and `reEvaluate` case (b) — the only path that exercised it was the `hybrid-raw` → `digest-mode` upgrade, which no longer exists.
- Remove `buildEmbeddingText`'s raw-content concatenation fallback (was used only by `hybrid-raw`). Raw concat is repurposed exclusively for the new FTS `raw_content` column.
- Update fallback notify in `lifecycle.ts` — gone is the "Running in hybrid-raw mode." consolation. Misconfiguration is now an error, not a degraded mode. The extension itself owns the error notify (in `startIndex` after verdict resolution); `lifecycle.ts` no longer emits a fallback notify.
- Update `session-embedder` capability spec: the legacy-bedrock-rejection scenario (currently "falls back to fts-raw") becomes verdict-dependent. Bedrock-rejected embedder + digest model configured = `misconfigured`, NOT `fts-raw`.
- Repurpose scenario `S02` (currently "hybrid-raw boots clean") to assert that partial config emits an error notify, search/digest tool invocations return the misconfigured remediation message (the tools remain registered at module load but their bodies short-circuit on `misconfigured` verdict), `/find-session` invocation emits remediation, but `/session-embeddings-setup` and `/digest:settings` invocations work normally. Delete `S21` (was "hybrid-raw → digest-mode upgrade"). Update `S03`–`S07` and digest-related scenarios to reference the renamed mode.
- Update `raw-mode-regression.test.ts` — delete the `hybrid-raw` byte-equivalence assertion. The new test pins that `digest-hybrid`'s FTS row contains BOTH digest body AND raw concat.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `session-indexing`: mode matrix collapses from three modes to two; misconfiguration becomes an error path instead of a graceful demotion; `INDEX_VERSION` bumps 4 → 5; auto-wipe on ANY v4 lastMode (notify text varies); FTS schema introspection self-heals interrupted migrations; warm-path `/reload` verdict transitions defined.
- `session-search`: `digest-hybrid` FTS sidecar gains a `raw_content` column; weighted BM25 scoring replaces single-column scoring; misconfigured state withholds search/digest tools but keeps recovery commands; tokenizer pinned with literal-recall round-trip test fixture; persistent status line semantics defined including headless behavior.
- `session-digest`: lifecycle no longer supports the `hybrid-raw` → `digest` upgrade transition; `reEvaluate` case (b) and `markAllDirtyAndClearEmbeddings` dependency are removed; fallback notify text moves out of `lifecycle.ts` (now owned by `startIndex`).
- `session-embedder`: legacy-bedrock-rejection scenario becomes verdict-dependent (rejected embedder + digest model = `misconfigured`, not `fts-raw`).

## Impact

**Affected code (rough LOC accounting)**:
- `src/index/mode.ts` — mode union narrows; `detectMode` rewritten to a binary verdict + misconfigured sentinel.
- `src/index/session-index.ts` — `sync()` simplifies (no hybrid-raw branch); `addDigested()` writes both FTS columns; `buildEmbeddingText` fallback removed.
- `src/index/fts-index.ts` — `hybrid-fts.db` schema gains `raw_content` column; `FtsSide.search` accepts BM25 column weights; `buildContent` mode parameter removed (the digest-hybrid path now writes two fields).
- `src/index.ts` — `startIndex` short-circuits on misconfigured verdict; slash-command registration moves behind the verdict check; persistent status line is set and never cleared.
- `src/digest/lifecycle.ts` — `reEvaluate` case (b) deleted; `markAllDirtyAndClearEmbeddings` dependency removed from `LifecycleDeps`; `installDigestLifecycle` only called when verdict is `digest-hybrid`.
- `src/embedder.ts` — no changes.
- `src/parser.ts` — no changes (raw concat helper continues to consume the same fields).

**Tests**:
- Delete `src/__tests__/raw-mode-regression.test.ts` (its `hybrid-raw` byte-equivalence assertion is now meaningless).
- Trim `src/__tests__/digest/mode-reeval.test.ts` to remove case-b coverage; add coverage for the misconfigured-verdict path.
- Add `src/__tests__/index/fts-columns.test.ts` to assert that `digest-hybrid` writes both columns and that BM25 weighting prefers digest hits.
- Add `src/__tests__/index/fts-tokenizer.test.ts` asserting that hard-literal queries (`ENOENT`, `0x80000003`, `gpt-5.4-nano`) round-trip through the tokenizer. Pins the FTS5 `tokenize` argument.
- Add `tests/fixtures/bm25-corpus/` with ~30 synthetic tuples and a math-constraint validator (per design D3 / tasks §8). The validator asserts the inequality `n_d × W_DIGEST > n_r × W_RAW` for comparative tuples using documented match counts — NOT NDCG / ranking assertions against actual BM25 output. A small parallel `bm25-smoke.test.ts` (~5 hand-written tuples) round-trips through real `FtsSide` to catch column-order mistakes.
- Add migration crash-recovery test: simulate kill -9 between FTS rebuild and JSON write; assert next load self-heals.

**Test count target**: 220 unit tests (212 baseline + ~11 new files − 3 deletions; see tasks 7.10 for breakdown). Scenario count: 20 (21 baseline − S21 delete; S02 repurposed in place with 5 sub-tests + continued-on-failure semantics).

**Scenarios**:
- `S02` repurposed: partial-config → misconfigured notify; search/digest tool invocations return remediation; recovery commands (`/session-embeddings-setup`, `/digest:settings`) work normally.
- `S21` deleted.
- `S03`–`S07` and any other digest scenarios: `digest-mode` literals replaced with `digest-hybrid`.

**Migration**:
- Existing v2.x users with `lastMode === "hybrid-raw"` AND a digest model now resolvable: index wiped on next load (digests preserved). Fresh embedding pass replays from existing digests at ~1 ollama call per digested session.
- Existing v2.x users with `lastMode === "hybrid-raw"` AND NO digest model resolvable (the hybrid-raw-only cohort): index wiped, verdict resolves to `misconfigured`. They see ONE coherent error notify (the misconfigured remediation message), NOT a stale "rebuilding from digests" message that promises something that won't happen. They can run `/session-embeddings-setup` or `/digest:settings` from inside pi to fix their config.
- Users on `lastMode === "digest-mode"`: `lastMode` migrated to `"digest-hybrid"`. Index format rewritten to v5 (adds `raw_content` FTS column); `hybrid-fts.db` rebuilt on next sync — no data loss because raw content is parsed fresh from JSONL.
- Users with `lastMode === undefined` AND `version === 4` (early v4 file before lastMode tracking): same wipe path as above (FTS schema changed); generic format-upgrade notify.

**Version bump**: v3.0.0 (breaking spec change + breaking on-disk index format + breaking mode-name rename).

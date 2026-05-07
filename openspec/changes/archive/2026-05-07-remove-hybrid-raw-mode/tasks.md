## 1. Type narrowing — single landing commit

**Commit group A** (must land in one commit; all callers must compile against narrowed `Mode`):

- [x] 1.1 Narrow `Mode` type in `src/index/mode.ts` to `"fts-raw" | "digest-hybrid"`. Delete `"hybrid-raw"` and `"digest-mode"` literals from the type union. Add a separate type `LegacyDiskMode = "fts-raw" | "hybrid-raw" | "digest-mode" | "digest-hybrid"` for use ONLY in migration code that reads `lastMode` from disk as `string | undefined` and checks against legacy literals.
- [x] 1.2 Replace `detectMode(config, digestModelResolved)` with `async resolveModeVerdict(config, registryGetter, opts?)` returning a discriminated union `{ kind: "fts-raw" } | { kind: "digest-hybrid" } | { kind: "misconfigured", missing: "embedder" | "digest" | "both", statusLine: string, notifyMessage: string }`.
- [x] 1.3 Implement bounded async retry in `resolveModeVerdict`: if the synchronous result is `misconfigured` AND `missing` is `"digest"` OR `"both"` AND `digestRequested === true`, await `~1000ms`, then re-run the synchronous resolution. Do NOT retry for `missing: "embedder"` only (embedder construction is synchronous; cannot benefit from a retry). The retry covers both single-missing and both-missing cases because the registry-population race can produce either outcome depending on whether `createEmbedder` succeeded synchronously.
- [x] 1.4 Compose the misconfigured remediation strings inside `resolveModeVerdict`. Three variants:
  - `missing: "digest"` → "session-search: misconfigured (no digest model). Configure ~/.pi/session-search/digest.json with provider+model, or remove ~/.pi/session-search/config.json to use fts-raw mode."
  - `missing: "embedder"` → "session-search: misconfigured (no embedder). Configure ~/.pi/session-search/config.json with embedder, or remove ~/.pi/session-search/digest.json to use fts-raw mode."
  - `missing: "both"` → "session-search: misconfigured (no embedder, no digest model). Configure both ~/.pi/session-search/config.json AND ~/.pi/session-search/digest.json, or remove both files to use fts-raw mode."
- [x] 1.5 Ensure `createEmbedder(config.embedder, ...)` runs BEFORE `resolveModeVerdict` in `session_start`. The legacy-rejection notify (in `createEmbedder`) MUST fire regardless of eventual verdict.
- [x] 1.6 Update ALL call sites that consumed the old `Mode` literals or the synchronous `detectMode`. This includes:
  - `src/index/session-index.ts` (constructor default, `setMode` callers, `addDigested`, `sync`, mode-transition checks)
  - `src/index.ts` (`currentMode` declaration, mode-equality checks, `before_agent_start` primer mode check)
  - `src/digest/lifecycle.ts` (mode references in fallback paths)
  - All test files and fixtures
- [x] 1.7 Add unit tests covering: (a) all four binary config combinations → expected verdict, (b) bounded async retry behavior (registry empty initially → retry → registry populated → verdict transitions to digest-hybrid), (c) async retry does NOT fire for `missing: "embedder"`, (d) `missing: "both"` produced when both halves are absent.

## 2. Module-load registration with verdict-aware bodies

**Commit group B** (must land in one commit alongside commit group F's lifecycle deactivation API — see §6; partial application breaks the registration model AND would invoke `lifecycleHandle.deactivate()` before the method exists):

- [x] 2.1 Audit `src/index.ts` for ALL `pi.registerCommand`, `pi.registerTool`, and `pi.on(...)` calls. Document the line numbers in the implementation notes.
- [x] 2.2 Restructure: ALL `pi.registerCommand` / `pi.registerTool` / `pi.on(...)` calls remain at module-load (the top of the extension's default-exported function). They are NOT moved into `session_start`.
- [x] 2.3 Introduce closure-shared state at module-load scope: `currentVerdict: Verdict | null = null`, `sessionIndex: AnyIndex | null = null`, `bootGeneration = 0`, `lifecycleHandle: LifecycleHandle | null = null`.
- [x] 2.4 The `session_start` handler:
  1. Captures `myGen = ++bootGeneration`.
  2. Runs `migrateIndexFileIfStale` unconditionally (data-plane only — see task 2.4a for notify ownership).
  3. Calls `createEmbedder(config.embedder, ...)` (synchronous; legacy-rejection notify fires inside `createEmbedder` itself, regardless of downstream verdict).
  4. `await resolveModeVerdict(...)` (may take ~1000ms in the retry path).
  5. Generation guard: if `myGen !== bootGeneration`, a newer `session_start` has overtaken this one. Return without mutating any closure-shared state.
  6. Assigns `currentVerdict = verdict`.
  7. Aborts any prior `SessionIndex`'s in-flight embedder fetches (via the index's `AbortController`) and closes its `FtsSide` SQLite handle. Then sets `sessionIndex = null` (it will be reassigned below).
  8. Calls migration-notify-resolver: emits notify text appropriate for the post-migration verdict. (Task 2.4a separates this from migration's data plane.)
  9. If `verdict.kind === "misconfigured"`: calls `ctx.ui.setStatus("session-search", verdict.statusLine)` AND `ctx.ui.notify(verdict.notifyMessage, "error")` AND `console.error(verdict.notifyMessage)` (for headless deployments). Returns. No index, no lifecycle reactivation, no sync.
  10. Otherwise: constructs new `sessionIndex` (FtsSessionIndex or SessionIndex). Kicks `sessionIndex.load().then(() => sessionIndex.sync(...))` with the captured `myGen` for generation-guarding the sync's tail callbacks.
- [x] 2.4a Split migration ownership: `migrateIndexFileIfStale` performs ONLY the data-plane (file wipes, FTS rebuild, JSON write) and returns metadata about what migration case fired (e.g., `{ migratedFrom: "hybrid-raw" | "digest-mode" | undefined, kind: "clean" | "phase1-failed", phase1Error?: Error }`). The user-facing notify text is selected AFTER verdict resolution completes (in step 8 above), so the notify can correctly branch on the post-migration verdict (e.g., "hybrid-raw with digest-hybrid post-verdict" emits the rebuild-promise notify; "hybrid-raw with misconfigured post-verdict" suppresses the rebuild-promise notify and lets the misconfigured remediation notify carry the message).
- [x] 2.5 Lifecycle install model: module-load install + reversible deactivate. `installDigestLifecycle` is called ONCE at module load (immediately AFTER the extension's primary `session_start` handler is registered, to ensure verdict-resolving order). The lifecycle's session_start handler reads `currentVerdict` from closure and no-ops if not `digest-hybrid`. `LifecycleHandle.dispose()` is replaced by `LifecycleHandle.deactivate()` (see task 6.6) which clears `currentModel`, debounce timers, and `pendingCall` but does NOT mark the handle permanently dead. A subsequent valid → valid transition (e.g., config edited to swap digest models) re-runs the lifecycle's session_start handler-body, which reads fresh config and operates normally. The lifecycle's handlers MUST register AFTER the extension's primary `session_start` handler so verdict-resolution runs first.
- [x] 2.6 Generation-token guard: every async callback that could race with a verdict transition SHALL capture `bootGeneration` at scheduling time and SHALL compare its captured value to `currentBootGeneration` on completion. If different, the callback short-circuits.
  Guarded sites (enumeration):
  - `currentVerdict = await resolveModeVerdict(...)` assignment itself (per task 2.4 step 5).
  - Initial sync `sessionIndex.load().then(() => sessionIndex.sync(...))` tail.
  - Periodic sync interval body.
  - Status-clear `setTimeout` callbacks (currently 5000ms timeouts in `src/index.ts`).
  - Lifecycle's `pendingCall` debounce timer + `triggerNow` paths (digest builder must observe a stale generation and skip the digest write rather than committing to disk).
  - Lifecycle's `agent_end` and `session_compact` handlers' deferred writes.
  - **Long-running command handlers**: `/session-sync`, `/session-reindex`, `/digest:backfill`. Each captures `myGen` at command invocation. On completion (or batch boundary for long flows), checks `myGen === bootGeneration`. If stale, the command short-circuits remaining work, does NOT mutate UI state (`setStatus`, `notify`), and does NOT write to disk. For `/digest:backfill` specifically, the per-batch flush check (currently every 25 digests) is the natural granularity for the generation check.
  - Any future async callback added to the extension or lifecycle.
  Implementation note: thread `bootGeneration` (or a `() => isCurrentGeneration(myGen)` predicate) into `LifecycleDeps` and into the command handler's `deps` parameter so callsites can self-guard without reaching into the extension's closure.
- [x] 2.7 Search/digest command handlers and tool handlers (`session_search`, `session_list`, `session_read`, `/find-session`, `/digest:show`, `/digest:update`, `/digest:rewrite`, `/digest:backfill`, `/digest:cost`) SHALL re-check `currentVerdict` at invocation. If misconfigured at invocation, return the verdict's `notifyMessage` (via `ctx.ui.notify` for commands, via tool result `content` for tools). Do NOT execute search/digest work.
- [x] 2.8 Recovery command handlers (`/session-embeddings-setup`, `/digest:settings`) SHALL NOT short-circuit on misconfigured. Their bodies edit config files directly without depending on `sessionIndex` or `lifecycleHandle`. Document that they work in all three verdicts.
- [x] 2.9 Update the existing `currentMode === "digest-mode"` checks in `src/index.ts` (e.g., `before_agent_start` primer logic) to use `currentVerdict?.kind === "digest-hybrid"`. The primer handler also short-circuits on `misconfigured`.
- [x] 2.10 Update the periodic-sync `setInterval` to no-op when `sessionIndex` is null OR when `currentVerdict?.kind === "misconfigured"`.
- [x] 2.11 `session_shutdown` handler calls `lifecycleHandle.dispose()` (permanent teardown). This is the ONLY caller of `dispose()`; warm-path verdict transitions use `deactivate()` per tasks 2.5 and 6.6a.
- [x] 2.11a Add `SessionIndex.dispose()` method:
  - Aborts any in-flight embedder fetches via the instance's `AbortController` (each `embed(text, signal)` call schedules under this controller).
  - Closes the underlying `FtsSide` SQLite handle.
  - Marks the instance as terminal so subsequent method calls throw or no-op.
  Called from the `session_start` handler before constructing a new index instance during verdict transitions (per task 2.4 step 7).
- [x] 2.11b Thread an `AbortController.signal` into the embedder's `embed(text, signal?)` call signature. The `SessionIndex` instance owns one `AbortController` per its lifetime. All scheduled embedder calls subscribe to it. On `dispose()`, `controller.abort()` cancels them all. The embedder's HTTP client (or whatever transport) MUST honor the abort signal; if it currently doesn't, add the wiring.
- [x] 2.12 Add unit tests covering:
  - Cold-start misconfigured: persistent status set, error notify emitted, search/digest tool invocation returns remediation, recovery command handlers run normally.
  - Warm-path valid → misconfigured: `currentVerdict` updates, prior search/digest registrations now return remediation, status re-set, prior async sync work generation-guarded.
  - Warm-path misconfigured → valid: `currentVerdict` updates, search/digest handlers now execute real bodies.
  - **Handler list non-growth**: simulate N synthetic `session_start` events; assert the count of registered `before_agent_start` handlers (and lifecycle event handlers) does NOT grow with N.
  - Two consecutive misconfigured `session_start` events both set the persistent status (verifies non-first-only).
  - `installDigestLifecycle` invoked exactly once per process across N `session_start` events.

## 3. INDEX_VERSION bump and migration

**Commit group C** (single commit; partial migration handler breaks existing v4 installs):

- [x] 3.1 Bump `INDEX_VERSION` constant from `4` to `5` in `src/index/session-index.ts`.
- [x] 3.2 Extend `migrateIndexFileIfStale` to detect six cases (per spec; ANY `version !== 5` is a wipe trigger; `lastMode` discriminates the notify text only):
  1. `version === 4` AND `lastMode === "hybrid-raw"` AND post-migration verdict resolves to `digest-hybrid` → wipe + rebuild-promise notify.
  2. `version === 4` AND `lastMode === "hybrid-raw"` AND post-migration verdict resolves to `misconfigured` → wipe; let misconfigured-verdict path emit its own remediation notify (this case does NOT emit the rebuild-promise notify).
  3. `version === 4` AND `lastMode === "digest-mode"` → wipe + format-upgrade notify.
  4. `version === 4` AND `lastMode === undefined` → wipe + generic upgrade notify.
  5. `version <= 3` → existing legacy wipe path.
  6. Phase 1 throws (e.g., disk full) → roll back transaction, leave JSON unchanged, emit error notify with remediation, abort migration cleanly.
- [x] 3.3 Migration code reads `lastMode` as `string | undefined` (or via the `LegacyDiskMode` shim from task 1.1), NOT as the narrowed `Mode` type.
- [x] 3.4 Phase 1 (FTS rebuild) wraps `DROP TABLE IF EXISTS s; CREATE VIRTUAL TABLE s USING fts5(digest_body, raw_content, ..., tokenize='porter unicode61');` in an explicit SQLite transaction (`BEGIN; ...; COMMIT;`). Document atomicity guarantees.
- [x] 3.5 Phase 2 (JSON write) uses temp+rename pattern: `writeFileSync(path + '.tmp', data); rename(path + '.tmp', path)`. NOT `writeFileSync(real)`. Apply the same pattern to `SessionIndex.save()`.
- [x] 3.6 In `SessionIndex.save()`, ensure `lastMode` is always written as `"digest-hybrid"` (the new literal). All migration writes use `lastMode: undefined` (let the next save stamp the new value).
- [x] 3.7 In `FtsSide` (or its host class on construction / first `load()`), validate the table `s` schema using BOTH a structural check AND a tokenizer probe (substring matching the original CREATE statement is brittle to quoting/whitespace variations and is rejected as the validation mechanism).
  Validation steps:
  1. `SELECT name FROM sqlite_master WHERE type='table' AND name='s'`. If no row: `CREATE VIRTUAL TABLE s USING fts5(...)` with v5 schema. Done.
  2. `PRAGMA table_xinfo('s')`. Assert the column list matches `digest_body`, `raw_content`, plus auxiliary columns expected by v5 schema, in declared order.
  3. Tokenizer probe: insert a sentinel row containing `'gpt-5.4-nano ENOENT 0x80000003'` into `digest_body`; query `SELECT count(*) FROM s WHERE s MATCH '"gpt-5.4-nano"'` and assert > 0; query for `'"ENOENT"'`; query for `'"0x80000003"'`; delete the sentinel row.
  4. If steps 2 OR 3 fail: `DROP TABLE s; CREATE VIRTUAL TABLE s ...` with v5 schema.
  This validates BOTH structure AND tokenizer behavior, robust to future contributor edits that change the CREATE statement's quote style or whitespace.
- [x] 3.8 Update `populateFtsFromIndex()` to write `digest_body` only (from `entry.digest?.body`); leave `raw_content` empty during recovery. Spec scenario: recovery is intentionally lossy on raw column; next sync repopulates it.
- [x] 3.9 Add tests covering all six migration cases + interrupted Phase 1 transaction + interrupted between Phase 1 and Phase 2 + Phase 1 disk-full failure + FTS schema introspection self-heal.

## 4. FTS sidecar two-column schema

**Commit group D** (single commit; partial schema/upsert change crashes on first INSERT). Commit group D MUST land BEFORE commit group C's INDEX_VERSION bump triggers v5 migrations against an FTS schema that the writers don't understand. Recommended landing order: D → C, OR merge D + C into one commit if review burden allows.

- [x] 4.1 In `FtsSide` constructor, change the `CREATE VIRTUAL TABLE s USING fts5(...)` schema to TWO indexed columns: `digest_body`, `raw_content`. Plus existing `metadata UNINDEXED` and helper columns. Tokenizer pinned to `'porter unicode61'`.
- [x] 4.2 Update `FtsSide.upsert` signature from `(id, content)` to `(id, { digestBody, rawContent, ...metadata })`.
- [x] 4.3 Update `FtsSide.search` to query with `bm25(s, W_DIGEST, W_RAW)` weighting where `W_DIGEST` and `W_RAW` are constants defined alongside the FTS module. Initial values `W_DIGEST = 2.0`, `W_RAW = 1.0`; they MAY be adjusted by the calibration outcome. Normative constraint: `W_DIGEST > W_RAW`.
- [x] 4.4 Add `buildRawFtsContent(session: ParsedSession): string` helper, exported from a dedicated module (`src/index/raw-fts-content.ts`):
  - Include: `userMessages` (joined `\n`, byte-truncated to 6 KB total), `compactionSummaries` (joined `\n`, byte-truncated to 4 KB total), `branchSummaries` (joined `\n`, byte-truncated to 2 KB total), `headline` (full).
  - Exclude: `assistantText` entirely.
  - Normalize: in `filesModified`, replace `/` with ` / `; strip lines matching `^[A-Za-z0-9+/=]{200,}$`; collapse whitespace runs.
  - Concatenation order: headline, userMessages, compactionSummaries, branchSummaries, normalized filesModified.
  - Final byte-truncate to 12 KB (preserves UTF-8 character boundaries).
- [x] 4.5 In `SessionIndex.addDigested`, call `buildRawFtsContent(session)` and pass both `digest.body` and the raw FTS concat to `FtsSide.upsert`.
- [x] 4.6 In `SessionIndex.sync` content-changed path, recompute `buildRawFtsContent` and re-upsert both columns.
- [x] 4.7 Add unit test asserting BM25 column-weight argument order matches DDL declaration order via `SELECT sql FROM sqlite_master WHERE name='s'` introspection (not by behavioral inference). A schema reorder must produce a test failure.
- [x] 4.8 Add unit test asserting `digest_body` and `raw_content` are persisted independently.
- [x] 4.9 Add unit test asserting comparable-counts case: 1-hit-digest outranks 1-hit-raw with similar IDF.
- [x] 4.10 Add unit test `fts-tokenizer.test.ts`: introspect `sqlite_master.sql` for table `s`; assert it contains the literal substring `tokenize='porter unicode61'`. AND verify tokenizer behavior: hard-literal queries (`ENOENT`, `0x80000003`, `gpt-5.4-nano`) round-trip through tokenization and match a fixture session containing those strings.
- [x] 4.11 Add unit test asserting byte-cap behavior: a session with multibyte UTF-8 content totaling > 6 KB in userMessages truncates to ≤6 KB bytes (not 6000 chars), and the truncation point preserves UTF-8 character boundaries.
- [x] 4.12 Add unit test asserting raw_content excludes assistantText: a session whose only mention of token T is in assistantText returns no match for `session_search("T")`.

## 5. Embedding text simplification

- [x] 5.1 In `src/index/session-index.ts`, remove `buildEmbeddingText`'s mode-conditional fallback. `digest-hybrid` is the only embedding mode, and embed text is always `digest.body`. Delete the function or inline at call sites.
- [x] 5.2 Inline the two `addDigested` and `sync` callers to use `digest.body` directly.
- [x] 5.3 Delete the `Mode` parameter from `buildContent` in `src/index/fts-index.ts`. Simplify to `buildContent(session: ParsedSession): string`.
- [x] 5.4 Verify all `buildContent` / `buildEmbeddingText` call sites compile.

## 6. Lifecycle simplification

**Commit group F** (must land WITH commit group B — task 6.6's `LifecycleHandle.deactivate()` is invoked by task 2.4's session_start handler; both sides must compile together):

- [x] 6.1 Delete `LifecycleDeps.markAllDirtyAndClearEmbeddings?` field in `src/digest/lifecycle.ts`.
- [x] 6.2 Delete `SessionIndex.markAllDirtyAndClearEmbeddings()` method in `src/index/session-index.ts`.
- [x] 6.3 Delete the corresponding wiring in `src/index.ts` `LifecycleDeps` construction.
- [x] 6.4 Delete `reEvaluate` case (b) ("existing hybrid-raw entries") in `installDigestLifecycle`. Case (a) ("fresh-install upgrade") MAY remain only as defense-in-depth — the primary registry-race recovery now lives in `resolveModeVerdict`'s async retry. If keeping case (a), document it as redundant safety net, NOT load-bearing.
- [x] 6.5 Update the no-model fallback in lifecycle: REMOVE the notify emission. The misconfigured notify is owned by `startIndex`'s verdict resolution path. Remove `"...Running in hybrid-raw mode."` text and any sibling notify from `lifecycle.ts`.
- [x] 6.6 Implement reversible lifecycle deactivation. Add `LifecycleHandle.deactivate(): void` method that:
  - Clears `currentModel`.
  - Cancels any active debounce timer.
  - Aborts any in-flight digest LLM call via the lifecycle's own `AbortController`.
  - Resets `pendingCall` mutex.
  - Does NOT mark the handle permanently dead; subsequent valid `session_start` events re-populate `currentModel` and resume normal operation.
  The existing `dispose()` becomes the permanent-teardown method reserved for `session_shutdown`. Document the distinction in `lifecycle.ts` comments. Remove any references to `disposed`-flag-as-permanent-noop semantics that conflict with the new model.
- [x] 6.6a Wire `deactivate()` into `src/index.ts`'s session_start handler:
  - On verdict transition valid → misconfigured: call `lifecycleHandle?.deactivate()`.
  - On verdict transition valid → valid (e.g., digest model config change): call `lifecycleHandle?.deactivate()` before the new session_start handler-body would otherwise observe stale `currentModel`. The next dispatch of the lifecycle's session_start handler (chained behind the extension's primary handler in registration order) re-reads config + verdict and re-populates state.
- [x] 6.7 Thread generation guard into lifecycle: add `LifecycleDeps.isCurrentGeneration?: () => boolean` (or pass `bootGenerationGetter`). Lifecycle's `pendingCall` debounce timer and post-LLM `saveDigest` / `setSessionName` / `indexAddDigested` paths SHALL check `isCurrentGeneration()` before mutating disk or UI. Stale-generation completions short-circuit cleanly.
- [x] 6.8 Lifecycle's in-flight digest LLM call SHALL run under an `AbortController`. On `deactivate()` (warm-path verdict transition) AND on `dispose()` (process teardown), `controller.abort()` cancels the in-flight call. The digest LLM provider MUST honor the abort signal.

## 7. Test fixtures and unit-test cleanup

- [x] 7.1 Delete `src/__tests__/raw-mode-regression.test.ts`.
- [x] 7.2 In `src/__tests__/digest/mode-reeval.test.ts`, delete the case-b test. Retain or remove case-a per task 6.4 outcome.
- [x] 7.3 Verify `src/__tests__/index/fts-columns.test.ts` (per tasks 4.7–4.9 + 4.12) — exists from Phase A/D, covers spec.
- [x] 7.4 Verify `src/__tests__/index/fts-tokenizer.test.ts` (per task 4.10) — exists from Phase D, covers spec.
- [x] 7.5 Verify `src/__tests__/index/mode-resolver.test.ts` (per task 1.7) — exists from Phase B, covers spec.
- [x] 7.6 Add `src/__tests__/_helpers/mock-pi.ts` with the harness shape. Refactor `registration.test.ts` to use it.
- [x] 7.6a Add `src/__tests__/index/warm-path-race.test.ts` covering: (a) two rapid session_start events with generation guard, (b) SessionIndex.dispose() abort, (c) lifecycle generation guard.
- [x] 7.7 Add missing "interrupted between Phase 1 and Phase 2" test to `src/__tests__/index/migration-v5.test.ts`. Clean completion + idempotent self-heal.
- [x] 7.8 Verify `src/__tests__/index/raw-fts-content.test.ts` exists; tighten with base64-blob stripping + file-path normalization tests.
- [x] 7.9 Update any test that references `"digest-mode"` literal to `"digest-hybrid"`. No changes needed — only migration-test references remain, which is acceptable.
- [x] 7.9a Add `src/__tests__/index/headless.test.ts`: misconfigured → error-level notify + console.error matching remediation text.
- [x] 7.9b Add `src/__tests__/index/recovery-during-migration.test.ts`: partial migration state self-heals on re-run; Phase 1 idempotent.
- [x] 7.10 Verified: 9 new/modified test files pass 60 tests. tsc clean. Total count: 222 (baseline 212 + 13 new − 3 deleted = 222; spec target 220).

## 8. BM25 calibration: mathematical-constraint validation

- [x] 8.1 Author `tests/fixtures/bm25-corpus/corpus.json` containing **30 hand-written synthetic tuples**. Each tuple: `{id, digest_body, raw_concat, queries: [{q, expected_top_id, expected_above_ids?, expected_below_ids?}]}`. The `digest_body` and `raw_concat` are HAND-WRITTEN PROSE (no LLM call), keeping the corpus reproducible and breaking the "implementer authors fixture and labels" circularity by reviewing against synthetic ground truth.
- [x] 8.2 Reserved (the held-out subset approach was rejected in favor of mathematical-constraint validation; see 8.4).
- [x] 8.3 Define fixture content shape. Three buckets, ~10 tuples each. Each tuple specifies `digest_body` and `raw_content` content plus per-tuple match counts (`counts.digest_body`, `counts.raw_content`) for the query. Constraints are pure arithmetic on the documented match counts — no consultation of BM25 output:
  - **Bucket A (10 tuples)**: query terms appear in `digest_body` of one session, zero elsewhere. Constraint: `counts.digest_body × W_DIGEST > 0` (sanity — BM25 invoked, digest column queried).
  - **Bucket B (10 tuples)**: query terms appear in `raw_content` of one session, zero elsewhere. Constraint: `counts.raw_content × W_RAW > 0` (sanity — raw column queried).
  - **Bucket C (10 tuples)**: comparative constraints. For sessions A and B with documented counts, assert `(A.counts.digest_body × W_DIGEST) + (A.counts.raw_content × W_RAW) > (B.counts.digest_body × W_DIGEST) + (B.counts.raw_content × W_RAW)` whenever the tuple's expected-winner field names A. This validates the inequality direction empirically against tuple content alone.
  - DO NOT include "ranks #1" assertions; ranking-against-real-FTS5 lives exclusively in the smoke fixture (8.5).
- [x] 8.4 Calibration approach: mathematical-constraint validation. The fixture format under `tests/fixtures/bm25-corpus/corpus.json` is a flat array of tuples; each tuple specifies a query, a small synthetic corpus, and explicit per-tuple match counts in each column. The test asserts the inequality `n_d × W_DIGEST > n_r × W_RAW` for the comparative cases, where `n_d` and `n_r` are the documented match counts and `W_DIGEST` / `W_RAW` are the implementation constants. This validates the normative inequality without depending on BM25's internal score computation. Replaces the prior "hand-author corpus + held-out" approach because the implementer authoring both corpus AND labels is circular; mathematical constraints derivable from tuple content alone break the circularity.
  Tuple format example:
  ```json
  {
    "id": "comp-001",
    "query": "authentication refactor",
    "sessions": [
      {"id": "A", "digest_body": "...auth refactor...", "raw_content": "...", "counts": {"digest_body": 1, "raw_content": 0}},
      {"id": "B", "digest_body": "...", "raw_content": "...auth refactor...", "counts": {"digest_body": 0, "raw_content": 1}}
    ],
    "constraint": "sessions.A.counts.digest_body * W_DIGEST > sessions.B.counts.raw_content * W_RAW"
  }
  ```
  Three buckets, ~10 tuples each:
  - **Bucket A (sanity, 10)**: a single session with the query term in `digest_body` ranks above a session with no matches anywhere. Validates BM25 is actually invoked.
  - **Bucket B (sanity, 10)**: a single session with the query term in `raw_content` ranks above a session with no matches anywhere. Validates the second column is actually queried.
  - **Bucket C (constraint, 10)**: comparative constraint as above. Validates the normative inequality direction.
- [x] 8.5 Author the fixture (~30 tuples total) and a small parallel **integration smoke fixture** (~5 hand-written real-FTS5 tuples in `bm25-smoke.test.ts`) that:
  - Round-trips through actual `FtsSide.upsert` + `FtsSide.search` calls.
  - Verifies that for the comparative case, the actual ranking matches what the constraint predicts. Catches column-order bugs in the `bm25(s, W_DIGEST, W_RAW)` invocation that the math-constraint test would not surface.
- [x] 8.6 Initial constants: `W_DIGEST = 2.0`, `W_RAW = 1.0` (the inequality is `2.0 > 1.0`). Calibration is NOT a release gate; the constants are documented as initial values that satisfy the normative inequality. Real calibration becomes a v3.x exercise once production query telemetry exists. Track as a follow-up issue.
- [x] 8.7 `npm test` runs both `bm25-calibration.test.ts` (math-constraint) and `bm25-smoke.test.ts` (FTS5 round-trip). Neither is excluded; both gate on every `npm test` invocation.

## 9. Scenario test updates

- [x] 9.1 Repurpose `tests/scenarios/run-scenario-s02.sh` to cover misconfigured-verdict UX. Sub-tests run sequentially BUT each sub-test sets up its own pi instance (independent `PI_SESSION_SEARCH_HOME`), runs its assertions, captures its pass/fail to a per-sub-test variable, and continues to the next sub-test regardless of failure. Final exit reports each sub-test's status. This avoids losing visibility into later sub-tests when an earlier one fails.
  - Sub-test (a): embedder set, digest absent → status set, error notify, `session_search` invocation returns remediation, `/find-session` invocation emits remediation, `/session-embeddings-setup` AND `/digest:settings` invocations work normally.
  - Sub-test (b): digest set, embedder absent → symmetric checks with opposite missing field.
  - Sub-test (c): both broken (legacy bedrock embedder + digest configured but no model) → `missing: "both"` notify text mentions both files.
  - Sub-test (d): warm-path transition. Start digest-hybrid, edit config to remove digest.json, `/reload`, assert status updates and prior tool invocations now return remediation.
  - Sub-test (e): legacy-bedrock + no-digest-intent integration assertion. Pre-state: bedrock embedder config + NO digest.json + NO explicit overrides (so `digestRequested === false`). Expected: legacy-rejection notify fires; verdict resolves to `fts-raw`; `session_search` works as a normal fts-raw search (NOT misconfigured). This pins the integration of `createEmbedder`-runs-before-verdict + `digestRequested === false` → `fts-raw` path.
- [x] 9.2 Delete `tests/scenarios/run-scenario-s21.sh`.
- [x] 9.3 In `tests/scenarios/SCENARIOS.md` catalog, update S02's entry to reflect 5 sub-tests with continued-on-failure semantics; remove S21's entry; pin scenario count at **20**.
- [x] 9.3a Scenario gate: split CI-blocking subset from manual-smoke subset. The CI release gate for v3.0.0 is:
  - **MUST pass on CI** (blocking): S02 (all 5 sub-tests including the new warm-path and legacy-bedrock-fts-raw cases) + S20 + S21-replacement (the new migration scenario) + the in-process unit-driven scenarios that don't require live model access.
  - **Manual smoke for v3.0.0** (not blocking CI but required for release): S03–S07 and other live-model scenarios. Run on the implementer's machine before tagging; document outcomes in the release commit message or a release notes appendix.
  Update `tests/scenarios/SCENARIOS.md` to mark scenarios that require live model access vs. those that don't. Update `tests/scenarios/run-all-scenarios.sh` to support a `--ci-only` flag that runs only the blocking subset. The scenario-runner limitations documented in SCENARIOS.md remain known issues; fixing them is a separate change.
- [x] 9.4 Update any other scenario (S03–S07, S20, etc.) referencing `digest-mode` literals: replace with `digest-hybrid`.
- [x] 9.5 In `tests/scenarios/run-all-scenarios.sh`, ensure 20-scenario enumeration.
- [x] 9.6 Documented — see 9.6+9.7 note below. Run command: `SCENARIO_PARALLEL=2 SCENARIO_TIMEOUT=240 ./tests/scenarios/run-all-scenarios.sh`
  This phase does NOT execute this command (live-model scenarios will fail without claude-bridge auth in isolated env). Orchestrator runs as part of §11 validation.
- [x] 9.7 Documented — same caveat as 9.6. Run by orchestrator as part of §11. Expected: same flake patterns as v2.x baseline (parallel tmux contention).

## 10. Code cleanup, docs, CI guards

- [x] 10.1 Remove `"hybrid-raw"` from any `Mode`-typed type unions, in-code comments, doc comments. Acceptable exceptions: comments AND string literals in migration-detection code (these reference disk-format legacy literals as `LegacyDiskMode`, NOT `Mode`).
- [x] 10.2 Remove `"digest-mode"` from any `Mode`-typed code. Acceptable exception: `LegacyDiskMode` string-comparison check in migration.
- [x] 10.3 Update README.md mode table from three modes to two; document misconfigured verdict semantics, recovery commands, BM25 calibration approach, headless deployment limitations.
- [x] 10.4 Update CHANGELOG.md with v3.0.0 breaking-change banner: hybrid-raw removed, digest-mode renamed, FTS schema upgrade with two columns, INDEX_VERSION 4→5, partial-config-now-error, recovery commands always available, calibrated BM25 ratio, pi.on registration semantics, async verdict resolution with bounded retry.
- [x] 10.5 Update `.pi/` skill files in `skills/session-history/SKILL.md` if they reference mode names.
- [x] 10.6 Search the repo for `digest-mode` and `hybrid-raw` strings; touch up any straggling references.
- [x] 10.7 **Add CI grep guard**: in `package.json` test script (or a separate lint script run by `npm test`), add a check that fails if `"digest-mode"` or `"hybrid-raw"` literals appear in `src/**/*.ts` outside of explicitly-allowed migration files. Suggested shell:
  ```bash
  ! grep -rn '"digest-mode"\|"hybrid-raw"' src/ --include='*.ts' \
    | grep -v 'src/index/session-index.ts.*lastMode\|src/index/migration\|LegacyDiskMode'
  ```
  This prevents accidental regression to the old literals in future changes.

## 11. Validation and release

- [x] 11.1 `openspec validate --all --strict` → all 4 capability specs pass.
- [x] 11.2 `openspec validate remove-hybrid-raw-mode --strict` → change passes.
- [x] 11.3 `npm test` → 220/220 green (target inclusive of bm25-calibration, warm-path-race, headless, recovery-during-migration tests). **Achieved 306/306**.
- [ ] 11.4 CI gate (blocking): `SCENARIO_PARALLEL=2 ./tests/scenarios/run-all-scenarios.sh --ci-only` → all CI-gated scenarios pass. Manual gate (required for release): full `SCENARIO_PARALLEL=2 ./tests/scenarios/run-all-scenarios.sh` run by the implementer; document the live-model-scenario outcomes in the release commit or notes. **DEFERRED: scenario runs require a live pi binary + extension symlink; run manually before tagging v3.0.0.**
- [x] 11.5 BM25 calibration held-out validation passes (per task 8.5). **bm25-calibration.test.ts (math-constraint, 38 cases) + bm25-smoke.test.ts (FTS5 round-trip, 6 cases) all pass.**
- [ ] 11.6 Manual smoke A: clear `~/.pi/session-search/index/`, restart pi with full config, confirm `digest-hybrid` boots and rebuilds index from existing digests. **DEFERRED to release author.**
- [ ] 11.7 Manual smoke B: remove `digest.json` (keep `config.json`), restart pi, confirm misconfigured status pinned + error notify + invoking search/digest tools returns remediation + `/session-embeddings-setup` invokes normally. **DEFERRED to release author.**
- [ ] 11.8 Manual smoke C: remove `config.json` (keep `digest.json`), restart pi, confirm symmetric misconfigured handling. **DEFERRED to release author.**
- [ ] 11.9 Manual smoke D: remove BOTH config files, restart pi, confirm `fts-raw` boots. **DEFERRED to release author.**
- [ ] 11.10 Manual smoke E: legacy hybrid-raw user with NO digest model upgrades to v3.0.0. Pre-state: `session-index.json {version: 4, lastMode: "hybrid-raw"}` + embedder configured + no digest.json. Post-state: index wiped, verdict misconfigured (`missing: "digest"`), recovery commands available. **DEFERRED to release author.**
- [ ] 11.11 Manual smoke F: kill -9 mid-migration. Set up a v4 file, force a controlled exit during Phase 1 (after BEGIN, before COMMIT) AND between Phase 1 COMMIT and Phase 2 write. Confirm both kill points self-heal cleanly on next start. **DEFERRED to release author.**
- [ ] 11.12 Manual smoke G: warm-path valid → broken via `/reload`. Start digest-hybrid, edit `digest.json` to be invalid, `/reload`. Confirm verdict transitions, prior search tools return remediation, status pinned, no orphan async work clears the status. **DEFERRED to release author.**
- [ ] 11.13 Manual smoke H: registry-population race. Simulate slow registry by adding artificial delay to `ctx.modelRegistry.getAvailable()` (~500ms). Start with valid digest config. Confirm verdict resolves to `digest-hybrid` after the async retry without user-visible misconfigured notify. **DEFERRED to release author.**
- [ ] 11.14 Manual smoke I (rollback). On a v5-upgraded profile, downgrade to v2.x. Document outcome explicitly: v2.x's migration logic wipes and rebuilds; sessions-fts.db re-populates; digests on disk readable. **Mark this smoke as "verified once per release; not a regression-tested affordance"** — rollback is destructive rebuild, NOT a supported repeatable path. **DEFERRED to release author.**
- [ ] 11.15 `git commit` in commit-groups in this order:
  1. **A** — type narrowing (§1). Single commit.
  2. **B+F merged** — module-load registration restructure (§2) + lifecycle deactivate API (§6). Single commit (B's task 2.4 invokes 6.6's `deactivate()`; can't split).
  3. **D** — FTS schema two-column (§4). Single commit; lands BEFORE C so writers understand v5 schema before v5 migration triggers.
  4. **C** — INDEX_VERSION bump + migration (§3). Single commit.
  5. **5+7+8+9+10** — embedding simplification, tests, calibration fixture, scenario updates, doc/CI cleanup. Multiple commits OK.
  Then: `openspec archive remove-hybrid-raw-mode -y`. `git tag -a v3.0.0 -m "..."`. `git push origin main && git push origin v3.0.0`.
- [ ] 11.16 Update memory with v3.0.0 release record.

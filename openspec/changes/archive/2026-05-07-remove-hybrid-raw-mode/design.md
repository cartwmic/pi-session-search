## Context

`pi-session-search` v2.0.0 introduced digest-driven indexing as an alternative to upstream's raw-content embedder, while preserving the upstream behavior as `hybrid-raw` mode for users who configured an embedder but no digest model. In production we observe two friction points:

1. **`hybrid-raw` is a strict downgrade of `digest-mode`.** It exists only because mode resolution wanted a graceful path when the user had an embedder but no digest model. The justification (cost / model availability) is now weak — Claude Haiku digest cost is ~$0.005–0.01 per session, and `claude-bridge` makes Anthropic models trivially available.
2. **`digest-mode` FTS recall is poor for literal terms.** The digest body is curated prose; the LLM may not preserve specific identifiers, error messages, or file paths. Users searching `/find-session "ENOENT 0x80000003"` get nothing because the digest summarized that as "build failed". Hybrid-raw users had this lexical signal (the raw text was in FTS); digest-mode users lost it.

The current state has both pathologies because the mode matrix tries to support every configuration combination as a viable mode. Collapsing the matrix to two well-supported modes (no embedder OR everything) and adding a second FTS column to digest-hybrid resolves both at once.

`add-digest-driven-indexing` already established the conventions this change builds on: `INDEX_VERSION` migrations via `migrateIndexFileIfStale`, `lastMode` field for transition detection, `setMode` on `SessionIndex`, and lifecycle re-evaluation on `session_start` (case (a) for fresh installs survives; case (b) for hybrid-raw upgrades is removed).

## Goals / Non-Goals

**Goals:**
- Reduce the mode matrix from 3 modes to 2 modes (`fts-raw`, `digest-hybrid`).
- Make partial configuration a hard error instead of a silent demotion. The user MUST configure both halves OR neither; ambiguous middle states fail loudly.
- Restore literal-text recall in digest-hybrid by writing both digest body AND raw concat into FTS as separate weighted columns.
- Auto-migrate existing v2.x users (`lastMode: "hybrid-raw"` or `"digest-mode"`) on next load with no manual intervention required, preserving expensive LLM artifacts (digests) where possible.
- Cut net code complexity: lifecycle `reEvaluate` simplifies, `buildEmbeddingText` simplifies, `markAllDirtyAndClearEmbeddings` is deleted.

**Non-Goals:**
- Adding new search modes or strategies beyond fts-raw and digest-hybrid.
- Changing the embedder API surface (still openai-compatible, single class).
- Changing the digest schema or builder pipeline.
- Adding configurable BM25 column weights as user-tunable config in v3.0.0 (defaults are hardcoded `2.0 / 1.0`; tunability can come in a follow-up if desired).
- Soft / opt-in migration. The wipe is automatic and unambiguous.
- Backwards compatibility with v2.x `lastMode === "hybrid-raw"` semantics. Once on v3.0.0, that value triggers a migration.

## Decisions

### D1. Mode literal renamed `digest-mode` → `digest-hybrid`

**Decision**: Rename the on-disk and in-code literal from `"digest-mode"` to `"digest-hybrid"`.

**Rationale**: `digest-mode` describes only the embedding source. `digest-hybrid` correctly conveys that this mode fuses semantic (cosine over digest) with lexical (BM25 over digest + raw) — accurate after the FTS schema upgrade. The rename is cheap to bundle with the breaking version bump v3.0.0; doing it later would force another breaking change.

**Alternatives considered**:
- Keep `digest-mode`. Cheaper churn, but the name is misleading after we add the raw FTS column.
- `fts-digest-hybrid`. More precise but unwieldy; users reading status output would prefer the shorter form.
- `hybrid`. Too generic — collides with the meaning of "hybrid-raw" in users' memory.

### D2. Mode resolution is binary; partial config is a misconfigured sentinel; module-load registration with verdict-aware bodies

**Decision**: Mode resolution returns one of three verdicts: `{ kind: "fts-raw" }`, `{ kind: "digest-hybrid" }`, or `{ kind: "misconfigured", missing: "embedder" | "digest" | "both" }`. The misconfigured verdict is NOT a Mode — Mode is only `"fts-raw" | "digest-hybrid"`. **`missing: "both"`** covers the rare case where both halves are absent yet `digestRequested === true` AND embedder config is present-but-rejected (e.g., legacy bedrock fall-through into a digest-intent state); this avoids the prior single-field ambiguity.

**Verdict resolution is async with one bounded retry.** `ctx.modelRegistry.getAvailable()` populates asynchronously after the first `session_start`. To preserve the prior `reEvaluate` case (a) registry-race recovery without re-introducing the lifecycle-only re-evaluation path:

```ts
async function resolveModeVerdict(config, registryGetter, retryDelayMs = 1000): Promise<Verdict> {
  let v = computeVerdictSync(config, registryGetter());
  if (v.kind !== "misconfigured" || v.missing !== "digest") return v;
  if (!digestRequested(config)) return v;     // user didn't ask for digests; accept verdict as-is
  await delay(retryDelayMs);                  // registry may finish populating
  return computeVerdictSync(config, registryGetter());
}
```

Cost: ~1 s on first session_start where the user has digest config but the registry isn't ready yet. This is exactly the case the deleted `reEvaluate` case (a) handled.

**Registration model: ALL `pi.on(...)` hooks AND all `pi.registerCommand` / `pi.registerTool` calls run at module load**, NOT inside `session_start`. This is mandatory because pi-coding-agent's `pi.on(event, handler)` uses *append* semantics (verified at `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/loader.js`: `list.push(handler)`); there is NO unregister API, NO `off()`. Registering hooks per-`session_start` would leak handlers indefinitely across `/reload` cycles.

**Module-load registration shape** (replaces the prior `registerForVerdict(...)`-from-`session_start` design):

```ts
export default function (pi: ExtensionAPI) {
  let currentVerdict: Verdict | null = null;
  let sessionIndex: AnyIndex | null = null;
  let bootGeneration = 0;          // increments on every session_start; used to ignore stale async
  let lifecycleHandle: LifecycleHandle | null = null;

  // ── ALL hooks and registrations at module load (fired once per process) ──
  pi.on("before_agent_start", async (event, ctx) => {
    if (currentVerdict?.kind !== "fts-raw" && currentVerdict?.kind !== "digest-hybrid") return;
    if (!sessionIndex || sessionIndex.size() === 0) return;
    /* primer body */
  });
  pi.on("session_start", async (event, ctx) => { /* migrate, resolve verdict, dispose+install lifecycle, kick sync */ });
  pi.on("session_shutdown", async () => { /* ... */ });
  // (lifecycle's pi.on calls also happen ONCE, inside installDigestLifecycle, called once at module load)

  pi.registerCommand("find-session", { handler: async (...) => {
    if (currentVerdict?.kind === "misconfigured") { ctx.ui.notify(currentVerdict.notifyMessage, "error"); return; }
    /* real overlay logic */
  }});
  pi.registerCommand("digest:show", { /* same verdict-aware-body pattern */ });
  // ... 12+ more commands (search/digest set + recovery set)

  pi.registerTool(sessionSearchTool({ /* handler re-checks verdict */ }));
  // ... session_list, session_read, similarly
}
```

When `session_start` fires:
1. `bootGeneration++` (any prior async work tagged with the old generation will short-circuit on completion).
2. Run `migrateIndexFileIfStale` unconditionally.
3. Compute `verdict = await resolveModeVerdict(...)` (with the async-retry above).
4. Assign to `currentVerdict` (closure-shared with all handlers).
5. If `verdict.kind === "misconfigured"`: call `ctx.ui.setStatus` with `verdict.statusLine`, emit `ctx.ui.notify` with `verdict.notifyMessage`. Return. No index, no lifecycle work, no sync.
6. Otherwise: call `lifecycleHandle.deactivate()` on the existing lifecycle (clears `currentModel`, debounce timers, and aborts any in-flight digest LLM call; handle remains reusable on the next valid `session_start`). Call `prevSessionIndex?.dispose()` to abort in-flight embedder fetches and close the FTS handle. Construct new `sessionIndex` (FtsSessionIndex or SessionIndex). The digest lifecycle is already installed (once at module load, registered AFTER this `session_start` handler so verdict-resolution runs first); its session_start handler-body re-reads config + verdict on each event and resumes normal operation. Kick `sessionIndex.load().then(() => sessionIndex.sync(...))` with a generation guard.

**Generation-token guard for stale async**: every async callback that could race with a verdict transition (initial sync, status clears, periodic interval) captures `bootGeneration` at scheduling time and checks `myGeneration === bootGeneration` before mutating UI state. Stale callbacks return early. Without this guard, a still-running initial sync from a prior valid verdict could clear the misconfigured status line that a subsequent `session_start` re-set.

**Commands and tools are always-registered; their bodies are verdict-aware**:
- Search/digest commands and tools (`session_search`, `session_list`, `session_read`, `/find-session`, `/digest:show`, `/digest:update`, `/digest:rewrite`, `/digest:backfill`, `/digest:cost`) re-check `currentVerdict` at invocation. If `misconfigured` at invocation, they return the verdict's `notifyMessage` text via `ctx.ui.notify` (and tools return that text as their result `content`). They do NOT execute search or digest work in the misconfigured case.
- Recovery commands (`/session-embeddings-setup`, `/digest:settings`) work in BOTH valid AND misconfigured states. Their bodies do NOT short-circuit on misconfigured — they ARE the recovery affordance. Both commands today already only read/write config files; neither requires a constructed index or lifecycle.

**Trade-off vs the prior "unregistered when misconfigured" design**:
- Lost: pi command palette pristine on misconfigured cold-start (commands appear but error). Acceptable given the warm-path equivalent already required this.
- Gained: handler list does not grow; eliminates a real memory-leak class; spec scenarios become uniformly testable (cold-start vs warm-path no longer have different registration semantics).

**Rationale**:
- "No fallback" was an explicit user requirement — silent demotion masks user intent.
- Persistent status (vs notify-only) ensures the user sees the problem even if the notify scrolled off.
- Module-load registration uniformly avoids the hook-accumulation memory leak that a per-`session_start` registration model would produce. The cost (commands appear in palette but error in misconfigured state) was already required for the warm-path semantics; making it the cold-start default removes asymmetry.
- Recovery commands (`/session-embeddings-setup`, `/digest:settings`) work without an index or lifecycle by design — they are config-editing commands that read/write files directly. They give the user a slash-command path to fix misconfigured state from inside pi.
- `pi.on(...)` HOOK accumulation is a real problem (verified: `loader.js:131-135` pushes to an array with no removal). The module-load model sidesteps it entirely. Future-proofing depends on pi-coding-agent eventually exposing an unregister API; until then this is the safest pattern.
- Async-retry verdict resolution preserves the registry-population race recovery that the prior `reEvaluate` case (a) provided. ~1 s cost on first cold start with valid digest config.
- The extension still loads (doesn't throw), so other extensions are unaffected and pi remains usable.

**Headless / RPC mode behavior**: pi-coding-agent's headless / RPC deployments may not surface `setStatus` to a visible UI. In those contexts the error notify and `console.error` (the structured-log convention; pi-coding-agent does not expose a dedicated logger in its public API) are the only signals. Spec acknowledges this as a known limitation — the misconfigured verdict's user-facing affordances are TUI-biased.

**Alternatives considered**:
- Throw on misconfiguration. Wrecks pi for users who accidentally have stale config; harsh.
- Per-`session_start` `registerForVerdict(...)` (the R1 design). Rejected after R2 review surfaced `pi.on` hook accumulation; replaced by module-load registration.
- Cold-start commands unregistered; warm-path commands registered-but-erroring. Asymmetric; doubles the spec scenario surface; ultimately needed handler-recheck mitigation anyway.
- Silent demote to fts-raw with a one-shot notify. The original proposal; rejected because notifies disappear and partial config persists indefinitely.
- Synchronous verdict (no retry). Regresses the registry-population race the prior `reEvaluate` case (a) handled.
- Unregister all commands including recovery. Strands the user with no in-pi recovery path.

### D3. FTS sidecar `hybrid-fts.db` gains `raw_content` column with dedicated FTS-shaped concat

**Decision**: The FTS5 virtual table in `hybrid-fts.db` is recreated with two indexed text columns:

```sql
CREATE VIRTUAL TABLE s USING fts5(
  digest_body,
  raw_content,
  metadata UNINDEXED,
  ...
);
```

Search uses BM25 with column weights:

```sql
SELECT id, bm25(s, 2.0, 1.0) AS score FROM s WHERE s MATCH ? ORDER BY score LIMIT ?;
```

Default weights `(digest_body=2.0, raw_content=1.0)` favor digest matches per-occurrence; literal-only matches in raw still surface but with a lower per-occurrence contribution. The weight ratio's only normative constraint is the inequality `digest_body weight > raw_content weight`. Calibration uses the **mathematical-constraint approach** (see tasks §8): a synthetic fixture under `tests/fixtures/bm25-corpus/` validates the inequality holds via per-tuple match counts and a parallel FTS5 round-trip smoke fixture validates BM25 is invoked correctly. Calibration is NOT a release gate — the implementation constants ship as initial values that satisfy the inequality; production-telemetry-driven tuning is a v3.x exercise.

**Important caveat on "digest outranks raw"**: FTS5 BM25 column scoring is *additive across columns and over multiple matches*. A query that hits `raw_content` 5× with high IDF can outrank a query that hits `digest_body` 1× with comparable IDF. The spec scenario "digest-body match outranks raw-only match" is normative ONLY when match counts and term IDFs are comparable. The calibration fixture exists to surface multi-hit-in-raw inversion cases before they hit users.

**Spec normative claim**: only the inequality `digest_body weight > raw_content weight` is normative. Specific numeric values (the working default `(2.0, 1.0)`) live ONLY in this design doc and the implementation, NOT in spec scenarios. This avoids cascading spec edits when calibration changes the ratio.

**Rationale**:
- Users searching for literal identifiers (file paths, function names, error codes) need lexical fallback when the digest body abstracts those terms away.
- FTS5 native column weighting is free (no per-row computation overhead); the alternative of storing two FTS rows per session and fusing externally is strictly worse.
- Storage cost negligible (~10× the digest-only FTS, still tens of MB at thousands of sessions).
- Embeddings remain digest-only — cosine quality is unchanged. The change is exclusively to the lexical channel.

**`raw_content` source: dedicated FTS-shaped concat, NOT the legacy embedding concat**: A new helper `buildRawFtsContent(session: ParsedSession): string` is the single source for the `raw_content` column. It MUST NOT reuse `buildEmbeddingText`'s output verbatim because that helper was shaped for embedding (assistant prose included to give context to the encoder) and produces FTS5-pathological tokenization for our use case (large JSON dumps from tool results, base64 chunks pasted by users, file-path tokens fragmenting on `/`).

Field policy for `buildRawFtsContent` (all caps measured in **bytes** of UTF-8 output, not characters, to avoid multibyte content silently exceeding budgets):
- **Include**: `userMessages` (joined with `\n`, byte-truncated to 6 KB total across all messages), `compactionSummaries` (joined with `\n`, byte-truncated to 4 KB total), `branchSummaries` (joined with `\n`, byte-truncated to 2 KB total), `headline` (full).
- **Exclude**: `assistantText` (the noisiest source — carries tool-output JSON, file diffs, base64 paste-throughs).
- **Tokenize-friendly normalize**: in `filesModified`, replace `/` with ` / ` so paths split into navigable terms (`src/index/fts-index.ts` becomes tokens `src index fts index ts`); strip lines matching the conservative `^[A-Za-z0-9+/=]{200,}$` regex (base64-like single-token blobs); collapse runs of whitespace.
- **Concatenation order**: headline, userMessages, compactionSummaries, branchSummaries, normalized filesModified. Each section truncated to its byte budget BEFORE concatenation.
- **Final byte cap**: 12 KB total per session. After per-section truncation + concat, the result is byte-truncated to 12 KB if it exceeds (handles edge cases where multibyte content blows past the per-section budgets in aggregate).

The FTS5 `tokenize` argument is pinned to `'porter unicode61'`. A round-trip test (`fts-tokenizer.test.ts`) asserts that hard-literal queries (`ENOENT`, `0x80000003`, `gpt-5.4-nano`) survive tokenization and match a fixture session containing those exact strings.

**Alternatives considered**:
- Single concatenated column with no weighting. Loses the ability to express "prefer digest matches" — a literal hit in raw would rank as high as a curated-prose hit in digest.
- Two separate FTS rows (one per signal) fused with RRF outside SQLite. More code, slower, no win.
- Raw-only FTS in digest-hybrid. Throws away the digest's lexical signal entirely; semantically narrower than the curated prose.

### D4. INDEX_VERSION 4 → 5 forces a single auto-migration; two-phase + self-healing

**Decision**: Bump `INDEX_VERSION` to 5. `migrateIndexFileIfStale` is extended to handle four migration paths. ANY `version !== 5` triggers a wipe (the FTS schema changed across the board); `lastMode` discriminates only the user-facing notify text.

| Disk state | Action | Notify text |
|---|---|---|
| `version === 5` | No-op | (none) |
| `version === 4` AND `lastMode === "hybrid-raw"` AND post-migration verdict is digest-hybrid | Wipe `session-index.json` + `hybrid-fts.db` | "session-search: hybrid-raw mode removed in v3.0.0; index reset; embeddings will rebuild from existing digests" |
| `version === 4` AND `lastMode === "hybrid-raw"` AND post-migration verdict is misconfigured | Wipe `session-index.json` + `hybrid-fts.db`; misconfigured-verdict path takes over | (the misconfigured remediation notify; NOT the rebuild promise) |
| `version === 4` AND `lastMode === "digest-mode"` | Wipe `session-index.json` + `hybrid-fts.db` (FTS schema changed) | "session-search: index format upgraded; rebuilding from existing digests" |
| `version === 4` AND `lastMode === undefined` (early v4 file before lastMode tracking) | Wipe `session-index.json` + `hybrid-fts.db` | "session-search: index format upgraded" |
| `version <= 3` (truly stale) | Existing wipe path | Existing message |

In all wipe cases, `~/.pi/session-search/digests/*.json` is preserved. **Migration code reads `lastMode` as `string | undefined`**, not as the narrowed `Mode` type, because the legacy literals `"hybrid-raw"` and `"digest-mode"` are no longer members of `Mode` after task 1.1 narrows it.

**Two-phase atomicity + FTS self-heal**:

Phase ordering in `migrateIndexFileIfStale`:
1. **Phase 1 — FTS rebuild**: open `hybrid-fts.db`, `DROP TABLE IF EXISTS s`, `CREATE VIRTUAL TABLE s USING fts5(digest_body, raw_content, ...)`. Close handle.
2. **Phase 2 — JSON write**: write `session-index.json` (atomically via `writeFileSync(tmp); rename(tmp, real)`) with `{version: 5, vectorDim: 0, lastMode: undefined, sessions: {}}`.

If the process is killed between phases, next load sees `version: 4` (Phase 2 didn't complete), re-enters Phase 1 (idempotent: drops then recreates with the v5 schema), then Phase 2.

**Phase 1 atomicity**: the DROP+CREATE pair SHALL execute inside an explicit SQLite transaction (`BEGIN; DROP TABLE IF EXISTS s; CREATE VIRTUAL TABLE s USING fts5(...); COMMIT;`). This guarantees that a kill mid-Phase-1 leaves the FTS db in either the pre-Phase-1 state (rollback on uncommitted) or the post-CREATE state, never an intermediate.

**Phase 1 error path**: if Phase 1 throws (disk full, permissions), the migration aborts cleanly: `session-index.json` stays at v4, the FTS db is unchanged (transaction rolled back). The extension emits an error notify identifying the failure and the recommended user action (free disk space, fix permissions). Next load retries.

**FTS schema introspection self-heal** (defense in depth): `FtsSide`'s constructor (or first `load()` call) executes `SELECT sql FROM sqlite_master WHERE type='table' AND name='s'`. Three cases:
1. No row returned (table absent): `CREATE VIRTUAL TABLE s USING fts5(...)` with v5 schema.
2. Row returned, DDL matches expected v5 declaration (verified by literal substring match including the `tokenize='porter unicode61'` directive): no-op.
3. Row returned, DDL does NOT match: `DROP TABLE s` then recreate with v5 schema.

This recovers from any state where `hybrid-fts.db` has the wrong schema or no schema, regardless of how it got there.

**Atomic JSON write**: `SessionIndex.save()` writes via `writeFileSync(tmp); rename(tmp, real)` — not the current direct `writeFileSync(real)`. Power loss between truncate and write of the real file would otherwise yield a 0-byte session-index.json.

**Rationale**:
- A single, unambiguous, automatic wipe is simpler than a probe-then-decide migration. Embeddings re-derive cheaply from existing digests (one ollama call each, fast).
- The two paths converge: both end with a fresh empty index that the next sync rebuilds. No special "carry-forward" logic.
- Wiping the FTS sidecar is mandatory because the schema gained a column — incompatible with v4's single-column rows.
- `hybrid-raw` users with NO digests get an empty post-wipe index; they remain in fts-raw mode (binary mode resolution decides this independently of disk state) and see a recommendation to configure a digest model + run `/digest:backfill`.

**Alternatives considered**:
- In-place `ALTER TABLE` to add `raw_content`. SQLite FTS5 doesn't support adding indexed columns to virtual tables; rebuild is required.
- Best-effort partial migration (carry over `digest_body` rows, leave `raw_content` empty until next sync). Adds code; no benefit since the next sync repopulates everything in seconds.
- Reverse the phase order (JSON first, FTS second). Rejected because the inverted-phase failure mode (JSON v5, FTS still v4 schema) is detected only at the first INSERT, while FTS-first-then-JSON failure self-heals on next load via the JSON-version check.

**`populateFtsFromIndex` recovery path under v5**: The existing `populateFtsFromIndex()` reconstructs FTS rows from `session-index.json`'s persisted (post-strip) session metadata when `hybrid-fts.db` is missing or empty. Under the new two-column schema:
- `digest_body` column: populated from `entry.digest?.body` (always available where a digest exists).
- `raw_content` column: **left empty** during recovery. The stripped session metadata in `session-index.json` does NOT contain user messages or other raw fields needed to reconstruct `buildRawFtsContent`. Recovery is intentionally lossy on the raw column; the next full sync re-parses JSONLs and repopulates `raw_content` correctly.
- Spec scenario asserts: "After `hybrid-fts.db` deletion + `session-index.json` survival, `populateFtsFromIndex` rebuilds digest_body for all entries and raw_content remains empty until next sync runs."

### D5. Lifecycle `reEvaluate` simplifies; `markAllDirtyAndClearEmbeddings` is removed

**Decision**: Delete `LifecycleDeps.markAllDirtyAndClearEmbeddings`, the implementation in `SessionIndex.ts`, and `reEvaluate` case (b). Case (a) (fresh-install upgrade) survives but is now the only re-evaluation path.

In v3.0.0 there is no scenario where the index has existing entries written under a different mode and now needs to be repurposed. The mode is fixed at startup by the binary verdict, and any v2.x → v3.0.0 transition triggers the wipe in D4 before the index is constructed.

**Rationale**:
- Mode transitions during a single pi process were only meaningful when `hybrid-raw` could upgrade to `digest-mode`. With binary modes resolved at startup, that transition is gone.
- `reEvaluate` still serves a purpose: model registry may not be populated at first `session_start`, so we retry once. Case (a) handles that. Case (b) handled migration of *existing* hybrid-raw embeddings; now obsolete.
- Net code reduction: ~30 LOC across `lifecycle.ts` and `session-index.ts`.

**Alternatives considered**: Keep `markAllDirtyAndClearEmbeddings` as a public method "in case someone needs it." Rejected — YAGNI; if a future change needs it, re-introduce it under a real motivating use case.

### D6. Module-load registration with verdict-aware bodies (replaces D6's R1 form)

**Decision** (revised): All commands and tools are registered ONCE at module load. Bodies branch on `currentVerdict`:

```ts
// Search/digest commands and tools — verdict-aware bodies, work only in valid verdicts.
pi.registerCommand("find-session", { handler: async (cmd, ctx) => {
  if (currentVerdict?.kind === "misconfigured") {
    ctx.ui.notify(currentVerdict.notifyMessage, "error");
    return;
  }
  // ... real overlay logic, mode-aware (fts-raw vs digest-hybrid)
}});

pi.registerTool(sessionSearchTool({
  description: "Search sessions by content",
  handler: async (params, ctx) => {
    if (currentVerdict?.kind === "misconfigured") {
      return { content: [{ type: "text", text: currentVerdict.notifyMessage }] };
    }
    // ... search using sessionIndex
  }
}));

// Recovery commands — work in BOTH valid and misconfigured states (they ARE the recovery path).
pi.registerCommand("session-embeddings-setup", { handler: async (...) => {
  // Edits ~/.pi/session-search/config.json; works regardless of currentVerdict.
  // After successful edit, prompts user to /reload.
}});
pi.registerCommand("digest:settings", { handler: async (...) => {
  // Edits ~/.pi/session-search/digest.json; works regardless of currentVerdict.
}});

// Lifecycle handlers — installed ONCE at module load, body checks verdict.
installDigestLifecycle(pi, /* deps */);  // its session_start handler reads currentVerdict and no-ops if not digest-hybrid
```

**Why no command-bucket split**: The handler-recheck pattern is uniform across all search/digest commands. Spec scenarios pin the bodies' behavior; their registration is implementation detail.

**Rationale**:
- Avoids `pi.on` handler accumulation (the dominant constraint after R2 review).
- Recovery commands always available means the misconfigured user has a slash-command path to fix things.
- Search/digest command bodies degrade gracefully via verdict re-check.
- Replaces the legacy permanent-`disposed`-flag pattern: under the new model, `LifecycleHandle.deactivate()` clears active state but leaves the handle reusable on the next valid verdict; `dispose()` is reserved for `session_shutdown` (true process teardown).

**Alternatives considered**:
- Per-`session_start` `registerForVerdict(...)` (R1 design). Rejected: leaks `pi.on` handlers per the verified loader.js append semantics. R2 review surfaced this.
- Bucket commands as cold-start-only-vs-warm-path-also. Asymmetric; doubles spec scenarios.
- Recover-via-`/reload`-only (no recovery commands at all). Hostile UX; user must edit config files manually.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Existing v2.x users with `hybrid-raw` AND NO digest model lose their search index AND boot misconfigured on upgrade. | Misconfigured verdict registers `/session-embeddings-setup` and `/digest:settings` so the user can recover from inside pi. Migration notify text is the misconfigured remediation message (NOT a stale rebuild promise). |
| Storage cost of the new FTS column grows `hybrid-fts.db` ~10×. | Negligible at any practical session count. 10k sessions × 10KB raw concat ≈ 100MB. |
| BM25 weight defaults `(2.0, 1.0)` may be wrong, AND multi-hit-in-raw cases can invert "digest outranks raw." | Spec normative claim is `digest_body weight > raw_content weight`, not a strict ranking guarantee. Math-constraint test + FTS5 smoke test gate the implementation; production-driven re-calibration is a v3.x exercise. |
| `buildRawFtsContent` polluting FTS5 vocabulary with assistant tool output, JSON dumps, base64. | Field policy excludes `assistantText` entirely; base64-like single-token lines are stripped; file paths are tokenize-normalized; hard 12 KB cap. |
| Migration mid-flight kill → corrupt FTS schema. | Two-phase ordering (FTS first, JSON last) + `FtsSide` schema introspection self-heal on every load. |
| `pi-coding-agent` lacks `unregisterCommand`, so warm-path verdict downgrades cannot remove already-registered commands. | Handlers re-check `currentVerdict` at invocation. Misconfigured-at-invocation emits remediation message and returns. |
| `session-embedder` legacy-bedrock-rejection scenario contradicts new partial-config rule. | Add explicit spec delta updating that scenario to be verdict-dependent; see specs/session-embedder/spec.md in this change. |
| Headless / RPC mode users cannot see the persistent status line. | Acknowledge as known limitation; misconfigured-state notify and a structured log line in pi's log are the only signals in non-TUI deployments. Documented in spec. |
| `lastMode: undefined` v4 file (early v4 before lastMode tracking) falls through migration table. | Migration treats ANY `version !== 5` as wipe-trigger; `lastMode` only discriminates notify text. |
| Misconfigured-state notify is one-shot — users may miss it. | Persistent status line is re-set on every `session_start` that resolves misconfigured (not just first); survives `/reload` cycles. |
| Auto-wipe may surprise users who didn't read the changelog. | Pre-release: bump major version (v3.0.0); CHANGELOG breaking-change banner. Notify identifies what was wiped + what was kept. |
| Scenario `S02` repurposing creates a different test contract. | S02's contract change is documented in `tests/scenarios/SCENARIOS.md`; the scenario script asserts the new contract; no silent change. |
| `populateFtsFromIndex` recovery is lossy on the new `raw_content` column. | Acceptable: spec scenario pins "raw_content empty until next full sync"; functionally `session_search` still works on digest_body matches; next sync repopulates raw correctly. |
| Symmetric notify wording for the two misconfigured cases must be unambiguous. | Notify text spells out exactly which file is missing and exactly which file to remove for the alternative valid state. Pinned in scenarios. |

## Migration Plan

**Pre-release**:
1. Land all code changes on `main`.
2. Update CHANGELOG with breaking-change banner.
3. Tag `v3.0.0` only after both unit tests (target: 212/212 → 220/220) and scenarios (target: 20/20 CI-blocking subset; full live-model suite manually verified) pass.

**Per-user, on first run of v3.0.0**:
1. `migrateIndexFileIfStale` detects v4 file → wipes `session-index.json` + `hybrid-fts.db`. Digests preserved.
2. Mode verdict resolved against current config.
3. If `digest-hybrid`: initial sync re-embeds all digested sessions and rebuilds the new two-column FTS rows. ~1–2 ollama calls per digested session, completes in seconds for typical corpus sizes.
4. If `fts-raw`: initial sync rebuilds `sessions-fts.db` from raw content (existing FtsSessionIndex behavior, unchanged).
5. If `misconfigured`: persistent error status, no sync, no commands. User edits config + restarts.

**Rollback**: pin to `v2.x` in package.json. v3.0.0's wipe is irreversible (raw-content embeddings are gone). Functional rollback to v2.x is a **destructive rebuild**, NOT a state-preserving rollback:
- v2.x's `migrateIndexFileIfStale` will see a `version: 5` JSON and treat it as incompatible (existing pre-v4 logic), wiping to empty and rebuilding under v2 conventions on next sync.
- v2.x has no `digest-hybrid` literal in its `Mode` type. If the wipe DID NOT clean `lastMode`, v2.x's `load()` mode-transition detection compares `previousMode !== this.mode` (`"digest-hybrid" !== "digest-mode"`) and triggers an embeddings clear — noisy but recoverable.
- v2.x's `FtsSide` constructor uses the single-column FTS schema. After v2.x's wipe+rebuild, `hybrid-fts.db` has the old single-column `s` table, populated with v2.x's `buildContent(session, mode)` output. Functional.
- Digests on disk (`schemaVersion: 1`, unchanged in v3.0.0) are read back by v2.x's `loadDigest`. ✓
- **Failure modes not covered**: a v2.x runtime that bypasses `migrateIndexFileIfStale` (e.g., manually preserved v3 file across the downgrade) sees an unrecognized `lastMode` literal and may misclassify. Document as known fragility, not blocker.

**Rollback is verified once on a v5-upgraded profile** as part of pre-release smoke (manual). It is NOT a supported, repeatable, or safe rollback path — just a downgrade-by-rebuild affordance.

**No flag, no opt-in**: this is a breaking version bump. v3.0.0 means the new behavior. Users wanting v2.x semantics stay on v2.x.

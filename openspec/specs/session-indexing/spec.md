# session-indexing Specification

## Purpose
TBD - created by archiving change add-digest-driven-indexing. Update Purpose after archive.
## Requirements
### Requirement: Mode auto-detection

The indexing layer SHALL operate in one of two modes, selected automatically based on configuration. There is no user-facing mode toggle. Partial configuration (exactly one of embedder OR digest model present, OR both broken) SHALL produce a misconfigured verdict that gates the bodies of search/digest commands and tools, NOT a graceful demotion to a different mode.

Conventions for the table below: "embedder available" means `createEmbedder(config.embedder, ...)` returned a non-null `Embedder` instance. "Embedder rejected" (legacy bedrock or other invalid types) is treated identically to "no embedder" by the verdict resolver — both produce a `null` embedder. The verdict resolver consumes the embedder-construction outcome (null vs Embedder), NOT the raw config-file contents.

| Config / runtime state                                                | Verdict             |
|-----------------------------------------------------------------------|---------------------|
| embedder null AND `digestRequested === false`                         | `fts-raw`           |
| embedder available AND `digestRequested === false`                    | `misconfigured` (`missing: "digest"`) |
| embedder available AND digest model resolvable                        | `digest-hybrid`     |
| embedder available AND `digestRequested === true` AND no digest model resolvable | `misconfigured` (`missing: "digest"`) |
| embedder null AND `digestRequested === true` AND digest model resolvable | `misconfigured` (`missing: "embedder"`) |
| embedder null AND `digestRequested === true` AND no digest model resolvable | `misconfigured` (`missing: "both"`) |

**Rationale for `embedder available AND digestRequested === false`** → `misconfigured`: this is the legacy v2.x `hybrid-raw` cohort — a user with an embedder configured but no digest intent. Under v3.0.0's binary mode rule, embedder configured implies digest-hybrid intent. To boot in `fts-raw`, the user must remove the embedder config (or, intuitively, configure a digest model and join `digest-hybrid`). The misconfigured remediation notify (`missing: "digest"`) names both the file to add (`digest.json`) AND the file to remove (`config.json`) so the user can choose either resolution path.

In `fts-raw` mode the system SHALL preserve upstream pi-session-search semantics (FTS5 over raw user messages). In `digest-hybrid` mode the system SHALL embed `digest.body` and FTS-index BOTH `digest.body` and a budgeted concatenation of raw session content (`buildRawFtsContent`) as separately-weighted columns. See `session-search` capability for normative weight constraints. The `missing` field's priority when both halves are absent SHALL be `"both"` so the remediation notify can name BOTH files.

**Verdict resolution is async with one bounded retry**. `ctx.modelRegistry.getAvailable()` populates asynchronously after the first `session_start`. To preserve the registry-population race recovery that prior versions handled via `lifecycle.reEvaluate`:

- If the synchronous verdict resolution returns `misconfigured` AND `missing` is `"digest"` OR `"both"` AND `digestRequested === true`, the resolver SHALL `await` for `~1000ms` (configurable internally; default `1000ms`) and re-run the synchronous resolution.
- If the second pass also returns `misconfigured`, the verdict is final (with whatever `missing` value the second resolution produces).
- If the second pass resolves to `digest-hybrid` OR transitions to a less-bad misconfigured state (e.g., `"both"` → `"embedder"` because the digest model became resolvable while the embedder remained rejected), the new verdict is used.
- The resolver SHALL NOT retry for `missing: "embedder"` only (embedder construction is synchronous; it cannot benefit from a retry).

**Verdict assignment is generation-guarded**. Two `session_start` events firing within the retry window (e.g., rapid `/reload`) MUST NOT race. The session_start handler captures `myGen = ++bootGeneration` BEFORE awaiting `resolveModeVerdict`; on return, it compares `myGen === bootGeneration` before mutating `currentVerdict`. If the generations differ, a newer `session_start` has already won; the current handler returns without mutating shared state.

**Module-load registration with verdict-aware bodies**: All commands, tools, and event hooks SHALL be registered ONCE at module load time, NOT inside `session_start`. This is mandatory because pi-coding-agent's `pi.on(event, handler)` API uses *append* semantics with no removal API (verified at `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/loader.js`). Registering hooks per-`session_start` would leak handlers indefinitely across `/reload` cycles, producing duplicate primer injections and unbounded memory growth.

**Handler registration order**: the extension's own `session_start` handler (which resolves `currentVerdict`) MUST be registered BEFORE any sub-component (digest lifecycle, periodic-sync registrar) whose handlers consume `currentVerdict`. Append-dispatch semantics mean the first-registered handler runs first per event; the verdict-resolving handler must precede consumers in registration order so consumers see a fresh verdict on every `session_start`. The lifecycle's `installDigestLifecycle(...)` call SHALL be made AFTER the extension's primary `session_start` handler is registered.

When verdict is `misconfigured`:
- The extension SHALL NOT instantiate any index.
- Search/digest commands (`session_search`, `session_list`, `session_read` tools and `/find-session`, `/session:digest`, `/session:update`, `/session:rewrite`, `/session:backfill`, `/session:cost`) ARE registered at module load (per the registration policy above) but their HANDLERS SHALL re-check `currentVerdict` at invocation time and return the verdict's `notifyMessage` (via `ctx.ui.notify` for commands, via the tool result `content` for tools) without performing any search/digest work.
- The digest lifecycle is installed at module load (one-shot); its event-handler bodies SHALL re-check `currentVerdict` at invocation and skip lifecycle work if not in `digest-hybrid`.
- The recovery commands `/session:embedder` and `/session:summarizer` ARE registered at module load and their handlers work IN ALL VERDICTS — they edit config files directly without requiring a constructed index or lifecycle. They are the user's slash-command path to fix configuration from inside pi.
- The extension SHALL set a persistent status line via `ctx.ui.setStatus("session-search", verdict.statusLine)` on EVERY `session_start` that resolves misconfigured (not only the first).
- The extension SHALL emit ONE `ctx.ui.notify(verdict.notifyMessage, "error")` on each `session_start` that resolves misconfigured.
- A `bootGeneration` counter SHALL increment on every `session_start`. Every async callback (initial sync, status clears, periodic sync, debounced digest writes, in-flight digest completions, embedder fetches) SHALL capture `bootGeneration` at scheduling time and short-circuit if its captured value differs from `currentBootGeneration` at completion. The verdict-assignment step itself (`currentVerdict = await resolveModeVerdict(...)`) SHALL be generation-guarded: if `myGen !== bootGeneration` after the await resolves, the assignment is skipped. Prior `SessionIndex` instances scheduled for replacement SHALL have their in-flight embedder fetches aborted (via `AbortController`) and their `FtsSide` handles closed before the new index is constructed; spec scenario "Warm-path verdict transition does not race with stale upsert" pins this behavior.

**Warm-path verdict transitions** (config edited mid-process, then `/reload`): pi-coding-agent does NOT expose `unregisterCommand` or `unregisterTool`. Module-load registration sidesteps the leak issue but means that a valid → misconfigured transition does NOT remove handlers — they remain registered with verdict-aware bodies that surface the misconfigured remediation message. The reverse transition (misconfigured → valid) is naturally clean: handlers re-check verdict at invocation and now find a valid state, executing real search/digest work.

Verdict is computed once per `session_start`. Mid-session config edits without `/reload` are NOT detected; users must `/reload` after editing config files for the verdict to re-resolve.

**Headless / RPC deployments**: `ctx.ui.setStatus` may not surface to a visible UI in non-TUI deployments. In those contexts the misconfigured signal is conveyed via `ctx.ui.notify` AND a `console.error` line (the structured-log convention; pi-coding-agent does not expose a dedicated logger). The TUI status line is a best-effort signal, not a guarantee.

#### Scenario: No embedder, no digest model → fts-raw mode

- **WHEN** `~/.pi/session-search/config.json` has no `embedder` field (or does not exist)
- **AND** no digest model is configured or resolvable
- **THEN** the active index is `FtsSessionIndex` indexing raw user messages via `buildContent(session)`
- **AND** the extension registers `session_search`, `session_list`, `session_read` tools and `/find-session` command

#### Scenario: Embedder + digest model → digest-hybrid mode

- **WHEN** `~/.pi/session-search/config.json` configures an embedder
- **AND** a digest model is resolvable from the model registry OR explicitly configured in `digest.json`
- **THEN** the active index is `SessionIndex` embedding `digest.body` and writing both digest body and raw content to FTS
- **AND** the extension registers all search tools, the digest lifecycle, and digest slash commands

#### Scenario: Embedder configured, digestRequested true, no digest model → misconfigured (after async retry)

- **WHEN** `~/.pi/session-search/config.json` configures an embedder
- **AND** `digestRequested === true` (e.g., `~/.pi/session-search/digest.json` exists OR explicit provider/model overrides)
- **AND** no digest model is resolvable from the registry on first sync resolution
- **AND** the registry does NOT populate within ~1000ms (the retry window)
- **THEN** the verdict is `misconfigured` with `missing: "digest"`
- **AND** the extension sets a persistent status line: `"session-search: misconfigured (no digest model)"`
- **AND** the extension emits ONE error notify naming `~/.pi/session-search/digest.json` as the file to configure AND `~/.pi/session-search/config.json` as the file to remove for `fts-raw` fallback
- **AND** search/digest commands and tools are registered at module load BUT their handlers return the remediation message on invocation
- **AND** the recovery commands `/session:embedder` and `/session:summarizer` ARE registered AND their handlers work normally (not blocked by misconfigured verdict)
- **AND** no index is instantiated
- **AND** no sync runs

#### Scenario: Embedder configured, digestRequested true, registry populates within retry window → digest-hybrid

- **WHEN** `~/.pi/session-search/config.json` configures an embedder
- **AND** `digestRequested === true`
- **AND** the synchronous first verdict resolution returns `misconfigured (missing: "digest")` because `ctx.modelRegistry.getAvailable()` has not yet populated
- **AND** the registry populates within the ~1000ms retry window
- **THEN** the second verdict resolution returns `digest-hybrid`
- **AND** the misconfigured notify and status line are NOT shown
- **AND** the extension instantiates `SessionIndex` and runs initial sync
- **AND** the user does not need to `/reload` to recover from the registry-population race

#### Scenario: Digest model configured, no embedder → misconfigured

- **WHEN** `~/.pi/session-search/digest.json` configures a digest model
- **AND** `~/.pi/session-search/config.json` has no `embedder` field (or does not exist)
- **THEN** the verdict is `misconfigured` with `missing: "embedder"`
- **AND** the extension sets a persistent status line: `"session-search: misconfigured (no embedder)"`
- **AND** the extension emits ONE error notify naming `~/.pi/session-search/config.json` as the file to configure AND `~/.pi/session-search/digest.json` as the file to remove for `fts-raw` fallback
- **AND** search/digest commands and tools have verdict-aware bodies that return the remediation message on invocation
- **AND** the recovery commands `/session:embedder` and `/session:summarizer` work normally
- **AND** the verdict resolver SHALL NOT retry for `missing: "embedder"` (embedder construction is synchronous)

#### Scenario: Both broken → missing: "both"

- **WHEN** `~/.pi/session-search/config.json` exists but contains a legacy `type: "bedrock"` embedder that the loader rejects
- **AND** `~/.pi/session-search/digest.json` exists but `digestRequested` is true and no digest model resolves
- **THEN** the verdict is `misconfigured` with `missing: "both"`
- **AND** the notify text names BOTH `~/.pi/session-search/config.json` AND `~/.pi/session-search/digest.json` as files to fix
- **AND** the status line is `"session-search: misconfigured (no embedder, no digest model)"`

#### Scenario: Warm-path valid → misconfigured transition

- **WHEN** the extension was previously loaded with verdict `digest-hybrid` and search/digest commands+tools were registered at module load
- **AND** the user removes `~/.pi/session-search/digest.json` and runs `/reload`
- **AND** `session_start` re-fires (incrementing `bootGeneration`), and the new verdict resolves to `misconfigured`
- **THEN** `currentVerdict` (closure-shared) is updated to misconfigured (unless a still-newer `session_start` has further incremented `bootGeneration` during the await; in that case the current handler short-circuits the assignment)
- **THEN** the persistent status line is re-set to the misconfigured message
- **AND** an error notify fires
- **AND** the registered command/tool handlers (which were registered ONCE at module load) now return the misconfigured remediation when invoked, because they re-check `currentVerdict` at invocation time
- **AND** any in-flight async work from the prior valid verdict (initial sync, periodic sync, status-clear timeouts, debounced digest writes) compares its captured `bootGeneration` to `currentBootGeneration` on completion and short-circuits, leaving the misconfigured status line and notify intact
- **AND** the prior `SessionIndex` instance has any in-flight embedder fetches aborted (via `AbortController.abort()`); its `FtsSide` SQLite handle is closed before the next migration / index construction can run

#### Scenario: Warm-path verdict transition does not race with stale upsert

- **WHEN** a `digest-hybrid` `SessionIndex` has an in-flight `embedder.embed(text)` fetch outstanding
- **AND** a new `session_start` resolves verdict to `misconfigured` (or to a different `digest-hybrid` requiring index reconstruction)
- **THEN** the prior `SessionIndex`'s in-flight embedder fetch is aborted (via the `AbortController` it was scheduled under)
- **AND** the embedder fetch's `.then(...)` continuation either does not run, or runs and short-circuits via the `bootGeneration` guard
- **AND** no `INSERT` / `UPDATE` is issued against the new `hybrid-fts.db` table from the stale callback path
- **AND** the prior `SessionIndex.dispose()` (or equivalent teardown) closes its `FtsSide` SQLite handle before the verdict transition completes

#### Scenario: Two rapid session_start events do not race on verdict assignment

- **WHEN** session_start #1 fires and begins `await resolveModeVerdict(...)` which enters the ~1s retry path
- **AND** session_start #2 fires 200 ms later and resolves verdict synchronously to `digest-hybrid`
- **AND** session_start #2 completes assignment and kicks lifecycle/sync
- **AND** session_start #1's await resolves later (at ~1000 ms) with some verdict V1
- **THEN** session_start #1 compares its captured `myGen` to current `bootGeneration` (which now reflects #2's increment)
- **AND** the comparison fails; #1 returns without mutating `currentVerdict`
- **AND** the verdict reflected in `currentVerdict` is the one from session_start #2

#### Scenario: Warm-path misconfigured → valid transition

- **WHEN** the extension was previously loaded with verdict `misconfigured`
- **AND** the user fixes config and runs `/reload`
- **AND** `session_start` re-fires, resolving verdict `digest-hybrid`
- **THEN** `currentVerdict` is updated to digest-hybrid
- **AND** prior status line is overwritten by post-load setStatus calls (or cleared explicitly when sync completes)
- **AND** existing handler registrations (search/digest commands + tools) now execute their real bodies on invocation because the verdict re-check passes
- **AND** a new `SessionIndex` is constructed; the lifecycle's existing handlers (registered at original module load) read fresh config + verdict on session_start and operate normally

#### Scenario: Persistent status line re-set on every misconfigured session_start

- **WHEN** the extension loads with verdict `misconfigured`
- **AND** the user runs `/reload` (without fixing config)
- **AND** the verdict re-resolves to `misconfigured`
- **THEN** `ctx.ui.setStatus("session-search", ...)` is called twice (once per session_start)
- **AND** an error notify fires twice
- **AND** the status line text is identical across invocations

#### Scenario: pi.on handler list does not grow across reloads

- **WHEN** the extension is loaded and N synthetic `session_start` events fire (e.g., simulating N `/reload` cycles)
- **THEN** the count of registered handlers in pi's `before_agent_start` array (and other pi-event arrays) remains constant after the initial module-load registration
- **AND** the count does NOT grow with N
- **AND** the `installDigestLifecycle` function is invoked exactly ONCE per process lifetime

### Requirement: Index storage layout

The index data SHALL live under `~/.pi/session-search/`:

- `config.json` — embedder + extra-dirs config (existing, unchanged shape)
- `digest.json` — digest config
- `digests/<session-uuid>.json` — per-session durable digests
- `index/sessions-fts.db` — SQLite FTS5 DB used in `fts-raw` mode (single column over raw content)
- `index/hybrid-fts.db` — SQLite FTS5 side-car used in `digest-hybrid` mode (TWO columns: `digest_body` and `raw_content`)
- `index/session-index.json` — JSON metadata + base64 embeddings + `vectorDim` + `lastMode`, used in `digest-hybrid` only

In `digest-hybrid` mode, the FTS5 `digest_body` column SHALL contain `digest.body` and the FTS5 `raw_content` column SHALL contain the output of `buildRawFtsContent(session)` — a dedicated FTS-shaped concat distinct from the legacy embedding concat. `buildRawFtsContent` SHALL (all caps in BYTES of UTF-8 output, truncating only on UTF-8 character boundaries):
- Include: `userMessages` joined with `\n` (cap 6 KB total bytes across all messages), `compactionSummaries` joined with `\n` (cap 4 KB total bytes), `branchSummaries` joined with `\n` (cap 2 KB total bytes), `headline` (full).
- Exclude: `assistantText` (its tool-output JSON, file diffs, and base64 paste-throughs are pathological for FTS5 lexical retrieval).
- Normalize: replace `/` with ` / ` in `filesModified` so paths split into navigable terms; strip lines matching `^[A-Za-z0-9+/=]{200,}$` (base64-like single-token blobs); collapse whitespace runs.
- Final byte cap: 12 KB per session, applied AFTER per-section truncation + concat (handles aggregate overruns from multibyte content).

The FTS5 `tokenize` argument SHALL be `'porter unicode61'`. Hard-literal terms (`ENOENT`, `0x80000003`, `gpt-5.4-nano`, file paths) SHALL survive tokenization as searchable tokens; this is verified by a round-trip test fixture.

The embedding for each session SHALL be derived from `digest.body` only.

The `session-index.json` v5 schema SHALL include a top-level `vectorDim: number`, a top-level `lastMode: "fts-raw" | "digest-hybrid"`, and a top-level `version: 5`.

#### Scenario: Digest-hybrid populates both FTS columns

- **WHEN** the indexer runs in `digest-hybrid` for a session with `digest.body = "Refactored auth module..."` and raw user messages "Why is the test failing? It says ENOENT."
- **THEN** the FTS5 row's `digest_body` column contains `"Refactored auth module..."`
- **AND** the FTS5 row's `raw_content` column contains a concatenation including `"Why is the test failing? It says ENOENT."`
- **AND** the embedding vector is the result of `embedder.embed(digest.body)` (raw content does not influence the embedding)

#### Scenario: raw_content excludes assistantText

- **WHEN** a session contains assistant text with a 3 KB JSON dump of tool output
- **THEN** the row's `raw_content` column does NOT contain the JSON dump
- **AND** queries for tokens that appear ONLY in assistantText return no match for that session

#### Scenario: buildRawFtsContent byte caps with multibyte content

- **WHEN** a session's `userMessages` total 6500 bytes of UTF-8 (e.g., includes emoji or non-Latin characters)
- **THEN** `buildRawFtsContent` truncates `userMessages` to 6 KB (6144 bytes), NOT 6000 characters
- **AND** the final concatenated output is byte-truncated to 12 KB if the total exceeds (handles per-section budget overruns)
- **AND** truncation occurs on UTF-8 boundary (does not split a multibyte sequence)

#### Scenario: Hard-literal terms round-trip through tokenization

- **GIVEN** user-supplied query strings are passed to FTS5 via `toFtsQuery` which phrase-quotes each whitespace-split term (e.g., `gpt-5.4-nano` becomes the FTS5 phrase `"gpt-5.4-nano"`) so that `-`, `.`, etc. do not invoke FTS5's NEAR/exclusion operators
- **WHEN** a session's `userMessages` contains the literal string `"got ENOENT 0x80000003 from gpt-5.4-nano"`
- **AND** `session_search("ENOENT", limit: 5)` is called
- **THEN** the session is in the result set
- **WHEN** `session_search("0x80000003", limit: 5)` is called
- **THEN** the session is in the result set
- **WHEN** `session_search("gpt-5.4-nano", limit: 5)` is called
- **THEN** the session is in the result set
- **AND** the spec normative requirement that user query strings are phrase-quoted (not raw FTS5 expressions) MUST be preserved if `toFtsQuery` is refactored in the future

#### Scenario: Per-session digest file is independent of index DB

- **WHEN** the user deletes `~/.pi/session-search/index/` entirely
- **AND** the user runs `/session:reindex`
- **THEN** the indexer reads digests from `~/.pi/session-search/digests/<uuid>.json`
- **AND** rebuilds both FTS columns and embeddings without re-running any LLM calls

#### Scenario: populateFtsFromIndex recovery is lossy on raw_content

- **WHEN** `~/.pi/session-search/index/hybrid-fts.db` is deleted but `session-index.json` survives with persisted entries
- **AND** the extension loads in `digest-hybrid` mode
- **THEN** `populateFtsFromIndex()` rebuilds the FTS table
- **AND** for each entry that has `entry.digest`, the `digest_body` column is populated from `entry.digest.body`
- **AND** for each entry, the `raw_content` column is left EMPTY — raw_content is intentionally NOT partially reconstructed from the surviving stripped fields (`firstUserMessage`, `compactionSummaries`, `branchSummaries`, `filesModified`), because partial reconstruction would produce inconsistent recall depending on which sessions still have a JSONL on disk for the next sync to fully repopulate. Recovery prefers a predictable empty-then-repopulate over a half-populated heterogeneous state.
- **AND** the next full sync re-parses the JSONL files and repopulates `raw_content` for changed-or-new sessions

#### Scenario: fts-raw mode does not write hybrid-fts.db

- **WHEN** the active mode is `fts-raw`
- **THEN** only `~/.pi/session-search/index/sessions-fts.db` is written
- **AND** `~/.pi/session-search/index/hybrid-fts.db` is not created or modified
- **AND** `~/.pi/session-search/index/session-index.json` is not created or modified

### Requirement: Sync semantics

The `sync()` method SHALL be incremental: discover all session JSONL files, identify by session UUID (read from JSONL header), and classify each into one of: unchanged, new, content-changed, moved, removed.

Change detection SHALL use file `sizeBytes` (not mtime) as the primary signal. A session is considered content-changed only if `sizeBytes` differs from the indexed value. A path change with unchanged size SHALL be classified as moved (metadata-only update, no re-parse).

The startup `sync()` SHALL be fire-and-forget with a 600s timeout. The periodic `sync()` SHALL run every 5 minutes via `setInterval`.

In `digest-hybrid` mode, content-changed sessions SHALL re-embed from the existing digest body (if any) and re-write both FTS columns (digest_body unchanged from current digest, raw_content recomputed from the new file content). Sessions without a digest are tracked but excluded from cosine ranking.

In `fts-raw` mode, content-changed sessions SHALL re-write the single FTS column from raw content. No embedding work occurs in `fts-raw`.

Sessions whose `parseSession` succeeds with `userMessageCount === 0` SHALL be persisted as metadata-only entries (no embedding, no FTS row) so that subsequent syncs do not retry them.

#### Scenario: Unchanged session is skipped

- **WHEN** an indexed session's file has the same `sizeBytes` and same path as last sync
- **THEN** sync skips it (no re-parse, no re-embed, no digest update)

#### Scenario: Content-changed session is re-ingested in digest-hybrid mode

- **WHEN** an indexed session's file has a different `sizeBytes` than last sync
- **AND** mode is `digest-hybrid`
- **THEN** sync re-parses the file, re-embeds the existing `digest.body` if present, and re-writes both `digest_body` and `raw_content` FTS columns

#### Scenario: Content-changed session is re-ingested in fts-raw mode

- **WHEN** an indexed session's file has a different `sizeBytes` than last sync
- **AND** mode is `fts-raw`
- **THEN** sync re-parses the file and re-writes the single raw-content FTS column
- **AND** no embedding work occurs

#### Scenario: Moved session keeps embedding

- **WHEN** a session moves from `~/.pi/agent/sessions/X.jsonl` to `~/.pi/agent/sessions-archive/X.jsonl` with no size change
- **THEN** sync updates the indexed `file` and `archived` fields
- **AND** the embedding and digest are preserved

#### Scenario: Removed session is dropped

- **WHEN** an indexed session UUID is no longer present in any discovered JSONL file
- **THEN** sync removes it from `session-index.json`, `hybrid-fts.db`, and `sessions-fts.db`
- **AND** the on-disk digest file at `~/.pi/session-search/digests/<uuid>.json` is preserved

#### Scenario: Zero-user-message session is persisted as metadata-only

- **WHEN** sync encounters a JSONL file whose `parseSession()` returns a `ParsedSession` with `userMessageCount === 0`
- **THEN** the session is persisted to the index as a metadata-only entry (no embedding, no FTS row)
- **AND** subsequent syncs see matching `sizeBytes` and skip the session

### Requirement: INDEX_VERSION 4 migration

The system SHALL bump `INDEX_VERSION` from `4` to `5`. On load, `migrateIndexFileIfStale` SHALL detect five migration cases. ANY `version !== 5` triggers a wipe (the FTS schema changed across the board); `lastMode` discriminates only the user-facing notify text.

1. `version === 4` AND `lastMode === "hybrid-raw"` AND post-migration verdict resolves to `digest-hybrid`: wipe `session-index.json` AND `hybrid-fts.db`. Notify: `"session-search: hybrid-raw mode removed in v3.0.0; index reset; embeddings will rebuild from existing digests on next sync."`
2. `version === 4` AND `lastMode === "hybrid-raw"` AND post-migration verdict resolves to `misconfigured`: wipe `session-index.json` AND `hybrid-fts.db`. The misconfigured-verdict path takes over and emits its own remediation notify; this case does NOT emit the rebuild-promise notify (which would lie to the user).
3. `version === 4` AND `lastMode === "digest-mode"`: FTS schema changed (added `raw_content` column). Wipe both files. Notify: `"session-search: index format upgraded to v5; rebuilding from existing digests on next sync."`
4. `version === 4` AND `lastMode === undefined` (early v4 file before lastMode tracking): wipe both files. Notify: `"session-search: index format upgraded to v5."`
5. `version <= 3`: legacy format. Wipe all index files (existing pre-v4 path). Existing notify text.

In all cases, `~/.pi/session-search/digests/*.json` and `~/.pi/session-search/digests/*.state.json` SHALL be preserved. Digests are durable LLM artifacts and the digest schema is unchanged in v3.0.0.

Migration code SHALL read `lastMode` from disk as `string | undefined`, NOT as the narrowed `Mode` type, because the legacy literals `"hybrid-raw"` and `"digest-mode"` are no longer members of `Mode` after the type narrowing in this change.

The mode literal `"digest-mode"` SHALL be removed from the codebase. The literal `"hybrid-raw"` SHALL only appear in migration-detection code (read-only string comparison against legacy disk state). The new on-disk literal for `lastMode` SHALL be `"digest-hybrid"`.

**Two-phase migration with FTS-first ordering and explicit transactions**: `migrateIndexFileIfStale` SHALL execute in this order:
1. Phase 1 — FTS rebuild (atomic via SQLite transaction): open `hybrid-fts.db`; execute `BEGIN; DROP TABLE IF EXISTS s; CREATE VIRTUAL TABLE s USING fts5(digest_body, raw_content, ..., tokenize='porter unicode61'); COMMIT;` close handle. The transaction guarantees that a kill mid-Phase-1 leaves the FTS db in either the pre-Phase-1 state (rollback on uncommitted) or the post-CREATE state, never an intermediate.
2. Phase 2 — JSON write: write `session-index.json` atomically (temp file then rename) with `{version: 5, vectorDim: 0, lastMode: undefined, sessions: {}}`.

If the process is killed between Phase 1 and Phase 2, the next load SHALL re-enter Phase 1 (idempotent: drops the v5 table and recreates it; the schema introspection self-heal also covers this case) and complete Phase 2.

If Phase 1 throws (disk full, permissions, db locked), the migration SHALL abort cleanly: `session-index.json` stays at its pre-migration version, the FTS db is unchanged (transaction rolled back), the extension emits an error notify identifying the failure and recommended user action ("session-search: migration failed: <error>; resolve and restart pi"), and the verdict resolves as if the migration had not happened. Next load retries the migration.

**FTS schema introspection self-heal**: `FtsSide` (or its host class on construction / first load) SHALL validate the table `s` matches the expected v5 schema. Validation SHALL use both:
1. `PRAGMA table_xinfo('s')` to assert column names and order match `digest_body`, `raw_content`, plus auxiliary columns (this is robust to whitespace and quote-style variations in the original `CREATE` statement).
2. A one-row tokenizer probe (`INSERT INTO s(rowid, digest_body) VALUES (-1, 'gpt-5.4-nano ENOENT'); ...query for the probe terms; DELETE WHERE rowid=-1`) to assert the tokenizer behaves as expected. This catches cases where the column set is correct but the tokenizer was declared differently.

Three branches:
- No row returned by `SELECT sql FROM sqlite_master WHERE name='s'` (no `s` table): `CREATE VIRTUAL TABLE s USING fts5(...)` with v5 schema.
- Validation passes (column shape AND tokenizer probe): no-op.
- Validation fails: `DROP TABLE s` then recreate with v5 schema.

This self-heals interrupted migrations AND manual schema drift (file copy from another version, downgrade-then-upgrade cycle, future contributor rewriting the `CREATE` with different quote style).

**`createEmbedder` ordering**: `createEmbedder(config.embedder, ...)` SHALL run BEFORE `resolveModeVerdict`. This ensures that legacy-config rejection notifies (e.g., `"legacy embedder type 'bedrock' is no longer supported..."`) fire regardless of the eventual verdict. The verdict resolver consumes the embedder-construction outcome (`null` if rejected, `Embedder` if successful) as one of its inputs.

**Atomic JSON write**: `SessionIndex.save()` SHALL write `session-index.json` via temp-file-then-rename (e.g., `writeFileSync(path + '.tmp', data); rename(path + '.tmp', path)`). Power loss between truncate and full write of the real file would otherwise yield a 0-byte file.

#### Scenario: Legacy hybrid-raw + valid digest config → wipe with rebuild-promise notify

- **WHEN** the extension loads with `session-index.json` of `version: 4` and `lastMode: "hybrid-raw"`
- **AND** the post-migration verdict resolves to `digest-hybrid` (both embedder and digest model are now configured)
- **THEN** `session-index.json` is rewritten with `{version: 5, vectorDim: 0, lastMode: undefined, sessions: {}}`
- **AND** `hybrid-fts.db` has its FTS5 virtual table dropped and recreated with the v5 two-column schema
- **AND** the user is notified: `"session-search: hybrid-raw mode removed in v3.0.0; index reset; embeddings will rebuild from existing digests on next sync."`
- **AND** `~/.pi/session-search/digests/*.json` is untouched
- **AND** the next sync repopulates the index from existing digests

#### Scenario: Legacy hybrid-raw + still-no-digest-model → wipe with misconfigured notify

- **WHEN** the extension loads with `session-index.json` of `version: 4` and `lastMode: "hybrid-raw"`
- **AND** the post-migration verdict resolves to `misconfigured` with `missing: "digest"` (embedder still configured but no digest model resolvable)
- **THEN** `session-index.json` is rewritten with `{version: 5, vectorDim: 0, lastMode: undefined, sessions: {}}`
- **AND** `hybrid-fts.db` is wiped
- **AND** the user-facing notify is the misconfigured remediation message (NOT the rebuild-promise message, which would lie about something the misconfigured verdict cannot do)
- **AND** the persistent status line is set to the misconfigured message
- **AND** the recovery commands `/session:embedder` and `/session:summarizer` are registered so the user can fix their config from inside pi

#### Scenario: Legacy digest-mode index is wiped on first v3.0.0 load

- **WHEN** the extension loads with `session-index.json` of `version: 4` and `lastMode: "digest-mode"`
- **THEN** `session-index.json` is rewritten with `{version: 5, vectorDim: 0, lastMode: undefined, sessions: {}}` (lastMode is set to the new literal `"digest-hybrid"` on next save)
- **AND** `hybrid-fts.db` is rebuilt with the v5 two-column schema
- **AND** the user is notified: `"session-search: index format upgraded to v5; rebuilding from existing digests on next sync."`
- **AND** the next sync re-embeds + re-FTS-indexes from existing digests
- **AND** `~/.pi/session-search/digests/*.json` is untouched

#### Scenario: lastMode undefined v4 file is wiped (early v4 install)

- **WHEN** the extension loads with `session-index.json` of `version: 4` and `lastMode: undefined` (file written before the lastMode field landed)
- **THEN** `session-index.json` is wiped to v5 empty state
- **AND** `hybrid-fts.db` is wiped (FTS schema changed even if lastMode was never tracked)
- **AND** the user is notified: `"session-search: index format upgraded to v5."`
- **AND** the next sync repopulates the index based on the resolved verdict

#### Scenario: Migration interrupted between Phase 1 and Phase 2 self-heals

- **WHEN** `migrateIndexFileIfStale` completes Phase 1 (FTS COMMIT) but the process is killed before Phase 2 (JSON write)
- **AND** the extension is restarted
- **THEN** the next load sees `session-index.json` still at `version: 4`
- **AND** `migrateIndexFileIfStale` re-enters Phase 1 (DROP + CREATE is idempotent on the already-v5 FTS schema)
- **AND** Phase 2 completes, writing `session-index.json` to v5
- **AND** the user does not observe any corruption

#### Scenario: Migration interrupted DURING Phase 1 transaction self-heals

- **WHEN** `migrateIndexFileIfStale` opens `hybrid-fts.db` and executes `BEGIN; DROP TABLE IF EXISTS s;` but the process is killed before `CREATE VIRTUAL TABLE` or `COMMIT`
- **THEN** SQLite rolls back the uncommitted transaction on next open: the `s` table state matches the pre-Phase-1 state
- **AND** the next load sees `session-index.json` at `version: 4` (Phase 2 never ran)
- **AND** `migrateIndexFileIfStale` re-enters Phase 1 cleanly
- **AND** Phase 2 completes

#### Scenario: Migration aborts cleanly on Phase 1 failure (e.g., disk full)

- **WHEN** Phase 1's `CREATE VIRTUAL TABLE` throws because the disk is full
- **THEN** the SQLite transaction rolls back
- **AND** `session-index.json` stays at its pre-migration version
- **AND** the extension emits `ctx.ui.notify("session-search: migration failed: <error message>; resolve disk space and restart pi.", "error")`
- **AND** the extension does NOT proceed to verdict resolution against the new schema
- **AND** next load (after disk space resolved) retries the migration cleanly

#### Scenario: FTS schema introspection self-heals manual schema drift

- **WHEN** `hybrid-fts.db` exists with the v4 single-column FTS schema (e.g., copied from a v2.x install)
- **AND** `session-index.json` exists at `version: 5`
- **THEN** on next load, `FtsSide` introspects `sqlite_master.sql` for table `s`
- **AND** detects the column declaration does not match the v5 schema
- **AND** drops table `s` and recreates with the v5 column set
- **AND** subsequent inserts succeed

#### Scenario: Digests survive INDEX_VERSION bump

- **WHEN** `~/.pi/session-search/digests/abc-123.json` exists from a prior install
- **AND** the index is reset due to INDEX_VERSION 4→5 bump
- **AND** the session file `abc-123` is rediscovered during sync
- **THEN** the existing digest is reused (no LLM call)
- **AND** the indexer embeds and FTS-indexes the existing `digest.body` AND writes raw content to the new column

### Requirement: Vector dimension stability

The `session-index.json` SHALL track `vectorDim: number` at the root. On load:

1. Read current effective embedding dimension from the embedder config (or set `vectorDim: 0` initial sentinel if no embeddings have been written yet).
2. If `data.vectorDim !== 0 && data.vectorDim !== effectiveDim`, the index is dirty: all stored embeddings are stale.
3. Mark all sessions for re-embed; emit `ctx.ui.notify("session-search: embedding dimension changed; re-embedding all sessions.", "info")`.
4. The next `sync()` re-embeds against the current dimension, then updates `vectorDim` in the file.

The `cosineSimilarity(a, b)` function SHALL throw if `a.length !== b.length`. Mixed-dimension comparisons MUST never silently produce wrong scores.

#### Scenario: Matching dimension load is idempotent

- **WHEN** `session-index.json` has `vectorDim: 1536` AND embedder config resolves to `dimensions: 1536`
- **THEN** load proceeds without re-embedding

#### Scenario: Mismatched dimension triggers re-embed

- **WHEN** `session-index.json` has `vectorDim: 1536` AND embedder config resolves to `dimensions: 512`
- **THEN** all sessions are marked dirty
- **AND** the user is notified
- **AND** the next `sync()` re-embeds and updates `vectorDim` to `512`

#### Scenario: Mixed-dimension cosine throws

- **WHEN** `cosineSimilarity([0.1, 0.2, 0.3], [0.1, 0.2])` is called
- **THEN** the function throws `Error("vector length mismatch")`

### Requirement: Backfill concurrency control

During `/session:backfill` execution, the indexes SHALL set `backfillInProgress = true`. The periodic 5-minute `setInterval` `sync()` SHALL check this flag and return immediately without doing work while it is true. `addDigested(..., {batched: true})` SHALL update in-memory state only and defer the `session-index.json` disk write. The backfill loop SHALL call `index.flush()` every 25 successful digests AND on completion to persist the in-memory state.

#### Scenario: Periodic sync skipped during backfill

- **WHEN** `/session:backfill` is mid-run
- **AND** the 5-minute periodic sync timer fires
- **THEN** the periodic sync returns immediately without parsing files or writing to disk

#### Scenario: Backfill flushes index periodically

- **WHEN** backfill has completed 25 successful digests since the last flush
- **THEN** `index.flush()` is called
- **AND** `session-index.json` on disk reflects the in-memory state

#### Scenario: Backfill flushes index on completion

- **WHEN** backfill completes (whether successful or interrupted)
- **THEN** `index.flush()` is called once more
- **AND** `backfillInProgress` is reset to `false`

### Requirement: Path traversal guard

When resolving a session path provided by the LLM via `session_read`, the indexer SHALL validate that the resolved absolute path lies within an allowed root: `~/.pi/agent/sessions/`, `~/.pi/agent/sessions-archive/`, or any directory listed in `extraSessionDirs` / `extraArchiveDirs`.

Paths outside these roots SHALL be rejected with a clear error message.

#### Scenario: Allowed path is read

- **WHEN** `session_read` is called with `~/.pi/agent/sessions/--Users-x--/2026-04-29.jsonl`
- **THEN** the file is read

#### Scenario: Disallowed path is rejected

- **WHEN** `session_read` is called with `/etc/passwd`
- **THEN** the call returns "Access denied: path is outside the allowed session directories"
- **AND** no file read is attempted


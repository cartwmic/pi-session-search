# session-indexing Specification

## Purpose
TBD - created by archiving change add-digest-driven-indexing. Update Purpose after archive.
## Requirements
### Requirement: Mode auto-detection

The indexing layer SHALL operate in one of three modes, selected automatically based on configuration. There is no user-facing mode toggle.

| Config state                                                | Mode                |
|-------------------------------------------------------------|---------------------|
| no embedder                                                 | `fts-raw`           |
| embedder configured, no digest model resolvable             | `hybrid-raw`        |
| embedder configured AND digest model resolvable             | `digest-mode`       |

In `fts-raw` and `hybrid-raw` modes the system SHALL preserve upstream pi-session-search semantics (FTS5 over raw user messages, optional hybrid embedding of raw content). In `digest-mode` the system SHALL embed and FTS-index `digest.body` instead of raw content.

#### Scenario: No embedder → fts-raw mode

- **WHEN** `~/.pi/session-search/config.json` has no `embedder` field
- **THEN** the active index is `FtsSessionIndex` indexing raw user messages via `buildContent(session)`

#### Scenario: Embedder + no digest model → hybrid-raw mode

- **WHEN** `~/.pi/session-search/config.json` configures an embedder
- **AND** no digest model is resolvable from the model registry and no explicit digest model is configured
- **THEN** the active index is `SessionIndex` embedding raw content via `buildEmbeddingText(session)`

#### Scenario: Embedder + digest model → digest-mode

- **WHEN** an embedder is configured AND a digest model is resolvable
- **THEN** the active index embeds `digest.body` and FTS-indexes `digest.body`
- **AND** sessions with no digest yet are still listed in `session_list` (using `firstUserMessage` fallback display) but excluded from `session_search` ranking until they have a digest

### Requirement: Index storage layout

The index data SHALL live under `~/.pi/session-search/`:

- `config.json` — embedder + extra-dirs config (existing, unchanged shape)
- `digest.json` — digest config (new)
- `digests/<session-uuid>.json` — per-session durable digests (new)
- `index/sessions-fts.db` — SQLite FTS5 DB used in `fts-raw` mode
- `index/hybrid-fts.db` — SQLite FTS5 side-car used in `hybrid-raw` and `digest-mode`
- `index/session-index.json` — JSON metadata + base64 embeddings + `vectorDim`, used in `hybrid-raw` and `digest-mode`

In `digest-mode`, the FTS5 `content` column SHALL contain `digest.body`. In `hybrid-raw` mode it SHALL contain the upstream `buildContent(session)` output — byte-identical to upstream's function output for the same `ParsedSession` input.

The `session-index.json` v4 schema SHALL include a top-level `vectorDim: number` field recording the dimension of all stored embeddings (or `0` for fresh / empty indexes).

#### Scenario: Digest mode populates content from digest.body

- **WHEN** the indexer runs in `digest-mode` for a session with `digest.body = "Refactored auth module..."`
- **THEN** the FTS5 `content` column for that session contains `"Refactored auth module..."`
- **AND** the embedding vector is the result of `embedder.embed(digest.body)`

#### Scenario: Per-session digest file is independent of index DB

- **WHEN** the user deletes `~/.pi/session-search/index/` entirely
- **AND** the user runs `/session-reindex`
- **THEN** the indexer reads digests from `~/.pi/session-search/digests/<uuid>.json`
- **AND** rebuilds the index DB without re-running any LLM calls

### Requirement: Sync semantics

The `sync()` method SHALL be incremental: discover all session JSONL files, identify by session UUID (read from JSONL header), and classify each into one of: unchanged, new, content-changed, moved, removed.

Change detection SHALL use file `sizeBytes` (not mtime) as the primary signal. A session is considered content-changed only if `sizeBytes` differs from the indexed value. A path change with unchanged size SHALL be classified as moved (metadata-only update, no re-parse).

The startup `sync()` SHALL be fire-and-forget with a 600s timeout. The periodic `sync()` SHALL run every 5 minutes via `setInterval`.

#### Scenario: Unchanged session is skipped

- **WHEN** an indexed session's file has the same `sizeBytes` and same path as last sync
- **THEN** sync skips it (no re-parse, no re-embed, no digest update)

#### Scenario: Content-changed session is re-ingested

- **WHEN** an indexed session's file has a different `sizeBytes` than last sync
- **THEN** sync re-parses the file, re-embeds (in `digest-mode`: re-embeds the existing digest.body if no live digest update has fired; the digest builder's lifecycle handles digest staleness separately)

#### Scenario: Moved session keeps embedding

- **WHEN** a session moves from `~/.pi/agent/sessions/X.jsonl` to `~/.pi/agent/sessions-archive/X.jsonl` with no size change
- **THEN** sync updates the indexed `file` and `archived` fields
- **AND** the embedding and digest are preserved

#### Scenario: Removed session is dropped

- **WHEN** an indexed session UUID is no longer present in any discovered JSONL file
- **THEN** sync removes it from `session-index.json`, `hybrid-fts.db`, and `sessions-fts.db`
- **AND** the on-disk digest file at `~/.pi/session-search/digests/<uuid>.json` is preserved (digests are durable; they may be reused if the session reappears)

### Requirement: INDEX_VERSION 4 migration

The system SHALL bump `INDEX_VERSION` from `3` to `4`. On load, any v3 or earlier index data SHALL be discarded. The `session-index.json` (with new `vectorDim: 0` initial value), `hybrid-fts.db`, and `sessions-fts.db` files SHALL be rebuilt from scratch on next sync.

The `digests/` directory SHALL NOT be cleared — digests are persisted independently of the index DB and survive INDEX_VERSION bumps.

The user is responsible for running `/digest:backfill` post-migration if they want pre-existing sessions digested. New sessions get digests live via the `agent_end` lifecycle.

#### Scenario: v3 index is discarded on load

- **WHEN** the extension loads with a `session-index.json` of `version: 3`
- **THEN** the loaded data is `{version: 4, vectorDim: 0, sessions: {}}`
- **AND** both `sessions-fts.db` and `hybrid-fts.db` have their FTS5 virtual tables dropped and recreated empty (so v3 raw-content rows do not coexist with future v4 digest-content rows)
- **AND** the user is notified that the index was reset

#### Scenario: Digests survive INDEX_VERSION bump

- **WHEN** `~/.pi/session-search/digests/abc-123.json` exists from a prior install
- **AND** the index is reset due to INDEX_VERSION bump
- **AND** the session file `abc-123` is rediscovered during sync
- **THEN** the existing digest is reused (no LLM call)
- **AND** the indexer embeds and FTS-indexes the existing `digest.body`

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

During `/digest:backfill` execution, the indexes SHALL set `backfillInProgress = true`. The periodic 5-minute `setInterval` `sync()` SHALL check this flag and return immediately without doing work while it is true. `addDigested(..., {batched: true})` SHALL update in-memory state only and defer the `session-index.json` disk write. The backfill loop SHALL call `index.flush()` every 25 successful digests AND on completion to persist the in-memory state.

#### Scenario: Periodic sync skipped during backfill

- **WHEN** `/digest:backfill` is mid-run
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


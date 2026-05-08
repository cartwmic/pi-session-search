# Changelog

## [Unreleased] — structured logging + SQLite instrumentation

### Summary

Added a process-wide structured logger (pino + `rotating-file-stream`) so SQLite lock errors, transaction durations, digest failures, and backfill warnings are captured to a rotated file by default. Mirrors the `pi-claude-bridge` setup so both logs sit in `~/.pi/agent/` and are grep-friendly.

### What's new

- **`src/log.ts`** — lazy pino logger, JSON-per-line, default path `~/.pi/agent/session-search.log`, rotation at 10 MiB × 2 backups (≈30 MiB ceiling).
- **`dbCall(op, fields, fn)` helper** — wraps SQLite calls; logs `op`/`db`/`durationMs` on success, `code`/`errno`/`sqliteCode` on error. Wired through every transaction boundary, schema op, and search query in `FtsSide`, `FtsSessionIndex`, and the migration paths in `session-index.ts`.
- **Transaction safety** — every `BEGIN` block now has matching `ROLLBACK`-on-throw so a SQLITE_BUSY mid-transaction doesn't leak an open transaction across the next op.
- **Existing `console.warn` / `console.error` calls** in `digest/backfill.ts`, `digest/builder.ts`, `digest/config.ts`, and `index.ts` rewritten to structured `log.warn` / `log.error`.
- **Env vars** — see README § Environment Variables; key knobs are `PI_SESSION_SEARCH_DEBUG=0` to disable, `PI_SESSION_SEARCH_DEBUG_PATH` to relocate, `PI_SESSION_SEARCH_DEBUG_LEVEL` to widen/narrow.

### Dependencies added

- `pino` ^10.3.1
- `rotating-file-stream` ^3.2.9

### Test changes

- `__tests__/digest/config.test.ts` no longer stubs `console.warn`. It now sets `PI_SESSION_SEARCH_LOG_SYNC_FILE` (test-only sync sink, no rotation) and reads records back with `readFileSync`. The logger module exposes `PI_SESSION_SEARCH_LOG_RESET=1` so the cached destination can be rebuilt mid-process.

## [3.0.0] — 2026-05-06 — compact mode set (`remove-hybrid-raw-mode`)

### Breaking changes

- **`hybrid-raw` mode removed** — the three-mode system (`fts-raw`, `hybrid-raw`, `digest-mode`) is narrowed to two (`fts-raw`, `digest-hybrid`). Legacy `hybrid-raw` on-disk index files are wiped and rebuilt on first load.
- **`digest-mode` renamed to `digest-hybrid`** — all code, config, and type references updated. On-disk `digest-mode` values are accepted during migration and rewritten as `digest-hybrid`.
- **FTS schema upgrade** — two indexed columns (`digest_body`, `raw_content`) replace the single-column schema. `INDEX_VERSION` 4→5 triggers an unconditional wipe and rebuild on first load.
- **Partial-config now produces a misconfigured verdict** — exactly one of embedder / digest model configured no longer silently demotes to `fts-raw`; instead it pins a persistent error status and returns remediation for search/digest tool invocations.
- **Recovery commands always available** — `/session-embeddings-setup` and `/digest:settings` work in all three verdict states (valid fts-raw, valid digest-hybrid, misconfigured).
- **Calibrated BM25 weights** — `W_DIGEST=2.0`, `W_RAW=1.0` (normative invariant: `W_DIGEST > W_RAW`), validated by a mathematical-constraint unit test.
- **`pi.on` registration moved to module-load** — all handlers register exactly once per extension load, not per `session_start`. Prior per-`session_start` registration leaked handlers (append semantics with no unregister).
- **Async verdict resolution with bounded retry** — `resolveModeVerdict` retries once after ~1000ms if the digest model registry was not yet populated at initial check. Does not retry for `missing: "embedder"` (synchronous, cannot benefit).

## [2.0.0] — 2026-05-06 — digest-driven indexing (`add-digest-driven-indexing`)

### Summary

This change introduces LLM-distilled per-session digests as the primary indexed content surface, replacing raw transcript text with deliberate prose that improves both FTS5 and semantic recall. It also collapses the upstream multi-provider embedder to a single openai-compatible class.

### Design inspiration

The digest headline concept and `pi.setSessionName()` integration are inspired by [`pasky/pi-session-summary`](https://github.com/pasky/pi-session-summary) (467 LOC). That project has no LICENSE file; this implementation was written from scratch against a new spec rather than copied or derived from its source.

### What's new

- **SessionDigest schema** — `{body, headline, topics[], outcome?, generatedAt, modelId, inputTokenCount, cost}` stored at `~/.pi/session-search/digests/<uuid>.json`, independent of the index DB.
- **Digest builder** — calls a cheap auto-detected model via a `submit_digest` tool call; chooses incremental (prev-digest + delta) or full re-summarize mode based on `resummarizeTokenThreshold`; debounced 60 s after each `agent_end`, immediate on `session_compact`.
- **`pi.setSessionName(digest.headline)`** — digest headline written to the pi status bar on every successful digest write.
- **Three operating modes** — `fts-raw` (no embedder), `hybrid-raw` (embedder, no digest model), `digest-mode` (embedder + digest model); auto-detected from config, no toggle.
- **`/find-session` overlay** — interactive TUI card picker for session search and switching (parallel to `pi -r`; pi-mono exposes no `registerSessionSource` hook).
- **Slash commands** — `/digest:settings`, `/digest:update`, `/digest:show`, `/digest:rewrite`, `/digest:backfill`, `/digest:cost`.
- **Single openai-compatible embedder** — four upstream provider-specific code paths collapsed to one; AWS SDK peer dependencies removed.
- **`INDEX_VERSION` 3 → 4** — v3 index entries are discarded on load; run `/digest:backfill` post-upgrade to rebuild.

### Upstream divergence

**This fork (`cartwmic/pi-session-search`) is no longer merge-compatible with `samfoy/pi-session-search`.**

The `add-digest-driven-indexing` change rewrites the indexer, embedder, and extension entry point at a structural level. The module layout, config schema, and index storage format all differ. A three-way merge with upstream will produce conflicts in every substantive file. Future upstream syncs must be selective cherry-picks.

#### Rollback instructions

To fully revert this change and return to the v3 upstream-compatible state:

1. **Revert the code changes:**

   ```bash
   git revert <merge-commit-sha>
   # or, if applied as a series of commits:
   git revert HEAD~N..HEAD
   ```

2. **Clear the v4 index** — a reverted v3 codebase cannot read the v4 index file and will fail silently or corrupt state:

   ```bash
   rm -rf ~/.pi/session-search/index/
   ```

3. Restart pi. The v3 indexer will rebuild the index from scratch on startup.

> **Note**: Digests in `~/.pi/session-search/digests/` are harmless to leave in place after rollback — the v3 codebase ignores that directory. Remove them manually if desired.

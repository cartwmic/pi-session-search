# Changelog

## [Unreleased] — digest-driven indexing (`add-digest-driven-indexing`)

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

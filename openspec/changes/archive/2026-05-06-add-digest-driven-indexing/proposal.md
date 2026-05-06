## Why

The upstream `pi-session-search` indexer embeds raw session content (user messages, compaction summaries, truncated assistant text). Recall is poor because session JSONL is dominated by tool output and chain-of-thought scaffolding — low-signal noise that drowns the intentional content. This fork replaces the indexed text with **LLM-distilled per-session digests**, so embeddings and FTS5 both run over deliberate prose instead of a transcript dump.

A separate motivation: the upstream embedder ships four provider-specific code paths (openai, openai-compatible, mistral, bedrock, ollama). Three of them are redundant — Mistral and Ollama both expose `/v1/embeddings`, and Bedrock isn't openai-compatible without a LiteLLM proxy. This is a single-user fork; the cruft adds maintenance cost with no benefit.

## What Changes

- **Add a digest builder** that produces a `SessionDigest{body, headline, topics[], outcome?, ...}` per session via a cheap auto-detected model (gpt-5.4-nano / gpt-5.4-mini / claude-4-5-haiku / gemini-3-flash, in that priority order; user-overridable).
- **Replace the indexed content surface**: embedder mode embeds `digest.body`; FTS5 mode indexes `digest.body`. RRF k=60 fusion stays unchanged. Hybrid recall improves; storage shrinks because raw user messages and assistant text no longer go into the index.
- **Persist digests durably** in `~/.pi/session-search/digests/<uuid>.json`, separate from the index DB so `/digest:rewrite` and a future `session-reindex` can rebuild the index without re-spending LLM dollars.
- **Wire `pi.setSessionName(digest.headline)`** so the digest's display headline appears in pi's status bar and `pi -r` for free.
- **Lifecycle**: debounced (60s) digest update on `agent_end`, immediate update on `session_compact`, opt-in backfill of historical sessions via `/digest:backfill`. No automatic backfill on startup — `/digest:backfill` is the only path that touches old sessions. Backfill iterates **discovered session files on disk** (via the parser path), not index membership — un-digested sessions are still backfillable in `digest-mode`.
- **Two prompt modes**, gated by `resummarizeTokenThreshold` (10000 default): incremental update (previous digest + delta) below the threshold, full re-summarize (whole conversation, ignore previous digest) at/above. **BREAKING vs upstream behavior** in that prior digest text is overwritten on every successful update.
- **Slash commands**: `/digest:settings`, `/digest:update`, `/digest:show`, `/digest:rewrite`, `/digest:backfill`, `/digest:cost`.
- **`/find-session` overlay**: a parallel search overlay (samfoy's existing card UI, retooled), since pi-mono exposes no `registerSessionSource` hook for `pi -r`.
- **BREAKING — collapse the embedder** to a single `OpenAICompatibleEmbedder` against `/v1/embeddings`. Drop the bedrock path entirely (Titan needs AWS SDK signing, not openai-compat). Drop the mistral and ollama type-specific classes (their endpoints are openai-compatible; users configure them by setting the appropriate `baseUrl` against the openai-compatible embedder — the `EmbedderConfig` no longer carries a `type` discriminator at all). Remove the `@aws-sdk/client-bedrock-runtime` and `@aws-sdk/credential-providers` peer dependencies. The `/session-embeddings-setup` command loses its bedrock/mistral/ollama branches and becomes a flat 4-prompt walkthrough (`baseUrl`, `model`, `apiKey`/`apiKeyEnv`, optional `dimensions`).
- **Storage migration**: bump `INDEX_VERSION` from 3 to 4. v3 entries are dropped on load (existing embeddings were built on noisy raw content; cheaper to rebuild than to keep stale). The user manually runs `/digest:backfill` post-upgrade to repopulate.
- **Required for digest mode**: a configured embedder (in `~/.pi/session-search/config.json`) plus a digest model resolvable from `ctx.modelRegistry.getAvailable()`. Mode auto-detect: no embedder → `fts-raw`; embedder configured but no digest model resolvable → `hybrid-raw` (upstream behavior over raw content); embedder + digest model → `digest-mode`. Digest mode is purely additive. When `digestRequested === true` (predicate: `~/.pi/session-search/digest.json` exists in global or project scope, OR the digest config has explicit `provider`+`model` set) AND the model is not resolvable, the extension SHALL emit a per-process one-time `ctx.ui.notify(...)` on `session_start` so the user understands the silent degrade to `hybrid-raw`. The priority list being non-empty alone does NOT trigger the notification (a fresh install with no `digest.json` stays silent).

## Capabilities

### New Capabilities

- `session-digest`: LLM-distilled per-session digest — schema, generation lifecycle, prompt selection (incremental vs full), model auto-detection, cost tracking, durable per-session storage.
- `session-indexing`: Index storage and sync pipeline — mode auto-detection (no-embedder / embedder-no-digest / digest-mode), incremental sync semantics (size-based change detection, move detection, removal), `INDEX_VERSION 3→4` migration, hybrid-fts.db / sessions-fts.db / session-index.json layout.
- `session-search`: Search and browse tools — `session_search` (RRF over digest.body), `session_list` (filtered metadata browse), `session_read` (paginated conversation read with path-traversal guard), and the `/find-session` overlay.
- `session-embedder`: Single openai-compatible embedder — configuration shape, batch embedding, dimension passthrough, error handling.

### Modified Capabilities

<!-- None. This is the first openspec change in the repo; no pre-existing specs to modify. -->

## Impact

- **Code**: rewrites or replaces `src/session-index.ts` (moves to `src/index/`), `src/fts-index.ts` (moves to `src/index/`), `src/embedder.ts`, `src/index.ts` (extension entry, mode-aware wiring). `src/config.ts`, `src/parser.ts`, `src/reader.ts`, and `src/utils.ts` are **unchanged**: digest config lives in a new `~/.pi/session-search/digest.json` loaded by `src/digest/storage.ts`; the digest builder consumes parser output via a new `ConversationView` adapter rather than editing the parser itself. Adds `src/digest/{builder,schema,storage,lifecycle,model-resolver,cost-tracker,conversation-view}.ts` and `src/search/overlay.ts`. Existing tests in `src/__tests__/index.test.ts` need updates for new content shapes.
- **APIs**: tool contracts (`session_search`, `session_list`, `session_read`) keep the same parameter shapes; the displayed result content changes (digest summaries instead of compaction-summary slices). New slash commands listed above. `pi.setSessionName` is now driven by the extension whenever a digest writes successfully.
- **Dependencies**: removes `@aws-sdk/client-bedrock-runtime` and `@aws-sdk/credential-providers` from `optionalDependencies`. Adds `@mariozechner/pi-ai` (used to call the digest model via `complete()`).
- **Storage**: adds `~/.pi/session-search/digests/` directory. Bumps `INDEX_VERSION` 3→4 (hard reset of v3 indexes — user re-runs `/digest:backfill` post-upgrade).
- **Cost**: ~$0.001–0.005 per session for digest generation on the auto-detected cheap model class; embedding cost is negligible (< $0.01 for the entire ~2k-session corpus on `text-embedding-3-small`-class endpoints). Query cost is effectively zero.
- **Upstream divergence**: this fork stops being merge-compatible with `samfoy/pi-session-search`. Future upstream syncs will be selective cherry-picks, not three-way merges.
- **Out of scope** (deferred): pi-mono `registerSessionSource` integration for `pi -r` (file an upstream issue); per-thread / per-branch digest variants; cross-session topic clustering.

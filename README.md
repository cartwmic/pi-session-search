# pi-session-search

Index, digest, and search past [pi](https://github.com/badlogic/pi-mono) coding sessions. Works out of the box with zero configuration — FTS5 keyword search is always on. Add an embedder for hybrid search. Add a digest model to get LLM-distilled summaries that dramatically improve semantic recall.

## Features

- **Zero-config search** — FTS5 keyword search works immediately, no API keys or embedder needed
- **Hybrid search** — When an embedder is configured, combines cosine similarity + BM25 via Reciprocal Rank Fusion for best-of-both-worlds retrieval
- **Digest-driven indexing** — When a digest model is available, each session is distilled to a structured prose summary (`digest.body`) and a display headline (`digest.headline`); embeddings and FTS run over the digest instead of raw transcript noise
- **Browse & filter** — List sessions by project, date range, archive status (`session_list`)
- **Read conversations** — View the full conversation from any past session (`session_read`)
- **Session picker** — `/find-session` overlay for interactive search and session switching
- **Auto-indexing** — Parses JSONL session files on startup, tracks changes incrementally
- **Archive support** — Indexes both `~/.pi/agent/sessions/` and `~/.pi/agent/sessions-archive/`

## Operating Modes

The active mode is **auto-detected** from your configuration — no toggle needed.

| Mode | Condition | Search surface |
|------|-----------|----------------|
| `fts-raw` | No embedder configured | FTS5 over raw user messages |
| `hybrid-raw` | Embedder configured, no digest model | Embeddings + FTS5 over raw content (upstream behavior) |
| `digest-mode` | Embedder + resolvable digest model | Embeddings + FTS5 over `digest.body` (best recall) |

Mode degrades gracefully: removing the embedder falls back to `fts-raw`; a digest model that can't be resolved falls back to `hybrid-raw` (with a one-time warning if `digest.json` exists).

## Install

```bash
pi install pi-session-search
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-session-search"]
}
```

Requires **Node 22.5+** (`node:sqlite` is used for FTS5). Node 24+ is recommended.

## Setup

### Embedder (optional — enables hybrid search)

Run `/session-embeddings-setup` in pi. The wizard asks four questions:

1. **Base URL** — e.g. `https://api.openai.com` (default)
2. **Model** — e.g. `text-embedding-3-small`
3. **API key / env var** — literal key or env-var name like `OPENAI_API_KEY`
4. **Dimensions** — optional; leave blank to use the model default

Config is written to `~/.pi/session-search/config.json`:

```json
{
  "embedder": {
    "baseUrl": "https://api.openai.com",
    "model": "text-embedding-3-small",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

Any provider that exposes a standard `/v1/embeddings` endpoint works — Together, Fireworks, vLLM, LiteLLM, Anyscale, etc. Set `baseUrl` accordingly.

### Digest model (optional — enables digest-mode)

Requires an embedder to be configured first. The digest builder auto-detects a cheap model from your configured providers (priority: `gpt-5.4-nano` → `gpt-5.4-mini` → `claude-haiku-4-5` → `gemini-3-flash-preview`). To override, create `~/.pi/session-search/digest.json`:

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.4-mini",
  "debounceSeconds": 60,
  "resummarizeTokenThreshold": 10000,
  "maxTokens": 1500,
  "showWidget": false,
  "verbose": false
}
```

All fields except `provider`/`model` are optional (shown with defaults). Run `/digest:settings` to create the file with defaults in place.

After setup, run `/digest:backfill` to digest historical sessions. New sessions are digested live with a 60-second debounce after each agent turn.

## Usage

### Search
```
session_search(query="how did we debug the Lambda timeout")
session_search(query="CI pipeline configuration", limit=5)
```

### Browse sessions
```
session_list(project="Rosie", after="2026-03-01")
session_list(archived=true, limit=20)
```

### Read a session
```
session_read(session="<file-path-or-uuid>")
session_read(session="<id>", offset=50, limit=50)
```

### Interactive session picker
```
/find-session auth refactor
```

Opens a scrollable card overlay. Select a card to switch to that session.

## Commands

### Embedder & index

| Command | Description |
|---------|-------------|
| `/session-embeddings-setup` | Configure the embedder (flat 4-prompt walkthrough) |
| `/session-sync` | Force an immediate incremental re-sync |
| `/session-reindex` | Force a full re-index of all sessions |

### Digest

| Command | Description |
|---------|-------------|
| `/digest:settings` | Show the effective config; create `digest.json` with defaults if absent |
| `/digest:show` | Show the current session's stored digest |
| `/digest:update` | Trigger an immediate digest write for the current session |
| `/digest:rewrite` | Force a full re-summarize (ignores prior digest) |
| `/digest:backfill` | Digest all historical sessions that lack a digest |
| `/digest:cost` | Show LLM token and cost usage for this process |

### Session picker

| Command | Description |
|---------|-------------|
| `/find-session [query]` | Open the interactive session search overlay |

## How It Works

### FTS-raw mode (default, zero config)

1. On startup, discovers all `.jsonl` session files
2. Parses each session to extract user messages, compaction summaries
3. Indexes content into an FTS5 virtual table with Porter stemming
4. Queries use BM25 ranking

### Hybrid-raw mode (embedder configured)

Everything above, plus an embedding vector per session built from raw content. At query time, cosine similarity and BM25 are fused via **Reciprocal Rank Fusion** (k=60) — same as upstream.

### Digest mode (embedder + digest model)

The digest builder runs after each agent turn (debounced 60 s) and on session compact:

1. Chooses **incremental** or **full** prompt based on tokens since last write vs. `resummarizeTokenThreshold`
2. Calls the resolved cheap model via a `submit_digest` tool call — structured output, no free-form parsing
3. Writes `SessionDigest{body, headline, topics[], outcome?}` to `~/.pi/session-search/digests/<uuid>.json`
4. Calls `pi.setSessionName(headline)` so the digest headline appears in the status bar and `pi -r`
5. Re-embeds `digest.body` and re-indexes it in FTS5

Digests are stored **independently of the index DB** — index rebuilds (e.g. on schema migration) re-read digests from disk without re-calling the LLM.

#### Why digests improve recall

Session JSONL is dominated by tool output and chain-of-thought scaffolding — low-signal noise that drowns intentional content in raw embedding space. The digest is 200–400 words of deliberate prose written by the model about what the session *was*. Both FTS and cosine similarity operate over that prose instead of a transcript dump.

### Indexing

- Index stored at `~/.pi/session-search/index/`
- Incremental sync on startup + every 5 minutes
- Two separate SQLite DBs: `sessions-fts.db` (FTS-only) and `hybrid-fts.db` (embedder mode)
- `INDEX_VERSION 4` — v3 entries are dropped on load (v3 embeddings were built on raw content; rebuilding against digest bodies gives better recall)

## Storage layout

```
~/.pi/session-search/
  config.json          # embedder config
  digest.json          # digest model config (optional)
  index/
    sessions-fts.db    # FTS5 database (fts-raw mode)
    hybrid-fts.db      # FTS5 + embedding sidecar (hybrid / digest mode)
    session-index.json # index metadata
  digests/
    <uuid>.json        # per-session SessionDigest
    <uuid>.state.json  # builder anchor state (survives process restart)
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | API key for OpenAI-compatible embedder if `apiKeyEnv` is set to this name |

## Migration from upstream

This fork (`cartwmic/pi-session-search`) diverges from `samfoy/pi-session-search` in the following ways:

### Removed provider-specific code paths

The upstream embedder shipped four provider-specific code paths. This fork collapses them to **one** (`openai-compatible`, against `/v1/embeddings`):

- The OpenAI-native class, the AWS-SDK-backed Titan path, and two endpoint-compatible classes have all been removed.
- The AWS SDK peer dependencies (`@aws-sdk/*`) are removed; the AWS-SDK-backed embedding path was their only consumer.
- Any provider whose embedding endpoint speaks the OpenAI `/v1/embeddings` format can be reached by setting `baseUrl` in the flat embedder config (see **Setup** above).
- The `EmbedderConfig` no longer carries a `type` discriminator. If your existing `config.json` has `"type": "openai-compatible"`, the field is silently ignored. Any other `type` value triggers a one-time warning and disables the embedder until you re-run `/session-embeddings-setup`.

### Index version bump

`INDEX_VERSION` moved from 3 to 4. Existing v3 index entries are discarded on load. Run `/digest:backfill` post-upgrade to rebuild.

### No merge compatibility

This fork is no longer merge-compatible with `samfoy/pi-session-search`. Future upstream syncs are selective cherry-picks only. See [CHANGELOG.md](./CHANGELOG.md) for rollback instructions.

## License

MIT

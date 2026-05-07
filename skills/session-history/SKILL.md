---
name: session-history
description: Search, browse, and read past pi coding sessions. Use when the user asks about previous work, past decisions, what was done before, or wants to find a specific session. Covers both active and archived sessions.
---

# Session History

Search, browse, and introspect on past pi coding sessions — including archived ones.

## Available Tools

This skill provides three tools:

### session_search
Semantic search across all indexed sessions. Use for finding sessions by topic, technology, or intent.

In **digest-hybrid** mode (the default when a digest model is available), results include the session's `digest.headline` (≤80 char display title) and a `digest.body` excerpt (200–400 word prose summary written by the LLM). In `fts-raw` mode, results show the raw first-user-message excerpt.

```
session_search(query="refactoring the auth module")
session_search(query="Lambda timeout debugging", limit=5)
session_search(query="setting up CI pipeline for Nessie")
```

### session_list
Browse sessions with filters. Good for time-based queries or project-specific browsing.

In digest-hybrid mode, listed sessions show `digest.headline` when available; un-digested sessions fall back to a truncated first user message with a `(no digest — run /digest:update)` suffix.

```
session_list(project="Rosie")                    # Sessions in the Rosie project
session_list(after="2026-03-01", limit=10)       # Recent sessions
session_list(archived=true, limit=20)            # Archived sessions only
session_list(project="pi-slack-bot", after="2026-03-10")
```

### session_read
Read the full conversation from a specific session. Use the file path or UUID from search/list results.

```
session_read(session="~/.pi/agent/sessions/--workplace-samfp-Rosie--/2026-03-10T21-36-44.jsonl")
session_read(session="124c2fe2-820c-4d63-8899-eb8d48007d39")
session_read(session="...", offset=50, limit=50)           # Pagination for long sessions
session_read(session="...", include_tools=true)             # Include tool call results
```

## Commands

| Command | Description |
|---------|-------------|
| `/find-session [query]` | Open the interactive session search overlay; select a card to switch to that session |
| `/session-embeddings-setup` | Configure the embedder for hybrid/digest search |
| `/session-sync` | Force an immediate incremental re-sync |
| `/session-reindex` | Force a full re-index of all sessions |
| `/digest:settings` | Show config; create `~/.pi/session-search/digest.json` with defaults if absent |
| `/digest:show` | Show the current session's stored digest |
| `/digest:update` | Trigger an immediate digest write for the current session |
| `/digest:rewrite` | Force a full re-summarize (ignores prior digest) |
| `/digest:backfill` | Digest all historical sessions that lack a digest |
| `/digest:cost` | Show LLM token and cost usage for this process |

## Workflow

1. **Find sessions**: Use `session_search` for semantic queries or `session_list` for browsing
2. **Interactive pick**: Use `/find-session <query>` to open a card overlay and switch directly
3. **Read details**: Use `session_read` with the file path from results to see the full conversation
4. **Extract context**: Use information from past sessions to inform current work

## Setup

Run `/session-embeddings-setup` to configure an embedding provider (any OpenAI-compatible `/v1/embeddings` endpoint). Then run `/digest:settings` and `/digest:backfill` to enable digest-hybrid mode for best recall.

To force a full re-index, run `/session-reindex`.

## What Gets Indexed

- All active sessions from `~/.pi/agent/sessions/`
- All archived sessions from `~/.pi/agent/sessions-archive/`
- **In digest-hybrid mode**: `digest.body` (LLM-written 200–400 word prose) and `digest.headline` (≤80 char title)
- **In fts-raw mode**: user messages, compaction summaries, files modified

## Tips

- In digest-hybrid mode, `session_search` result cards show `digest.headline` + a `digest.body` excerpt — this is what you want for "when did we…" and "what approach did we use for…" queries
- Session search is best for semantic queries; session list is best for "show me recent sessions" or "what did we work on in project X"
- For very long sessions, use `session_read` with pagination (`offset`/`limit`)
- Set `include_tools=true` on `session_read` when you need to see the actual tool outputs (verbose)
- Run `/digest:backfill` after first setup to digest historical sessions; new sessions are digested live automatically

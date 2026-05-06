## ADDED Requirements

### Requirement: session_search tool

The system SHALL register an LLM-callable tool `session_search` taking parameters `{query: string, limit?: number}` (limit clamped to ≤25, default 10).

In `digest-mode`, the tool SHALL search by RRF fusion (k=60) of cosine similarity over `digest.body` embeddings and BM25 over the FTS5 index of `digest.body`. The result text SHALL include the digest's `headline`, `topics`, and a body excerpt.

In `hybrid-raw` and `fts-raw` modes the tool SHALL preserve the upstream search behavior over raw content.

#### Scenario: Search returns digest-mode results

- **WHEN** `session_search(query: "auth refactor", limit: 5)` is called
- **AND** the index is in `digest-mode` with 50 sessions digested
- **THEN** the tool returns up to 5 results ranked by RRF
- **AND** each result shows the session's `digest.headline`, file path, ID, started date, and `digest.body` (truncated for display)

#### Scenario: Search with empty index in fts-raw / hybrid-raw mode

- **WHEN** `session_search` is called and the index is empty (size 0) in `fts-raw` or `hybrid-raw` mode
- **THEN** the tool returns "Session index is empty — it may still be building. Try again in a moment."
- **AND** does not throw

#### Scenario: Search with empty index in digest-mode

- **WHEN** `session_search` is called and zero sessions have digests in `digest-mode`
- **THEN** the tool returns "Session index is empty in digest mode. Run /digest:backfill to digest historical sessions, or wait for new sessions to be digested live."
- **AND** does not throw

#### Scenario: Limit is clamped to 25

- **WHEN** `session_search(query: "x", limit: 100)` is called
- **THEN** the tool returns at most 25 results

### Requirement: session_list tool

The system SHALL register an LLM-callable tool `session_list` taking parameters `{project?, after?, before?, archived?, limit?}` (limit clamped to ≤50, default 20).

The tool SHALL filter sessions by:
- `project`: case-insensitive substring match against `projectSlug` and `cwd`
- `after`/`before`: ISO date string comparison against `startedAt`
- `archived`: exact boolean match

Results SHALL be sorted by `startedAt` descending (newest first).

**In `digest-mode`, `session_list` SHALL list ALL discovered sessions, including un-digested ones.** Un-digested sessions display via `truncate(firstUserMessage, 60)` fallback with a `(no digest — run /digest:update)` suffix on the line. Only `session_search` ranking depends on digest presence; corpus browsing must work pre-backfill.

#### Scenario: Un-digested sessions are listed in digest-mode

- **WHEN** `session_list()` is called in `digest-mode`
- **AND** the corpus has 100 sessions, only 10 of which have digests
- **THEN** the tool returns up to 20 sessions sorted by `startedAt`, with un-digested entries showing `firstUserMessage` truncated and tagged `(no digest — run /digest:update)` (canonical suffix per tasks 6.9)

#### Scenario: Filter by project

- **WHEN** `session_list(project: "Rosie")` is called
- **THEN** results include only sessions whose `projectSlug` or `cwd` (case-insensitive) contains `"rosie"`

#### Scenario: Filter by date range

- **WHEN** `session_list(after: "2026-04-01", before: "2026-04-30")` is called
- **THEN** results include only sessions with `startedAt >= "2026-04-01"` AND `startedAt <= "2026-04-30"`

#### Scenario: Filter by archived

- **WHEN** `session_list(archived: true)` is called
- **THEN** results include only sessions with `archived: true`

### Requirement: session_read tool

The system SHALL register an LLM-callable tool `session_read` taking parameters `{session: string, offset?: number, limit?: number, include_tools?: boolean}` (limit clamped to ≤100, default 50; offset default 0; include_tools default false).

`session` SHALL accept either a session UUID (resolved via the index) or a file path (with `~` expansion). Resolved paths SHALL pass the path traversal guard from `session-indexing`.

The tool SHALL render the conversation as readable markdown including: header (id, started, cwd, total entries, current page), each user message with timestamp, each assistant message with model attribution and tool-call summaries, compaction summaries, branch summaries, and model-change events. When `include_tools=true`, tool result content (truncated to 500 chars per result) is also included.

#### Scenario: Read by UUID

- **WHEN** `session_read(session: "abc-123")` is called
- **AND** the index contains a session with id `abc-123` at file path `~/.pi/agent/sessions/X.jsonl`
- **THEN** the tool reads `~/.pi/agent/sessions/X.jsonl` and returns the formatted conversation

#### Scenario: Read by file path

- **WHEN** `session_read(session: "~/.pi/agent/sessions/X.jsonl")` is called
- **THEN** the tool expands `~` to `$HOME` and reads the file

#### Scenario: Read with pagination

- **WHEN** `session_read(session: "abc", offset: 50, limit: 50)` is called
- **AND** the session has 200 conversation entries
- **THEN** the output includes entries 51–100
- **AND** ends with a hint pointing to `offset=100`

#### Scenario: Disallowed path is rejected

- **WHEN** `session_read(session: "/etc/passwd")` is called
- **THEN** the tool returns the access-denied message from the path traversal guard

### Requirement: before_agent_start session primer

The extension SHALL inject a "Recent Sessions" section into the system prompt on `before_agent_start`, listing up to 5 recent sessions for the current project (falling back to global recent if the project filter is empty).

In `digest-mode` the primer line SHALL include the session's `digest.headline` instead of the raw first user message.

The primer SHALL be capped at 1500 characters total.

#### Scenario: Primer uses digest headline in digest-mode

- **WHEN** `before_agent_start` fires in `digest-mode` for a project with 5 prior sessions
- **AND** each session has a `digest.headline`
- **THEN** the primer lists each session by `digest.headline` (not by truncated first user message)

#### Scenario: Primer falls back to first user message in raw modes

- **WHEN** `before_agent_start` fires in `hybrid-raw` or `fts-raw` mode
- **THEN** the primer lists each session by `truncate(firstUserMessage, 80)`

#### Scenario: Primer has 1500-char cap

- **WHEN** the formatted primer would exceed 1500 chars
- **THEN** the primer is truncated to 1500 chars before being appended to the system prompt

### Requirement: /find-session overlay command

The system SHALL register a slash command `/find-session` that opens a TUI overlay (parallel to `pi -r`, since pi-mono exposes no `registerSessionSource` hook) showing search results in a card layout.

The overlay SHALL accept a query, run `session_search` with `limit: 25`, and render results as scrollable cards showing `digest.headline`, `digest.body` (truncated), session date, project, and a "Switch to this session" action that delegates to `ctx.switchSession(sessionPath)`.

#### Scenario: Overlay opens and shows results

- **WHEN** the user runs `/find-session auth refactor`
- **THEN** the overlay opens showing up to 25 cards ranked by RRF
- **AND** each card shows headline, body excerpt, date, project

#### Scenario: Overlay action switches session

- **WHEN** the user selects a card in the `/find-session` overlay and confirms
- **THEN** the extension calls `ctx.switchSession(sessionPath)` for that session
- **AND** the overlay closes

#### Scenario: Overlay shows empty-state for no results

- **WHEN** `/find-session totally-unique-string-no-session-has` returns 0 results
- **THEN** the overlay shows "No sessions match this query" and an OK action to dismiss

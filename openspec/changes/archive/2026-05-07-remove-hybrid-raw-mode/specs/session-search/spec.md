## MODIFIED Requirements

### Requirement: session_search tool

The system SHALL register an LLM-callable tool `session_search` taking parameters `{query: string, limit?: number}` (limit clamped to ≤25, default 10).

In `digest-hybrid` mode, the tool SHALL search by RRF fusion (k=60) of:
1. cosine similarity over `digest.body` embeddings (semantic channel), AND
2. weighted-column BM25 over the FTS5 sidecar with TWO indexed columns: `digest_body` and `raw_content`.

**Normative weight constraint**: `digest_body weight > raw_content weight`. The specific numeric ratio is implementation-defined and lives in design.md / CHANGELOG, NOT in spec scenarios. A calibration fixture under `tests/fixtures/bm25-corpus/` (synthetic, committed to the repo, with a held-out validation subset) MUST pass before v3.0.0 is tagged.

**Caveat on additivity**: FTS5 BM25 column scoring is additive across columns and over multiple matches. A query hitting `raw_content` many times with high IDF can outrank one hitting `digest_body` once. The "digest outranks raw" normative scenario applies ONLY when match counts and IDFs are comparable.

The result text SHALL include the digest's `headline`, `topics`, and a body excerpt. The result MUST NOT depend on whether the FTS hit was in `digest_body` or `raw_content` — both contribute to a single fused score.

In `fts-raw` mode the tool SHALL search via BM25 over the single raw-content FTS column (preserving prior `fts-raw` behavior).

**Module-load registration with verdict-aware body**: The `session_search` tool SHALL be registered ONCE at module load, regardless of the eventual verdict. The handler SHALL re-check `currentVerdict` at every invocation. If `currentVerdict.kind === "misconfigured"` at invocation, the handler SHALL return the verdict's `notifyMessage` as the tool result `content` and SHALL NOT execute search.

#### Scenario: Search returns digest-hybrid results fused across columns

- **WHEN** `session_search(query: "auth refactor", limit: 5)` is called
- **AND** the index is in `digest-hybrid` mode with 50 sessions digested
- **THEN** the tool returns up to 5 results ranked by RRF fusion of cosine + weighted BM25
- **AND** each result shows the session's `digest.headline`, file path, ID, started date, and `digest.body` (truncated)

#### Scenario: Literal term in raw content surfaces via raw_content column

- **WHEN** `session_search(query: "ENOENT 0x80000003", limit: 5)` is called
- **AND** the digest body for session X says "build failed" but session X's raw user messages contain the literal string "ENOENT 0x80000003"
- **THEN** session X appears in the results due to a BM25 hit on the `raw_content` column
- **AND** session X's score reflects the `raw_content` per-occurrence weight (lower than a digest_body hit would produce per the normative inequality, but non-zero)

#### Scenario: Single digest-body match outranks single raw-only match (comparable counts)

- **WHEN** `session_search(query: "authentication refactor", limit: 5)` is called
- **AND** session A has "authentication refactor" appearing exactly once in `digest_body` and zero times in `raw_content`
- **AND** session B has "authentication refactor" appearing exactly once in `raw_content` and zero times in `digest_body`
- **AND** sessions A and B have comparable token counts in both columns (within 2×)
- **THEN** session A ranks above session B in the FTS5 BM25 results, due to the normative inequality `digest_body weight > raw_content weight`

#### Scenario: Multi-hit-in-raw can outrank single-hit-in-digest (caveat documented)

- **WHEN** `session_search(query: "login", limit: 5)` is called
- **AND** session C has "login" appearing once in `digest.body`
- **AND** session D has "login" appearing 5 times in `raw_content` and zero times in `digest.body`
- **THEN** session D MAY rank above session C (additive BM25 scoring across columns can dominate the per-occurrence weight differential)
- **AND** this is acknowledged behavior, not a correctness bug; the calibration fixture exists to surface and tolerate these inversions

#### Scenario: Search with empty index in fts-raw mode

- **WHEN** `session_search` is called and the index is empty (size 0) in `fts-raw` mode
- **THEN** the tool returns "Session index is empty — it may still be building. Try again in a moment."
- **AND** does not throw

#### Scenario: Search with empty index in digest-hybrid mode

- **WHEN** `session_search` is called and zero sessions have digests in `digest-hybrid` mode
- **THEN** the tool returns "Session index is empty in digest-hybrid mode. Run /digest:backfill to digest historical sessions, or wait for new sessions to be digested live."
- **AND** does not throw

#### Scenario: Tool returns remediation message when invoked under misconfigured verdict

- **WHEN** the extension is loaded and the current verdict resolves to `misconfigured` (cold start OR warm-path transition; the registration model is identical)
- **AND** an LLM invokes `session_search`
- **THEN** the handler re-checks current verdict and returns the verdict's `notifyMessage` as the tool result `content`
- **AND** no search is performed
- **AND** the tool's registration in pi's tool registry remains intact (the tool is not unregistered between invocations)

#### Scenario: Limit is clamped to 25

- **WHEN** `session_search(query: "x", limit: 100)` is called
- **THEN** the tool returns at most 25 results

### Requirement: session_list tool

The system SHALL register an LLM-callable tool `session_list` taking parameters `{project?, after?, before?, archived?, limit?}` (limit clamped to ≤50, default 20). The tool is registered ONCE at module load. When `currentVerdict.kind === "misconfigured"` at invocation, the handler SHALL return the verdict's `notifyMessage` as the tool result `content` and SHALL NOT execute listing.

The tool SHALL filter sessions by:
- `project`: case-insensitive substring match against `projectSlug` and `cwd`
- `after`/`before`: ISO date string comparison against `startedAt`
- `archived`: exact boolean match

Results SHALL be sorted by `startedAt` descending (newest first).

**In `digest-hybrid` mode, `session_list` SHALL list ALL discovered sessions, including un-digested ones.** Un-digested sessions display via `truncate(firstUserMessage, 60)` fallback with a `(no digest — run /digest:update)` suffix on the line. Only `session_search` ranking depends on digest presence; corpus browsing must work pre-backfill.

**In `fts-raw` mode**, `session_list` displays sessions via `truncate(firstUserMessage, 60)` for every entry (no digest concept exists).

#### Scenario: Un-digested sessions are listed in digest-hybrid mode

- **WHEN** `session_list()` is called in `digest-hybrid` mode
- **AND** the corpus has 100 sessions, only 10 of which have digests
- **THEN** the tool returns up to 20 sessions sorted by `startedAt`, with un-digested entries showing `firstUserMessage` truncated and tagged `(no digest — run /digest:update)`

#### Scenario: Filter by project

- **WHEN** `session_list(project: "Rosie")` is called
- **THEN** results include only sessions whose `projectSlug` or `cwd` (case-insensitive) contains `"rosie"`

#### Scenario: Filter by date range

- **WHEN** `session_list(after: "2026-04-01", before: "2026-04-30")` is called
- **THEN** results include only sessions with `startedAt >= "2026-04-01"` AND `startedAt <= "2026-04-30"`

#### Scenario: Filter by archived

- **WHEN** `session_list(archived: true)` is called
- **THEN** results include only sessions with `archived: true`

#### Scenario: session_list returns remediation when invoked under misconfigured verdict

- **WHEN** the extension is loaded and the current verdict resolves to `misconfigured`
- **AND** an LLM invokes `session_list`
- **THEN** the handler returns the verdict's `notifyMessage` as the tool result `content`
- **AND** no listing is performed

### Requirement: before_agent_start session primer

The extension SHALL inject a "Recent Sessions" section into the system prompt on `before_agent_start`, listing up to 5 recent sessions for the current project (falling back to global recent if the project filter is empty). The handler is registered ONCE at module load. When `currentVerdict.kind === "misconfigured"` at invocation, the handler SHALL re-check verdict and return early without injecting any primer.

In `digest-hybrid` mode the primer line SHALL include the session's `digest.headline` instead of the raw first user message. In `fts-raw` mode the primer line SHALL include `truncate(firstUserMessage, 80)`.

The primer SHALL be capped at 1500 characters total.

#### Scenario: Primer uses digest headline in digest-hybrid mode

- **WHEN** `before_agent_start` fires in `digest-hybrid` mode for a project with 5 prior sessions
- **AND** each session has a `digest.headline`
- **THEN** the primer lists each session by `digest.headline`

#### Scenario: Primer falls back to first user message in fts-raw mode

- **WHEN** `before_agent_start` fires in `fts-raw` mode
- **THEN** the primer lists each session by `truncate(firstUserMessage, 80)`

#### Scenario: Primer not injected when invoked under misconfigured verdict

- **WHEN** the extension is loaded and the current verdict resolves to `misconfigured`
- **AND** a `before_agent_start` event fires
- **THEN** the handler (registered ONCE at module load) re-checks `currentVerdict` and returns early without injecting any primer
- **AND** no "Recent Sessions" section is appended to the system prompt

#### Scenario: Primer has 1500-char cap

- **WHEN** the formatted primer would exceed 1500 chars
- **THEN** the primer is truncated to 1500 chars before being appended to the system prompt

### Requirement: /find-session overlay command

The system SHALL register a slash command `/find-session` that opens a TUI overlay (parallel to `pi -r`, since pi-mono exposes no `registerSessionSource` hook) showing search results in a card layout. The command is registered ONCE at module load. When `currentVerdict.kind === "misconfigured"` at invocation, the handler SHALL emit the verdict's `notifyMessage` via `ctx.ui.notify` and SHALL NOT open the overlay.

The overlay SHALL accept a query, run `session_search` with `limit: 25`, and render results as scrollable cards showing `digest.headline` (or first-user-message fallback in `fts-raw`), body excerpt, session date, project, and a "Switch to this session" action that delegates to `ctx.switchSession(sessionPath)`.

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

#### Scenario: /find-session emits remediation when invoked under misconfigured verdict

- **WHEN** the extension is loaded and the current verdict resolves to `misconfigured`
- **AND** the user runs `/find-session some query`
- **THEN** the command handler (registered ONCE at module load) emits the verdict's `notifyMessage` via `ctx.ui.notify` and returns without opening the overlay

#### Scenario: Recovery commands work in misconfigured verdict

- **WHEN** the extension is loaded with verdict `misconfigured`
- **AND** the user runs `/session-embeddings-setup`
- **THEN** the command's interactive wizard runs normally, prompting the user to configure an embedder; on completion it writes `~/.pi/session-search/config.json` and prompts `/reload`
- **AND** the wizard does NOT short-circuit on the misconfigured verdict (recovery commands ARE the recovery affordance)
- **WHEN** the user runs `/digest:settings`
- **THEN** the command's interactive editor runs normally, allowing the user to set provider+model in `~/.pi/session-search/digest.json`

#### Scenario: Persistent status line semantics

- **WHEN** the extension loads with verdict `misconfigured` in a TUI deployment
- **THEN** `ctx.ui.setStatus("session-search", <misconfigured message>)` is called on every `session_start` (not just the first), so the status line survives `/reload` cycles
- **AND** any in-flight async callback from a prior boot generation that would call `setStatus` is short-circuited by the `bootGeneration` guard, leaving the misconfigured status intact

#### Scenario: Headless / RPC deployment behavior under misconfigured

- **WHEN** the extension loads with verdict `misconfigured` in a headless / RPC deployment where `setStatus` may not surface to a visible UI
- **THEN** the misconfigured signal is conveyed by `ctx.ui.notify` (error level)
- **AND** a `console.error(...)` line is emitted with the same remediation text (the structured-log convention; pi-coding-agent does not expose a dedicated logger in its public API)
- **AND** the absence of a visible status line is acknowledged as a known limitation of non-TUI deployments

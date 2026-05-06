# session-digest Specification

## Purpose
TBD - created by archiving change add-digest-driven-indexing. Update Purpose after archive.
## Requirements
### Requirement: SessionDigest schema

The system SHALL produce a `SessionDigest` object for each indexable session conforming to this schema:

```ts
interface SessionDigest {
  schemaVersion: 1;
  body: string;        // 200–400 words of plain prose; the embedding/FTS target
  headline: string;    // ≤80 chars; written to pi.setSessionName
  topics: string[];    // ≤5 short topic tags, each ≤32 chars
  outcome?: string;    // optional 1-sentence "what happened"
  generatedAt: string; // ISO-8601 timestamp
  modelId: string;     // "<provider>/<model-id>"
  inputTokenCount: number; // estimated tokens of conversation input that produced this digest
  cost: number;        // USD spent on the LLM call producing this digest
}
```

#### Scenario: Digest validates against schema

- **WHEN** the digest builder produces a `SessionDigest`
- **THEN** `body` is a non-empty string
- **AND** `headline` is non-empty and ≤80 characters
- **AND** `topics` is an array of 0–5 strings, each ≤32 characters
- **AND** `schemaVersion` equals `1`
- **AND** `generatedAt` parses as ISO-8601
- **AND** `modelId` matches the form `<provider>/<id>` with non-empty parts

#### Scenario: Tool-call validation failure rejected after retry

- **WHEN** the LLM's `submit_digest` tool call has arguments that fail TypeBox validation at the provider edge (e.g., `headline.length > 80`, missing `body` field)
- **THEN** the builder retries once with a stricter follow-up prompt referencing the validation error
- **AND** if the retry response also fails validation
- **THEN** the builder logs the error to `lastError` and emits no `SessionDigest`
- **AND** the prior digest (if any) is left untouched
- **AND** `pi.setSessionName` is not called

### Requirement: Cheap-model auto-detection

The digest builder SHALL resolve the LLM model from `ctx.modelRegistry.getAvailable()` using a priority list when no explicit `provider`+`model` is configured.

The default priority list SHALL be: `gpt-5.4-nano`, `gpt-5.4-mini`, `claude-4-5-haiku`, `gemini-3-flash` (in order).

If an explicit `provider` and `model` are set in the digest config, those take precedence and no auto-detection runs.

#### Scenario: Auto-detect picks first available model

- **WHEN** digest config has no `provider`/`model`
- **AND** `ctx.modelRegistry.getAvailable()` returns models including `gpt-5.4-mini` and `claude-4-5-haiku` but not `gpt-5.4-nano`
- **THEN** the resolver returns `gpt-5.4-mini` (highest-priority available)

#### Scenario: Explicit override skips auto-detect

- **WHEN** digest config sets `provider: "anthropic"` and `model: "claude-4-5-sonnet"`
- **AND** the priority-list models are also available
- **THEN** the resolver returns `anthropic/claude-4-5-sonnet`

#### Scenario: No suitable model available

- **WHEN** none of the priority-list models are available and no explicit config is set
- **THEN** the resolver returns `undefined`
- **AND** the lifecycle SHALL NOT call the LLM
- **AND** on `session_start` the extension emits ONE `ctx.ui.notify("session-search: digest mode unavailable — none of [<priority list>] are configured. Running in hybrid-raw mode.", "warning")` if `digestRequested === true` (see `digestRequested` predicate below)
- **AND** the extension falls back according to the mode matrix: if an embedder is configured the active mode is `hybrid-raw`; if no embedder is configured the active mode is `fts-raw`. The session-digest layer never alters this matrix — it only activates digest-mode when both an embedder AND a resolved digest model exist.

### Requirement: digestRequested predicate

The extension SHALL compute a `digestRequested: boolean` predicate to gate the one-time "digest mode unavailable" notification on `session_start`. The predicate is true if and only if:

- `~/.pi/session-search/digest.json` (global) OR `<cwd>/.pi/session-search/digest.json` (project) exists, OR
- the digest config (after merging defaults) has explicit `provider` and `model` fields set.

The priority list being non-empty SHALL NOT trigger the notification by itself — the user must have indicated digest intent via either an existing config file or explicit overrides.

#### Scenario: digestRequested true with config file

- **WHEN** `~/.pi/session-search/digest.json` exists with default-only contents
- **AND** `resolveModel(...)` returns `undefined`
- **THEN** `digestRequested === true`
- **AND** the one-time "digest mode unavailable" notification fires on `session_start`

#### Scenario: digestRequested false on fresh install

- **WHEN** no `digest.json` file exists in either global or project scope
- **AND** the extension loads on a fresh install
- **THEN** `digestRequested === false`
- **AND** the notification does NOT fire even when the priority list cannot be resolved (user has not asked for digests)

### Requirement: Incremental vs full prompt selection

The digest builder SHALL choose between two prompt modes on every digest write:

- **Full re-summarize**: input is the whole session conversation; the LLM ignores any prior digest.
- **Incremental update**: input is the previous `digest.body` plus only the conversation delta since the prior digest write; the LLM is instructed to repeat the previous digest verbatim unless something material changed.

Mode is gated by `tokensSinceLastDigestWrite >= resummarizeTokenThreshold` (default `10000`). If no prior digest exists, the mode SHALL be full.

After a successful digest write, `convTokensAtLastWrite` is reset to the current conversation token count, regardless of which mode was used.

#### Scenario: First digest is always full

- **WHEN** the lifecycle triggers a digest write for a session with no prior digest
- **THEN** the builder uses the full re-summarize prompt

#### Scenario: Small delta uses incremental mode

- **WHEN** a prior digest exists and `tokensSinceLastDigestWrite` is `2000` (below `10000` threshold)
- **THEN** the builder uses the incremental prompt
- **AND** the LLM input includes the previous `digest.body`
- **AND** `convTokensAtLastWrite` is reset to current conv tokens after the write

#### Scenario: Large delta triggers full re-summarize

- **WHEN** a prior digest exists and `tokensSinceLastDigestWrite` is `12000` (above `10000` threshold)
- **THEN** the builder uses the full re-summarize prompt
- **AND** the LLM input does not include the previous `digest.body`

### Requirement: Digest lifecycle triggers

The system SHALL trigger digest updates on the following events:

- `agent_end` — debounced by `debounceSeconds` (default `60`) per session.
- `session_compact` — immediate (no debounce); the compaction event materially changes the conversation shape.
- The `/digest:update` slash command — immediate, bypassing debounce.
- The `/digest:rewrite` slash command — immediate, forcing full re-summarize regardless of threshold.
- The `/digest:backfill` slash command — processes all sessions without a current digest, sequentially.

The lifecycle SHALL NOT trigger automatic digest updates on `session_start`. Backfill of historical sessions is opt-in via `/digest:backfill` only.

Only one digest LLM call may be in flight per session at a time. New triggers while a call is pending SHALL be coalesced (the most recent trigger wins; intermediate triggers discarded).

#### Scenario: Debounce prevents rapid-fire LLM calls

- **WHEN** two `agent_end` events fire 30 seconds apart for the same session
- **AND** `debounceSeconds` is `60`
- **THEN** the second event does not trigger an LLM call
- **AND** no digest is written for the second event

#### Scenario: session_compact bypasses debounce

- **WHEN** an `agent_end` fires at t=0 (digest written) and a `session_compact` fires at t=10s
- **THEN** the compaction triggers an immediate digest LLM call despite `debounceSeconds` not having elapsed

#### Scenario: No automatic backfill on startup

- **WHEN** the extension loads on `session_start` with `reason: "startup"`
- **AND** the index contains 100 sessions without digests
- **THEN** no digest LLM calls are made
- **AND** the user must invoke `/digest:backfill` to digest those sessions

### Requirement: Headline written to session name

The system SHALL call `pi.setSessionName(digest.headline)` after every successful digest write.

#### Scenario: Successful digest updates session name

- **WHEN** the builder produces a valid `SessionDigest{headline: "Refactor auth module to use bcrypt"}`
- **THEN** `pi.setSessionName("Refactor auth module to use bcrypt")` is called
- **AND** the headline appears in pi's status bar and `pi -r` picker

#### Scenario: Failed digest does not touch session name

- **WHEN** an LLM call fails or returns malformed output
- **THEN** `pi.setSessionName` is not called
- **AND** any pre-existing session name is preserved

### Requirement: Durable per-session digest storage

The system SHALL persist each `SessionDigest` to `~/.pi/session-search/digests/<session-uuid>.json` using atomic write (write-to-tmp-then-rename).

The on-disk digest file SHALL be the source of truth on extension reload — the index loads digests from these files, not from stale entries in the index DB.

#### Scenario: Digest survives extension reload

- **WHEN** a digest is written for session `<uuid>` at t=0
- **AND** the extension reloads at t=10
- **THEN** the digest is read from `~/.pi/session-search/digests/<uuid>.json` on reload
- **AND** no LLM call is required to recover it

#### Scenario: Atomic write prevents partial files

- **WHEN** a digest write is interrupted (process killed mid-write)
- **THEN** the on-disk file is either the prior valid digest or the new valid digest
- **AND** no partially-written JSON is observable

#### Scenario: /digest:rewrite replaces the on-disk file

- **WHEN** the user runs `/digest:rewrite` on a session with an existing digest
- **THEN** a new LLM call runs with the full re-summarize prompt
- **AND** the new digest atomically replaces the on-disk file
- **AND** the index is updated to embed the new `digest.body`

### Requirement: Cost tracking

The system SHALL accumulate per-session-since-startup cost data: number of LLM calls, total input/output tokens, total USD cost broken down by input / output / cache-read / cache-write.

The `/digest:cost` command SHALL render this as a single notification line including the resolved model name.

#### Scenario: /digest:cost reports zero before any calls

- **WHEN** the extension has just loaded and no digest LLM calls have been made
- **AND** the user runs `/digest:cost`
- **THEN** the command shows `0 calls | tokens: 0→0 | cost: $0`

#### Scenario: /digest:cost reflects accumulated usage

- **WHEN** the lifecycle has triggered 3 successful digest writes totaling 1500 input + 200 output tokens at $0.0042 total
- **AND** the user runs `/digest:cost`
- **THEN** the command shows `3 calls | tokens: 1500→200 | cost: $0.0042`
- **AND** the line includes the resolved model name (e.g. `openai-codex/gpt-5.4-nano`)

### Requirement: Tool-call digest delivery

The digest builder SHALL extract structured digest content from the LLM via a **tool call**, not free-form JSON parsing. The builder defines an internal `submit_digest` tool with TypeBox-typed parameters; the LLM is instructed to call this tool exactly once with the digest content.

**Tool definition** (TypeBox schema):

```ts
const DigestArgs = Type.Object({
  body: Type.String({ minLength: 50, description: "200–400 word prose summary..." }),
  headline: Type.String({ minLength: 1, maxLength: 80 }),
  topics: Type.Array(Type.String({ maxLength: 32 }), { maxItems: 5 }),
  outcome: Type.Optional(Type.String({ maxLength: 200 })),
});

const submitDigestTool: Tool<typeof DigestArgs> = {
  name: "submit_digest",
  description: "Submit the structured digest of this coding session. Call this tool exactly once.",
  parameters: DigestArgs,
};
```

**Builder flow:**

1. Construct `Context` with `systemPrompt` (instructions to call `submit_digest`), `messages` (the conversation view per incremental/full mode), and `tools: [submitDigestTool]`.
2. Call `complete(model, context, options)` with the AbortSignal-bearing options object.
3. Read `response.content` for the first entry of type `"toolCall"` with `name === "submit_digest"`. The `arguments` field is the digest payload, already validated against the TypeBox schema by pi-ai's provider transport.
4. Decorate `arguments` with metadata fields (`schemaVersion: 1`, `generatedAt: new Date().toISOString()`, `modelId: "<provider>/<id>"`, `inputTokenCount: estimateTokens(serializedConv)`, `cost: response.usage.cost.total`) to produce the final `SessionDigest`.
5. **Failure modes** (in order of likelihood):
   - No `toolCall` entry in `response.content` (LLM emitted text instead): retry once with a stricter prompt emphasizing "call the submit_digest tool, do not respond with text."
   - Tool call name is wrong (e.g., the LLM hallucinates): retry once.
   - Tool arguments fail TypeBox validation at the provider edge (rare with native tool-call format): retry once.
   - Multiple tool calls in `response.content`: take the first matching `submit_digest` call; ignore the rest.
   - Two consecutive failures: drop the digest, set `lastError`, leave prior digest untouched, do NOT call `pi.setSessionName`.

**Removed from the previous design** (no longer applicable):
- No JSON-only prompt instructions — tool-call format is provider-native.
- No markdown-fence stripping — tool arguments are structured objects.
- No `parseStreamingJson` ceremony — arguments arrive as `Record<string, any>`.
- No manual TypeBox-validate-then-retry-with-stricter-prompt dance — schema enforcement happens at provider transport.

#### Scenario: Successful tool-call digest

- **WHEN** `complete()` returns an `AssistantMessage` with `content: [{type: "toolCall", name: "submit_digest", arguments: {body: "...", headline: "...", topics: [...], outcome: "..."}}]`
- **THEN** the builder decorates the arguments with metadata fields and produces a valid `SessionDigest`
- **AND** `saveDigest` writes it; `pi.setSessionName(headline)` is called

#### Scenario: LLM emits text instead of tool call

- **WHEN** `complete()` returns an `AssistantMessage` with content that contains no `toolCall` entry of name `submit_digest`
- **THEN** the builder retries once with a stricter prompt: "You did not call the submit_digest tool. Call it now with the digest of this session. Do not respond with text."
- **AND** if the retry response also contains no `submit_digest` tool call
- **THEN** the builder logs the error to `lastError`, emits no `SessionDigest`, leaves prior digest untouched

#### Scenario: Multiple tool calls in one response

- **WHEN** the LLM emits multiple tool calls in `content`, including at least one `submit_digest`
- **THEN** the builder takes the first `submit_digest` call by `contentIndex` order
- **AND** ignores any other tool calls (no error, no warning)

### Requirement: Configuration

The digest config SHALL load from `~/.pi/session-search/digest.json` (global) merged on top of defaults, with `<cwd>/.pi/session-search/digest.json` (project override) merged on top of the global config.

The schema:

```ts
interface DigestConfig {
  provider?: string;             // optional override; auto-detect if absent
  model?: string;                // optional override; auto-detect if absent
  debounceSeconds: number;       // default 60
  resummarizeTokenThreshold: number; // default 10000
  maxTokens: number;             // default 1500 (covers structured JSON body + envelope + drift headroom)
  showWidget: boolean;           // default false
  verbose: boolean;              // default false
}
```

The `/digest:settings` slash command SHALL create the global file with defaults if it does not exist, and notify the user with the file path and a reminder to run `/reload`.

Config SHALL reload on `session_start` events.

#### Scenario: Project config overrides global

- **WHEN** global config sets `debounceSeconds: 60`
- **AND** project config at `<cwd>/.pi/session-search/digest.json` sets `debounceSeconds: 30`
- **THEN** the effective `debounceSeconds` for sessions in that cwd is `30`

#### Scenario: /digest:settings creates default file

- **WHEN** `~/.pi/session-search/digest.json` does not exist
- **AND** the user runs `/digest:settings`
- **THEN** the file is created with the default config
- **AND** the user is notified of the path

#### Scenario: Config reload picks up edits

- **WHEN** the user edits `~/.pi/session-search/digest.json` to set `debounceSeconds: 120`
- **AND** triggers `/reload` (which fires `session_start` with `reason: "reload"`)
- **THEN** subsequent `agent_end` events use the new debounce value


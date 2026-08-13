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

### Requirement: Explicit digest-model configuration

The digest builder SHALL resolve an LLM model only when both `provider` and `model` are explicitly configured in the effective digest config. It SHALL NOT scan, rank, or auto-select models from `ctx.modelRegistry.getAvailable()`.

When either field is absent, or the configured provider/model pair is unavailable, the resolver SHALL return `undefined`. Digest generation SHALL NOT dispatch a provider request unless the mode verdict is `digest-hybrid` and the configured model resolves.

#### Scenario: Missing configuration disables digest generation

- **WHEN** no global or project `digest.json` exists
- **AND** the model registry contains otherwise suitable models
- **THEN** the resolver returns `undefined`
- **AND** agent lifecycle events dispatch no digest request
- **AND** FTS raw indexing and search remain available
- **AND** the persistent `session-digest` footer says `Digest disabled: run /session:summarizer`
- **AND** the footer text is UI-only and never enters session content or the search index

#### Scenario: Partial configuration does not resolve

- **WHEN** digest config contains only `provider` or only `model`
- **THEN** the resolver returns `undefined`
- **AND** no registry model is selected as a fallback

#### Scenario: Explicit configuration resolves exact model

- **WHEN** digest config sets `provider: "anthropic"` and `model: "claude-4-5-sonnet"`
- **AND** that provider/model pair is available in the registry
- **THEN** the resolver returns `anthropic/claude-4-5-sonnet`

#### Scenario: Configured model unavailable after async retry

- **WHEN** both digest fields are configured but the matching model is not initially available
- **AND** the registry does NOT populate within the bounded retry window (~1000ms)
- **THEN** the resolver returns `undefined` after the retry
- **AND** the mode verdict is `misconfigured` with the appropriate missing component
- **AND** digest commands return actionable `/session:summarizer` remediation without dispatching a provider request

#### Scenario: Registry populates within retry window

- **WHEN** both digest fields are configured
- **AND** the matching registry model appears during the bounded retry
- **AND** an embedder is available
- **THEN** the verdict resolves to `digest-hybrid`
- **AND** digest lifecycle generation may run

### Requirement: digestRequested predicate

The extension SHALL compute a `digestRequested: boolean` predicate. The predicate is true if and only if:

- `~/.pi/session-search/digest.json` (global) OR `<cwd>/.pi/session-search/digest.json` (project) exists, OR
- the effective digest config has explicit `provider` and `model` fields set.

When `digestRequested` is false, the extension SHALL use `fts-raw` mode regardless of standalone embedder configuration. Missing digest configuration SHALL disable only digest-dependent functionality.

#### Scenario: digestRequested true with invalid config file

- **WHEN** a global or project `digest.json` exists but lacks a complete, resolvable provider/model pair
- **THEN** `digestRequested === true`
- **AND** the mode verdict is `misconfigured`
- **AND** recovery commands remain available

#### Scenario: digestRequested false on fresh install

- **WHEN** no `digest.json` file exists in either global or project scope
- **AND** the extension loads on a fresh install
- **THEN** `digestRequested === false`
- **AND** FTS raw indexing and search initialize normally
- **AND** digest commands explain that digests are disabled and direct the user to `/session:summarizer`

### Requirement: Incremental vs full prompt selection

The digest builder SHALL choose between two prompt modes on every digest write:

- **Full re-summarize**: input is the whole session conversation; the LLM ignores any prior digest. The schema-instruction text SHALL frame `headline` as a stable title describing the session as a whole — the through-line or overarching goal, not the latest activity — and SHALL instruct the model to treat the headline as sticky and resist drift.
- **Incremental update**: input is the previous `digest.body` AND the previous `digest.headline` plus only the conversation delta since the prior digest write. The user-message instruction SHALL tell the LLM to repeat the previous headline verbatim unless the session's overall topic has fundamentally pivoted, while leaving the body free to track new activity. The user-message instruction SHALL further tell the LLM to repeat the previous digest verbatim if nothing material changed.

Mode is gated by `tokensSinceLastDigestWrite >= resummarizeTokenThreshold` (default `10000`). If no prior digest exists, the mode SHALL be full.

After a successful digest write, `convTokensAtLastWrite` is reset to the current conversation token count, regardless of which mode was used.

#### Scenario: First digest is always full

- **WHEN** the lifecycle triggers a digest write for a session with no prior digest
- **THEN** the builder uses the full re-summarize prompt
- **AND** the system prompt's headline framing instructs the LLM to produce a stable, whole-session title

#### Scenario: Small delta uses incremental mode

- **WHEN** a prior digest exists and `tokensSinceLastDigestWrite` is `2000` (below `10000` threshold)
- **THEN** the builder uses the incremental prompt
- **AND** the LLM input includes the previous `digest.body`
- **AND** the LLM input includes the previous `digest.headline`
- **AND** the user-message instruction tells the LLM to keep the previous headline verbatim unless the session's overall topic has fundamentally pivoted
- **AND** `convTokensAtLastWrite` is reset to current conv tokens after the write

#### Scenario: Large delta triggers full re-summarize

- **WHEN** a prior digest exists and `tokensSinceLastDigestWrite` is `12000` (above `10000` threshold)
- **THEN** the builder uses the full re-summarize prompt
- **AND** the LLM input does not include the previous `digest.body`
- **AND** the LLM input does not include the previous `digest.headline`

#### Scenario: Incremental mode with no material change repeats prior digest

- **WHEN** a prior digest exists, `tokensSinceLastDigestWrite` is below threshold, and the new messages contain no material change to the session's work
- **THEN** the LLM is instructed to repeat the previous digest verbatim
- **AND** the resulting `headline` equals the previous `headline`
- **AND** the resulting `body` equals the previous `body`

#### Scenario: Incremental mode with tactical activity preserves headline

- **WHEN** a prior digest exists with `headline: "Refactor auth module to use bcrypt"` and the new messages describe further refactoring work on the same auth module
- **THEN** the LLM is instructed via the user-message stickiness directive to keep the headline verbatim
- **AND** the resulting `headline` equals `"Refactor auth module to use bcrypt"`
- **AND** the resulting `body` MAY incorporate the new tactical detail

#### Scenario: Incremental mode with topic pivot allows headline change

- **WHEN** a prior digest exists with `headline: "Refactor auth module to use bcrypt"` and the new messages clearly pivot the session to a different topic (e.g., debugging an unrelated CI pipeline)
- **THEN** the user-message stickiness directive permits the LLM to change the headline
- **AND** the resulting `headline` MAY differ from the previous `headline`

### Requirement: Digest lifecycle triggers

The system SHALL trigger digest updates on the following events:

- `agent_end` — debounced by `debounceSeconds` (default `60`) per session.
- `session_compact` — immediate (no debounce); the compaction event materially changes the conversation shape.
- The `/session:update` slash command — immediate, bypassing debounce.
- The `/session:rewrite` slash command — immediate, forcing full re-summarize regardless of threshold.
- The `/session:backfill` slash command — processes all sessions without a current digest, sequentially.

The lifecycle SHALL NOT trigger automatic digest updates on `session_start`. Backfill of historical sessions is opt-in via `/session:backfill` only.

Only one digest LLM call may be in flight per session at a time (domain invariant 1). Concurrency between triggers SHALL be resolved by one of two caller-driven strategies, and never by a wall-clock deadline (domain invariant 4):

- **Coalescing (automatic triggers):** WHEN an `agent_end` or `session_compact` trigger fires WHILE a digest call is in flight, THE system SHALL mark the lifecycle dirty and return without issuing a parallel call; when the in-flight call settles, exactly one follow-up SHALL be scheduled after the coalescing tail delay if dirty (the most recent trigger wins; intermediate triggers discarded).
- **Supersession (slash-command triggers):** WHEN a `/session:update` or `/session:rewrite` trigger fires WHILE a digest call is in flight, THE system SHALL abort the in-flight call via `currentAbort`, clear `pendingCall`, and then fire the new digest immediately — it SHALL NOT wait on the in-flight call.

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
- **AND** the user must invoke `/session:backfill` to digest those sessions

#### Scenario: Automatic trigger while pending coalesces

- **WHEN** an `agent_end` trigger fires WHILE `pendingCall` is true
- **THEN** the lifecycle is marked dirty and no parallel `complete()` call is issued
- **AND** when the in-flight call settles, exactly one follow-up digest is scheduled

#### Scenario: Slash command supersedes an in-flight call

- **WHEN** a digest call is in flight (`pendingCall` is true)
- **AND** the user invokes `/session:update`
- **THEN** the in-flight call's `currentAbort` is aborted and `pendingCall` is cleared
- **AND** a new digest call is fired immediately without waiting on a deadline
- **AND** the persisted digest returned reflects the new call

#### Scenario: Slash command kills a wedged in-flight call

- **WHEN** a previous digest call is wedged (never returning) with `pendingCall` true
- **AND** the user invokes `/session:update`
- **THEN** the wedged call is aborted via `currentAbort` (killing the underlying process group)
- **AND** the new digest proceeds instead of the command hanging on a timer

### Requirement: Caller-driven cancellation without liveness timeouts

The system SHALL NOT use any wall-clock timer whose purpose is to detect a possibly-wedged in-flight digest call and abort or give up on it (constitution principle I; domain invariant 4). Recovery from a wedged call SHALL come only from caller-driven abort, supersession, or a lifecycle reaper.

THE system SHALL thread the in-flight call's `AbortController` signal (`ac.signal`) into `generateDigest` so that aborting `currentAbort` propagates to the underlying `complete()` call and kills its process group (domain invariant 2; constitution principle II).

WHEN `currentAbort` is aborted for an in-flight call, THE system SHALL treat that call as a failure: it SHALL leave the previously persisted digest unchanged, SHALL NOT call `setSessionName`, and SHALL clear `currentAbort` and `pendingCall` (domain invariants 2, 3, 6).

WHEN any lifecycle reaper runs — `session_shutdown`, `deactivate()`, or `dispose()` — WHILE a digest call is in flight, THE system SHALL abort `currentAbort` and clear `pendingCall`.

Functional debounce and coalescing tail-delay timers are scheduling-only and SHALL remain; they SHALL NOT abort or give up on an in-flight call (domain invariant 5).

#### Scenario: No wedge timeout aborts a healthy slow call

- **WHEN** a digest `complete()` call runs longer than any previous hard-timeout window (e.g. 60s) but is still streaming
- **THEN** no internal timer aborts the call
- **AND** the call completes normally and its digest is persisted

#### Scenario: Caller abort is treated as failure

- **WHEN** `currentAbort.abort()` is invoked for an in-flight digest call
- **THEN** `generateDigest` observes the aborted signal and the result is null
- **AND** `setSessionName` is not called and the prior persisted digest is preserved
- **AND** `pendingCall` is cleared

#### Scenario: Shutdown reaper aborts in-flight call

- **WHEN** `session_shutdown` fires WHILE a digest call is in flight
- **THEN** `currentAbort` is aborted (the signal becomes `aborted`)
- **AND** `pendingCall` is cleared and no further digest work is attempted

#### Scenario: Debounce timer is not a wedge timeout

- **WHEN** an `agent_end` fires within the debounce window
- **THEN** a scheduling timer is set for the remaining window
- **AND** that timer only fires the next digest; it never aborts an in-flight call

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

#### Scenario: /session:rewrite replaces the on-disk file

- **WHEN** the user runs `/session:rewrite` on a session with an existing digest
- **THEN** a new LLM call runs with the full re-summarize prompt
- **AND** the new digest atomically replaces the on-disk file
- **AND** the index is updated to embed the new `digest.body`

### Requirement: Cost tracking

The system SHALL accumulate per-session-since-startup cost data: number of LLM calls, total input/output tokens, total USD cost broken down by input / output / cache-read / cache-write.

The `/session:cost` command SHALL render this as a single notification line including the resolved model name.

#### Scenario: /session:cost reports zero before any calls

- **WHEN** the extension has just loaded and no digest LLM calls have been made
- **AND** the user runs `/session:cost`
- **THEN** the command shows `0 calls | tokens: 0→0 | cost: $0`

#### Scenario: /session:cost reflects accumulated usage

- **WHEN** the lifecycle has triggered 3 successful digest writes totaling 1500 input + 200 output tokens at $0.0042 total
- **AND** the user runs `/session:cost`
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
  provider?: string;             // required to enable digest generation
  model?: string;                // required to enable digest generation
  debounceSeconds: number;       // default 60
  resummarizeTokenThreshold: number; // default 10000
  maxTokens: number;             // default 1500 (covers structured JSON body + envelope + drift headroom)
  showWidget: boolean;           // default false
  verbose: boolean;              // default false
}
```

The `/session:summarizer` slash command SHALL require the user to select an available model, create the global file with explicit `provider` and `model` fields if it does not exist, and notify the user with the file path and a reminder to run `/reload`.

Config SHALL reload on `session_start` events.

#### Scenario: Project config overrides global

- **WHEN** global config sets `debounceSeconds: 60`
- **AND** project config at `<cwd>/.pi/session-search/digest.json` sets `debounceSeconds: 30`
- **THEN** the effective `debounceSeconds` for sessions in that cwd is `30`

#### Scenario: /session:summarizer creates explicit config

- **WHEN** `~/.pi/session-search/digest.json` does not exist
- **AND** the user runs `/session:summarizer`
- **AND** selects an available model
- **THEN** the file is created with explicit `provider` and `model` fields plus defaults
- **AND** the user is notified of the path

#### Scenario: Config reload picks up edits

- **WHEN** the user edits `~/.pi/session-search/digest.json` to set `debounceSeconds: 120`
- **AND** triggers `/reload` (which fires `session_start` with `reason: "reload"`)
- **THEN** subsequent `agent_end` events use the new debounce value


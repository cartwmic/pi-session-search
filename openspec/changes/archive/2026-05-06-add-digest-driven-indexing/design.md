## Context

This is the first openspec change against the fork. The upstream codebase (`samfoy/pi-session-search` 1.0.0, ~2.4k LOC) is structurally sound but ships two design choices that have to flip for the digest pivot to work:

1. **What gets indexed** is wrong for semantic recall. `buildEmbeddingText` and `buildContent` concatenate user messages, compaction summaries, and (capped) assistant text — a transcript dump in which the signal is buried under tool-call scaffolding and chain-of-thought. The user has already demonstrated this empirically (recall didn't meet criteria; pi-session-search was uninstalled before this fork existed).
2. **The embedder layer ships four redundant code paths** (openai / openai-compatible / mistral / bedrock / ollama). Three of those collapse into the openai-compatible path; the fourth (bedrock) requires AWS SDK signing and isn't openai-compatible. Single-user fork → cruft has no survivors.

The reference for the digest builder is `pasky/pi-session-summary` (467 LOC, no LICENSE → re-implement from spec, don't copy). It produces a one-line headline written to `pi.setSessionName()`. The pivot extends that pattern: produce a richer `SessionDigest` with body+headline+topics+outcome, embed and FTS the body, write the headline to `setSessionName` for the `pi -r` UX.

Pi's `ExtensionAPI` (`@mariozechner/pi-coding-agent` 0.66.1) provides everything needed: `agent_end`, `session_compact`, `session_start`, `session_shutdown` events; `ctx.modelRegistry.getAvailable()` + `getApiKeyAndHeaders(model)` for cheap-model auto-detection; `ctx.sessionManager.getBranch()` for in-memory conversation walks; `pi.setSessionName / appendEntry` for persistence. Confirmed via reading dist `.d.ts` files: there is no `registerSessionSource` hook for `pi -r` — the resume picker takes two hardcoded loader functions, so `/find-session` ships as a parallel overlay.

## Goals / Non-Goals

**Goals:**

- Replace embedded text with LLM-distilled digests so semantic recall actually surfaces the right session.
- Keep zero-config FTS5-over-raw working unchanged for users who haven't configured an embedder + digest model.
- Make the digest layer additive: no LLM cost unless the user opts in by configuring the embedder and (optionally) a digest model. No automatic backfill — the user explicitly invokes `/digest:backfill`.
- Strip the embedder code to a single class against `/v1/embeddings`. Drop the AWS SDK peer deps.
- Persist digests independently of the index DB so reindexes don't re-spend LLM dollars.
- Keep the existing tool contracts (`session_search`, `session_list`, `session_read`) byte-stable in their parameter shapes; only the displayed result content changes.

**Non-Goals:**

- Per-thread or per-branch digest variants (a session has exactly one digest in v1).
- Cross-session topic clustering, time-series analytics over digests, or any aggregation beyond `/digest:cost`.
- Integration with pi-mono's `pi -r` picker (no extension hook exists; file an upstream issue, ship `/find-session` overlay in v1).
- Compatibility with users who have an existing v3 index (we discard on load — the user is the only user, single-user fork).
- Compatibility with users running both `pi-session-summary` and this fork simultaneously (writing `setSessionName` on both extensions would race; user is expected to use one or the other).

## Decisions

### Decision: Three operating modes, auto-detected, not user-toggled

```
no embedder            → fts-raw      (upstream FTS5 over raw user messages)
embedder, no digest    → hybrid-raw   (upstream embeddings over raw content)
embedder + digest      → digest-mode  (this change's payoff)
```

Rationale: a user-facing toggle is one more knob to set wrong. The presence/absence of config IS the toggle. The two raw modes are preserved literally as upstream ships them — they're the safety net when the digest layer can't activate (no API keys, model unavailable, etc.).

Alternative considered: ship a single mode (`digest-mode` only, hard-fail without an embedder + digest model). Rejected because it makes the extension brittle on first install before any keys are configured — and the upstream FTS5-over-raw mode has real value as a zero-config baseline.

### Decision: SessionDigest schema is structured, not single-line

```ts
{ schemaVersion, body, headline, topics[], outcome?, generatedAt, modelId,
  inputTokenCount, cost }
```

Rationale: pasky's one-liner is for status-bar display; for *recall* we need 200–400 words of intentional prose to embed against. We get the structured fields out of the same LLM call by having it call a single `submit_digest` tool whose TypeBox-typed parameters carry the body, headline, topics, and outcome — no second call, no second cost. `topics` and `outcome` are optional structured filters that future versions can use without re-running LLMs.

`headline` doubles as `setSessionName(headline)`, so the pasky UX comes free. No second extension needed.

Alternative considered: separate "long digest" call (for embedding) and "short headline" call (for display). Rejected as 2x cost for no signal gain. The single `submit_digest` tool call returns both in one shot.

### Decision: Per-session digests live in `~/.pi/session-search/digests/<uuid>.json`

Rationale: durable, atomic-writable, manually inspectable, and **independent of `INDEX_VERSION` bumps**. Index rebuilds (manual or migration-triggered) don't re-spend LLM dollars — the indexer reads digests off disk and re-embeds them. The on-disk file is the source of truth.

Alternative considered: store digests inline in `session-index.json` only. Rejected because index-DB churn would force LLM re-runs on every schema bump. The split also helps `/digest:rewrite` — it just rewrites one file atomically.

### Decision: Two-prompt strategy, threshold-gated

Below `resummarizeTokenThreshold` (default 10000) → incremental prompt: previous digest + delta, instructed to repeat verbatim unless something material changed.
At/above threshold → full prompt: whole conversation, ignore previous digest.

Both modes always running. Threshold picks per-write.

**Delta anchor**: incremental prompts need a way to identify which messages are new since the prior digest write. The builder tracks `lastWrittenMessageIndex: number` in `BuilderState` — the index into `ConversationView.messages` at the time of the last successful digest write. The `extractDelta(view, anchor)` helper returns `view.messages[anchor..]`. Without this, "only the delta" collapses to "whole conversation" and the token-savings claim of incremental mode is invalid. After every successful digest write, `lastWrittenMessageIndex` is updated to `view.messages.length` (current end-of-conversation).

Rationale: incremental is cheap and preserves continuity (stable headlines for the picker UX); full is corrective and reframes when the session has drifted enough that incremental patching is starting to lose the thread. 10k corresponds to roughly 30 turns of substantive work — empirically the rhythm at which a session's "what is this about" shifts.

Alternative considered: full-only (simpler, no continuity logic). Rejected as 5–10x more expensive and headline thrash hurts the picker UX.

Alternative considered: incremental-only (cheapest, preserves continuity by fiat). Rejected because digest can drift over a long session — never gets a fresh look.

The threshold is a config knob; setting it to 0 yields full-only, setting it to `Infinity` yields incremental-only.

### Decision: Single openai-compatible embedder, drop bedrock

Rationale: in this codebase three of the four upstream embedder classes collapse cleanly into one — Mistral and Ollama already expose `/v1/embeddings`, and `OpenAICompatibleEmbedder` is already the workhorse. The fourth (Bedrock Titan) doesn't expose openai-compat without LiteLLM in front; carrying its AWS SDK code path costs ~150 LOC + two peer deps for zero observable benefit (single-user fork, user doesn't use Bedrock).

The `EmbedderConfig` shape simplifies to `{baseUrl, model, apiKey?, apiKeyEnv?, dimensions?, headers?}` — no `type` discriminator. The `/session-embeddings-setup` command becomes a flat 4-prompt walkthrough.

**Legacy config migration**: although it's a single-user fork, the user's existing `config.json` likely has a `type: "openai-compatible"` field today. On load, if `embedder.type !== undefined` AND `embedder.type !== "openai-compatible"`, the loader SHALL log a one-time warning and refuse to construct the embedder until `/session-embeddings-setup` reruns. If `type === "openai-compatible"` the field is silently ignored.

Alternative considered: keep type tags as deprecation shims. Rejected — it's a single-user fork, no users to keep compatible with.

### Decision: INDEX_VERSION 3 → 4, hard reset on load

The v3 → v4 transition is destructive: index data drops, sessions get re-discovered, sync rebuilds the index. **Digests survive** (they're in `digests/` not in the index DB).

Rationale: v3 embeddings were built on noisy raw content. Migrating them in place gains nothing because we're going to re-embed everything against `digest.body` anyway. Hard reset is simpler than a migration that does the same work.

Post-migration, the user runs `/digest:backfill` to digest pre-existing sessions. New sessions get digested live via `agent_end`.

**FTS DB recovery path**: `populateFtsFromIndex()` is KEPT (not removed as originally planned). Use case: if `hybrid-fts.db` or `sessions-fts.db` is corrupted/deleted but `session-index.json` and the digests survive, `populateFtsFromIndex()` rebuilds FTS5 from existing index data without re-embedding (which costs $0 vs ~$0.02 per full re-embed corpus). The function is small (~20 LOC) and the cost of carrying it is negligible against the recovery value.

### Decision: Backfill is opt-in only

`session_start` does not trigger backfill. `/digest:backfill` is the only path that touches old un-digested sessions.

Rationale: surprise LLM bills are a worse user experience than "you have to type one command after install." The backfill cost is bounded (~$5-10 for a 2k-session corpus on cheap models, dominated by digest model not embedder), but it should be the user's explicit decision.

**Backfill data path** (separated from the live `agent_end` path): `digest/builder.ts` accepts a `ConversationView` interface. The live path provides a view backed by `ctx.sessionManager.getBranch()`; the backfill path provides a view backed by `parseSession(file)` (the existing parser already extracts user/assistant text and compaction summaries — the adapter just shapes that into the `{role, text}[]` form the prompt builder expects). The builder itself stays event-system-agnostic.

**Branches are not special-cased.** Each session JSONL file has exactly one digest, regardless of whether it has internal branches. Live (`getBranch`) digests the active branch; backfill (parser flat output) digests the file as the parser sees it. Where they differ on a multi-branched session, the next live `agent_end` rewrites the digest to match the active branch — self-correcting on the next user turn. Single-user fork; user has accepted this as normal.

Backfill iterates **discovered session files via `discoverSessionFiles()`** (the same parser entry point sync uses), not index membership. This ensures un-digested sessions are reachable in digest-mode (where they would otherwise be excluded from the index).

**Dry-run cost formula**: `inputCostUsd = Σ(file.sizeBytes / 4) × model.cost.input` (sizeBytes/4 approximates token count; `model.cost.input` is the per-token unit price exposed by `Model<Api>.cost.input` from `@mariozechner/pi-ai`'s `Model` type — verified). `outputCostUsd = sessionCount × estimatedDigestOutputTokens × model.cost.output` where `estimatedDigestOutputTokens = 700` (typical 200–400 word body + envelope is ~700 tokens, NOT the `maxTokens: 1500` ceiling — using the ceiling overestimates by ~2x). Embedding cost is excluded from the formula by default since `EmbedderConfig` does not carry a price (and embedding cost is negligible per proposal: ~$0.02 for the entire 2k-session corpus). If the user wants embed-cost included, they may set an optional `embedder.pricePerInputToken: number` field in `config.json`; absent that, dry-run prints "embedding cost: not estimated (configure embedder.pricePerInputToken to include)." Document accuracy bound (typical ±30–50%) in `/digest:backfill --dry-run` output.

### Decision: Lifecycle triggers — agent_end (debounced), session_compact (immediate), command (immediate)

`agent_end` debounces at 60s per session — the same number pasky uses, validated by their corpus. `session_compact` bypasses the debounce because compaction materially changes the conversation shape (the prior digest's input is now stale by definition). The command-driven triggers (`/digest:update`, `/digest:rewrite`) bypass both debounce and threshold.

**Coalescing rule (single source of truth, used everywhere in spec/tasks):** if a new trigger fires while an LLM call is in flight, the trigger is dropped AND a `dirty` flag is set. When the in-flight call completes, if `dirty === true` the lifecycle schedules ONE follow-up call after a short tail delay (250ms) and clears the flag. This gives "drop new while busy" simplicity plus a single-shot tail flush so trailing activity isn't lost. Per-session state.

Rationale: B's stronger-alternative variant. Pure drop-new can lose the last update if the user stops typing during the in-flight window; pure deferred-replay risks unbounded queueing. Single-shot flush is the minimum that self-heals.

### Decision: Tool-call digest delivery (not free-form JSON)

The digest builder uses **pi-ai's tool-call mechanism** to extract structured digest data from the LLM, not free-form JSON parsing. This is the cleaner design surfaced by the user during review.

**Architecture:**

1. The builder defines an internal `submitDigest` tool with TypeBox-typed parameters matching the digest schema's user-facing fields:

   ```ts
   const submitDigestTool: Tool<typeof DigestArgs> = {
     name: "submit_digest",
     description: "Submit the structured digest of this coding session. Call this tool exactly once with body, headline, topics, and outcome.",
     parameters: Type.Object({
       body: Type.String({ description: "200–400 word prose summary of the session..." }),
       headline: Type.String({ maxLength: 80, description: "≤80 char headline..." }),
       topics: Type.Array(Type.String({ maxLength: 32 }), { maxItems: 5 }),
       outcome: Type.Optional(Type.String()),
     }),
   };
   ```

2. The builder calls `complete(model, {systemPrompt, messages, tools: [submitDigestTool]}, options)`. The system prompt instructs the LLM to call the `submit_digest` tool exactly once.

3. pi-ai handles per-provider tool-call format natively (OpenAI tool calls / Anthropic tool use / Gemini function calls / etc.). Tool arguments are validated against the TypeBox schema by the provider transport before being delivered.

4. The builder reads `response.content` for a `{type: "toolCall", name: "submit_digest", arguments: {...}}` entry. The `arguments` object is the digest payload; the builder decorates it with metadata (`schemaVersion: 1`, `generatedAt`, `modelId`, `inputTokenCount`, `cost`) to produce the final `SessionDigest`.

5. **Failure modes** (handled by the builder, not the LLM):
   - LLM emits text content instead of calling the tool → retry once with a stricter prompt that emphasizes "call submit_digest, do not respond with text."
   - LLM calls the tool but arguments fail TypeBox validation at the provider edge → retry once.
   - Two consecutive failures → drop digest, set `lastError`, leave prior digest untouched.
   - LLM emits multiple tool calls → take the first; ignore the rest.

**Why this is dramatically better than the previous "free-form JSON + tolerant parse" approach:**
- No prompt-engineering for JSON-only output. Tool calls have provider-native format guarantees.
- No markdown-fence stripping. Tool args arrive as native objects.
- No `parseStreamingJson` ceremony.
- TypeBox schema enforcement happens at the provider transport level, not as a manual post-step.
- Validation errors are surfaced by pi-ai with clear provenance ("argument X failed type check"), not as opaque JSON parse failures.

**Validator choice**: TypeBox (`@sinclair/typebox`). The project already uses it for tool-parameter schemas elsewhere; using it for the digest tool keeps the surface consistent.

**Why not model-tier escalation?** Reviewer suggested escalating up the priority list on N consecutive failures. Rejected as scope creep — the retry-once-then-drop pattern is enough signal. If a particular cheap model is consistently failing to follow tool-call instructions, `/digest:cost` shows the call count diverging from the digested count and the user can manually edit `digest.json` to bump the model. Tool-call discipline is much more reliable than JSON-only output discipline for cheap models, so this failure mode should be rare in practice.

### Decision: Token counting via char/4 heuristic

The threshold gate (`tokensSinceLastDigestWrite >= resummarizeTokenThreshold`) needs a token count. We use `Math.ceil(text.length / 4)`, matching pasky's `estimateTokens` exactly. Pros: no tokenizer dependency, deterministic across providers, accurate within ±25% for English prose. Cons: undercount on code-heavy / token-dense content.

**Reconciliation**: `tokensSinceLastDigestWrite = currentConvTokens − convTokensAtLastWrite`, where `currentConvTokens = estimateTokens(serialized full conversation)` and `convTokensAtLastWrite` is recorded after every successful digest write. This is the threshold gate input; the per-message delta extracted by `extractDelta(view, lastWrittenMessageIndex)` is the prompt input for incremental mode.

Alternative considered: read `response.usage.input` from the previous LLM response. Rejected because the LLM response usage is for the LLM's prompt INPUT (not the conversation between digest writes), and reading it requires plumbing through provider-specific response shapes.

If threshold drift becomes a problem, the path forward is explicit `tiktoken-lite` import or similar; not in this change.

### Decision: Prompt input cap (both modes)

The builder caps prompt input characters in BOTH full and incremental modes. Full mode passes the whole conversation; incremental mode passes the previous digest body PLUS the conversation delta since the last anchor. Long sessions past the 10k threshold are by definition large in full mode; long-idle-then-resume in incremental mode can also produce a delta + prior-digest combination that exceeds small-context cheap models. Without a cap in either mode, the LLM call hits a context-overflow error and the retry-then-drop pattern silently fails.

The builder helper `capInput(view, model, includesPrevDigest: boolean): ConversationView` SHALL cap input characters at:

```
maxInputChars = min(100000,
                    model.contextWindow * 4
                    - maxTokens * 4
                    - (includesPrevDigest ? 4000 : 2000))
```

The `2000`/`4000` budget reserves room for the system prompt + envelope + (when included) the previous digest body. If the input exceeds the cap, truncation order: KEEP all `compactionSummaries` (highest signal density) + the first user message + the most recent N user/assistant messages until the cap is hit. Drop the middle. Document explicitly that long sessions get a head-and-tail summary, not a full transcript, in either mode. If `model.contextWindow` is absent on this pi-ai version, fall back to a flat 100000 cap regardless.

### Decision: Embedding dimension stability

The `session-index.json` v4 schema SHALL include a `vectorDim: number` field at the root, recording the dimension of all stored embeddings. On load, the index reads the current effective `dimensions` from the embedder config (or the model's native dim if unset, learned at first embed). On mismatch, the index is marked dirty: `sync()` SHALL re-embed all entries against the current dimension, updating `vectorDim` in the file.

Mixing vector dimensions in `cosineSimilarity()` produces wrong scores or throws. The dim-stability check prevents this.

Unit tests SHALL verify: (a) load with matching `vectorDim` is idempotent; (b) load with mismatched `vectorDim` triggers a re-embed pass; (c) cosine never compares vectors of different lengths.

### Decision: addDigested batching during backfill

`addDigested(sessionId, parsed, digest)` writes `session-index.json` after each call to keep the on-disk index live. During backfill of N sessions, this would mean N full JSON serializations of the entire index — wasteful (10 MB + writes) and slow.

During `/digest:backfill` execution, the index `addDigested()` accepts a `batched: boolean` flag. With `batched: true`, the index updates in-memory only and defers the disk write. The backfill loop calls `index.flush()` (a new method) every 25 successful digests AND on completion. The 5-minute periodic `sync()` is suspended for the duration of backfill (a `backfillInProgress` mutex on the SessionIndex).

**Active-session race guard**: backfill skips the currently-active session UUID (`ctx.sessionManager.getSessionId()`) entirely — the live `agent_end` lifecycle owns it. For other sessions, the backfill loop re-checks `loadDigest(id) === null` immediately before `saveDigest()` (after the LLM call returns); if the live lifecycle wrote one during the LLM call window, backfill skips the save and moves on. The on-disk file is the source of truth; the live write wins.

### Decision: Cost-tracker is per-process, not persisted

`cost-tracker.ts` accumulates LLM call count, tokens in/out, and USD cost in memory only. On extension reload, it resets to zero.

Rationale: `/digest:cost` is a diagnostic for "is your model class working?" — a single backfill run gives enough signal in one process lifetime. Persisting across restarts adds an atomic-write code path and a tiny on-disk file (`~/.pi/session-search/digest-cost.json`) for marginal value. If the user wants daily-cost tracking, that's an explicit feature request, not implicit behavior.

The `/digest:cost` rendering SHALL include the phrase "this process" (e.g., "3 calls this process | tokens: ...") so the scope is unambiguous.

### Decision: Recall measurement gate — deferred to follow-up

The pivot's premise is "raw recall isn't good enough; digest will be better." Reviewer correctly noted no measurement gate. Building a recall-eval harness with labeled (query, expected-session-id) pairs is meaningful work — the eval-set construction itself is a design problem (which queries? labeled by whom against what corpus?). Out of scope for this change.

Follow-up change planned: `add-recall-eval-harness` (separate openspec change, post-merge). Captures the measurement gate this change ships without.

### Decision: Component layout

```
src/digest/
  schema.ts         SessionDigest type + submitDigestTool TypeBox definition
  builder.ts        debounce timer, threshold gate, prompt selection, LLM call
  storage.ts        per-session digest files, atomic writes, load/save
  lifecycle.ts      session_start/agent_end/session_compact wiring
  model-resolver.ts auto-detect from ctx.modelRegistry.getAvailable()
  cost-tracker.ts   per-session cost rollup, /digest:cost rendering
src/index/
  session-index.ts  (renamed from src/session-index.ts; mode-aware embedding text)
  fts-index.ts      (renamed from src/fts-index.ts;     mode-aware FTS content)
src/search/
  overlay.ts        /find-session command implementation
src/                (existing, modified or unchanged)
  index.ts          extension entry; wires digest lifecycle, registers commands
  embedder.ts       OpenAICompatibleEmbedder only
  parser.ts         (unchanged)
  reader.ts         (unchanged)
  config.ts         (unchanged shape; new digest.json file is loaded by digest/storage.ts)
  utils.ts          (unchanged)
```

`model-resolver.ts` and `cost-tracker.ts` are split out from `builder.ts` (vs pasky's monolithic `index.ts`) because they're pure functions trivially unit-testable in isolation. `lifecycle.ts` owns the wiring between events and the builder so the builder itself stays event-system-agnostic.

### Decision: Test strategy stays unit-only

Existing tests are pure-unit (`node --test --import tsx`). Stay in that lane. Add tests for:

- `digest/schema.ts` — validate / reject malformed
- `digest/builder.ts` — prompt selection from `(prevDigest, convTokens)` inputs (mock the LLM call)
- `digest/model-resolver.ts` — priority-list selection given a fake `getAvailable()`
- `digest/cost-tracker.ts` — accumulation arithmetic
- `digest/storage.ts` — atomic write + roundtrip
- `embedder.ts` — already exists; extend to verify dimensions passthrough behavior

Defer integration coverage to a `/digest:backfill --dry-run` smoke against fixtures in `src/__tests__/fixtures/`. The pi-tui-scenario-tests skill is overkill for this change — the lifecycle wiring is small enough that unit tests over the builder + a dry-run smoke cover the failure surface.

## Risks / Trade-offs

[**Risk: digest LLM call hangs and blocks subsequent debounce fires**] → Mitigation: every LLM call has its own AbortController with a hard 60s timeout; debounce timer is set with the most recent ctx; the in-flight coalescing rule (drop-new + single-shot deferred flush) plus the abort-on-session-shutdown handler prevents leaks.

[**Risk: LLM fails to call `submit_digest` tool, emits text instead**] → Mitigation: TypeBox-typed `submit_digest` tool definition with required `body`/`headline`/`topics` fields; pi-ai's provider transport handles per-provider tool-call format (OpenAI tool calls, Anthropic tool use, Gemini function calls). On absence of expected `toolCall` entry in `response.content`, retry-once with a stricter prompt ("You did not call submit_digest. Call it now."). On second failure, log `lastError`, leave prior digest untouched, do NOT update `setSessionName`. Next `agent_end` fires another attempt naturally. Tool-call discipline is dramatically more reliable than free-form JSON for cheap models, so this failure mode should be rare in practice. Repeated failures show via `/digest:cost`'s call count diverging from indexed-digest count — the user can then manually upgrade their `model` config (no automatic model-tier escalation, by design).

[**Risk: per-session digest files accumulate stale entries for deleted sessions**] → Mitigation: explicit decision to keep them. The digest/ directory is a content-addressed cache; re-discovering a deleted session by UUID reuses the existing digest. Cost: bounded (~2KB/session × N sessions). If it ever matters, ship a `/digest:gc` command.

[**Risk: collapsing to openai-compatible-only breaks recall on Bedrock-only setups**] → Mitigation: irrelevant — single-user fork, user doesn't use Bedrock. Documented in CHANGELOG: "use a LiteLLM proxy if you must hit Bedrock."

[**Risk: writing `setSessionName(headline)` clobbers a name a user manually set**] → Mitigation: by design — the digest IS the session's intentional name in this fork. If the user has an existing manual name, the first successful digest overwrites it. Tradeoff accepted; manual session naming is a workflow this fork doesn't preserve.

[**Risk: the 10k threshold is wrong for this user's session shape and headlines thrash or stagnate**] → Mitigation: it's a config knob, not a baked constant. The `/digest:settings` flow surfaces it. If headlines thrash, raise it; if they stagnate, lower it.

[**Risk: cheap models (nano-class) fail to call the `submit_digest` tool correctly — emit text instead, hallucinate the tool name, or produce arguments that fail TypeBox validation**] → Mitigation: tool-call discipline is dramatically more reliable than free-form JSON output for cheap models (provider-native tool-call format guarantees), but the failure path still exists. The retry-once-with-stricter-prompt + drop-on-second-failure pattern absorbs sporadic failures. If sustained failure rate is high, the divergence between `/digest:cost`'s call count and the count of digested sessions in the index is the diagnostic; the user upgrades to `gpt-5.4-mini` or `claude-4-5-haiku` via `digest.json`. Not auto-escalating: it's lifecycle complexity that obscures a real signal ("your model is too small").

[**Risk: `pi.setSessionName` collision with another extension that also writes session names**] → Mitigation: documented in README ("don't run pi-session-summary alongside this fork"). No technical guard.

[**Risk: `/digest:backfill` is interrupted partway through**] → Mitigation: backfill processes sessions one at a time and each digest write is atomic. Re-running `/digest:backfill` resumes (it skips already-digested sessions). No checkpointing needed.

[**Risk: `digest.body` exceeds embedder's 12000-char input cap**] → Mitigation: the digest is targeted at 200–400 words (~1500–3000 chars) by prompt design; well under the cap. If the LLM goes off-script, the embedder's truncate-to-12000 handles it. Worst-case the embedding is from the first 12k chars of the digest; not catastrophic.

[**Risk: auto-detect priority list IDs don't resolve in `getAvailable()` and digest mode silently falls through to `hybrid-raw`**] → Mitigation: empirical verification confirms `getAvailable()` returns `Model<Api>[]` with `.id` (bare model id, not provider-qualified) and `.provider` separated. Resolver matches against `.id` exactly; on tie (multiple providers expose same id), pick lowest-cost provider. **Fallthrough notification**: when `digest.json` is configured but no priority-list model resolves AND no explicit override is set, emit a one-time `ctx.ui.notify("session-search: digest mode unavailable — none of [...] are configured. Running in hybrid-raw mode.", "warning")` on `session_start`. This makes the silent degrade visible.

[**Risk: `dimensions` config change or model swap produces a heterogeneous-dim cosine index that throws or silently produces garbage scores**] → Mitigation: `vectorDim` field stored in `session-index.json` v4. On load, mismatch with current effective config triggers a dirty-mark; next `sync()` re-embeds all entries. Cosine code path asserts equal vector lengths and refuses mixed-dim comparison.

[**Risk: `fts-raw` and `hybrid-raw` modes (claimed unchanged from upstream) silently regress during the mode-aware refactor of `buildContent` / `buildEmbeddingText`**] → Mitigation: regression tests pin the exact text outputs of both functions in raw modes against captured fixtures (small sample of real sessions in `src/__tests__/fixtures/`). The mode-aware function MUST return byte-identical output to the upstream function in non-digest modes.

[**Risk: large backfill (~2k sessions) thrashes `session-index.json` writes and conflicts with the periodic `sync()`**] → Mitigation: `addDigested(... , {batched: true})` defers disk writes during backfill; flush every 25 successful digests + on completion. `backfillInProgress` mutex suspends periodic sync for the duration. Backfill is serial (no parallel LLM calls) per the existing decision.

[**Risk: pre-backfill digest-mode shows empty `session_list` / search results, breaking corpus browsing**] → Mitigation: revised decision — `session_list` lists all discovered sessions in digest-mode, displaying via `firstUserMessage` fallback when no digest exists, tagged with the canonical suffix `(no digest — run /digest:update)`. Only the SEARCH ranking depends on digest presence (un-digested sessions don't appear in `session_search` because they have no `digest.body` to embed/match). The cold-start empty-state message in `session_search` is mode-aware: in digest-mode it points to `/digest:backfill`.

### Decision: SessionIndex API surface for digest-mode

The `SessionIndex` class (used in `hybrid-raw` and `digest-mode`) gains the following public methods. **`FtsSessionIndex` does NOT mirror these methods** — it's only used in `fts-raw` mode where the digest layer is inactive by definition; mirroring would be dead code that confuses the implementer:

- `addDigested(sessionId, parsedSession, digest, opts?: {batched: boolean}): void` — incremental update for newly-digested sessions. With `batched: true`, defers the disk write; the caller (backfill) is responsible for `flush()`.
- `flush(): void` — persists in-memory state to disk. Called by backfill every 25 digests + on completion.
- `backfillInProgress: boolean` — mutex flag. Periodic `setInterval` `sync()` checks this and returns early when true.
- `getDigest(sessionId): SessionDigest | null` — simple reader for renderers.
- `search(query, limit, signal?)` returns `Array<{session, summary, score, digest?: SessionDigest}>` in `digest-mode`. The `digest` field is `undefined` for un-digested sessions (only possible if the active mode is `hybrid-raw` or `fts-raw`); in `digest-mode` proper it's always present because un-digested sessions are excluded from cosine + FTS scoring. Consumers (overlay, `session_search` tool) read `headline`/`topics`/`body` off it.

## Migration Plan

The migration is a hard reset of the index DBs and an opt-in backfill of digests. Single-user fork — there's exactly one user to migrate, and they're driving.

1. User merges this change.
2. On next `pi` startup the extension loads, sees `INDEX_VERSION: 3` (or no index file), resets to `{version: 4, vectorDim: 0, sessions: {}}`, notifies the user once.
3. New sessions get digested live via `agent_end` (no migration step needed).
4. User runs `/digest:backfill --dry-run` to see the cost estimate for digesting historical sessions.
5. User runs `/digest:backfill` to digest historical sessions. Progress bar via `ctx.ui.setStatus`.
6. Each digested session gets re-embedded and added to the FTS5 index automatically as part of the backfill.

**Rollback** (canonical procedure — referenced by tasks.md and CHANGELOG):

1. `git revert <merge-commit>` to restore the prior code.
2. `rm -rf ~/.pi/session-search/index/` to clear the v4 index files (a reverted v3 codebase cannot read them).
3. `~/.pi/session-search/digests/` directory is forward-compatible (`schemaVersion`-versioned); leaving it in place is safe — a future re-introduction of this change reads existing digests without re-spending LLM dollars.
4. `~/.pi/session-search/digest.json` can be left in place; reverted code ignores unknown config files.
5. On next startup, upstream code paths regenerate the index against raw content.

## Open Questions

- **Should the `apiKeyEnv` field default to `OPENAI_API_KEY` if not set?** Probably yes — saves typing for the common case. Defaulting to "yes, with `OPENAI_API_KEY` if `apiKeyEnv` is absent." Will note in tasks.md as a finalize-during-implementation choice.
- **Should `/digest:backfill` parallelize the LLM calls?** Sequential is simpler and matches pasky's pattern. Parallelizing would speed up the initial backfill of 2k sessions from ~tens of minutes to ~one minute, but multiplies the failure-mode surface. Defaulting to sequential; revisit if backfill time becomes painful.
- **Should `topics[]` and `outcome` participate in FTS5 indexing or only the body?** Only the body in v1 — keeps the FTS contract simple. If `topics` show recall value, add them to a separate FTS column in v2.
- **What's the right value of `maxTokens` for the digest LLM call?** Raised from 800 to **1500** after Round 1 review. A 400-word body is ~530 tokens; structured JSON envelope (headline + topics + outcome + JSON scaffolding) adds another ~200; cheap models can drift another ~200. 1500 has headroom without being so loose that the model rambles. Pasky's 300 is for one-line headlines and isn't transferable.

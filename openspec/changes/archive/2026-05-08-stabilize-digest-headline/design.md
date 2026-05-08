## Context

The session digest builder (`src/digest/builder.ts`) emits a `SessionDigest` whose `headline` field is piped to `pi.setSessionName` after every successful write. The builder runs in two modes:

- **Full re-summarize**: prompt contains the entire (capped) conversation, no prior digest.
- **Incremental update**: prompt contains the previous `digest.body` plus only the messages since the last write, with instructions to "update if anything material changed."

Two prompt-shape choices are causing headline drift:

1. The schema-instruction line for `headline` reads only `"a concise display title for the session"`. It carries no signal about stability or session-arc framing, so the model fills the gap with whatever is most salient in the current input.
2. The incremental-mode user message includes the previous `body` but **not** the previous `headline`, and frames the task as "update the digest if anything material changed" without distinguishing the body (which should track activity) from the headline (which should not). With only the delta visible and the headline absent, the model rewrites the 80-char headline to fit whatever is most salient in the recent messages.

Body has 200–400 words to absorb session arc and so naturally accommodates new activity without losing earlier context. Headline at ≤80 chars cannot, so it collapses to a snapshot.

The fix is prompt-only. The `SessionDigest` schema is unchanged, the wiring to `pi.setSessionName` is unchanged, the lifecycle triggers are unchanged.

## Goals / Non-Goals

**Goals:**
- Bias the LLM toward producing a stable, whole-session headline that does not change every digest tick.
- Keep the prompt change minimal, contained, and easy to revert if it underperforms.
- Preserve the ability for a genuinely-pivoted session to acquire a new headline.

**Non-Goals:**
- Locking the headline in code (post-processing carry-forward) — possible follow-up, out of scope here.
- Splitting `headline` into a separate `sessionTitle` field — out of scope.
- Generating the headline only on the first full pass and freezing thereafter — out of scope.
- Schema field changes or schema-version bumps.
- Re-running digests on existing sessions to fix already-drifty headlines — drift will self-correct on the next natural digest write.

## Decisions

### Decision 1: Sharpen the headline schema description

Replace the headline line in `SCHEMA_INSTRUCTIONS` with text that explicitly frames it as a stable, whole-session title and tells the model to resist drift.

Approximate new wording (final phrasing during implementation):

> `headline (string, 1–80 chars): a stable title describing the session as a whole — the through-line or overarching goal, not the latest activity. Treat as sticky: do not rewrite to track tactical shifts; only change when the session's overall topic has fundamentally pivoted.`

**Rationale**: schema-instruction text is the most reliable place to install a soft constraint, because both full and incremental prompts read it and provider-side tool-call enforcement honors it. The same framing applies in both modes; we don't want a strong/weak headline policy that flips with mode.

**Alternative considered**: only sharpen it in the incremental prompt. Rejected because the first full digest also benefits from "describe the session as a whole" framing — without it, the very first headline can be a snapshot of the early activity, which then locks in.

### Decision 2: Pass previous headline into incremental prompts and instruct stickiness

In `buildPrompt`'s incremental branch, include the previous `headline` (in addition to the previous `body`) in the user message, and add a one-line instruction telling the model to repeat it verbatim unless the session has pivoted.

Approximate new template (final phrasing during implementation):

```
Previous headline: "<state.lastDigest.headline>"
Previous digest:
<state.lastDigest.body>

New messages since last digest:
<deltaText>

Keep the previous headline verbatim unless the session's overall topic has fundamentally shifted; the body should track new activity but the headline should not. Update the digest if anything material changed; otherwise repeat the previous digest verbatim. Call submit_digest now.
```

**Rationale**: schema-text alone is necessary but not sufficient — when the model sees only the delta in incremental mode, it has no anchor to "repeat" the headline because it doesn't know what the previous headline was. Surfacing the prior headline plus an explicit "keep verbatim unless pivoted" instruction gives the model both the anchor and the policy. Body is left free to track new activity.

**Alternative considered**: include the headline in the prompt but without an explicit stickiness instruction. Rejected because models will still rewrite a field they can see, especially when the surrounding instruction is "update if anything material changed."

### Decision 3: Token-budget impact is negligible

The previous headline is ≤80 chars plus framing — well under 50 tokens. The `capInput` envelope (4000 chars when prev-digest included) already accounts for the previous body and surrounding scaffolding; adding one more line does not require expanding the envelope. No `capInput` change needed.

## Risks / Trade-offs

- [Headlines remain drifty after change] → If observation over a few sessions shows insufficient improvement, escalate to code-side carry-forward (drop headline from incremental schema; copy `state.lastDigest.headline` into the new digest before save). Self-contained follow-up; no rework of this change.
- [Genuinely-pivoted sessions retain a stale headline too long] → The instruction explicitly carves out "fundamentally pivoted" as a permitted change; users can also force a fresh headline by running `/digest:rewrite` (full re-summarize). If this trade-off proves wrong, dial back the stickiness language.
- [Existing test snapshots break] → Prompt-shape assertions in `tests/digest/builder.test.ts` (or equivalent) need updating in lockstep. Caught at test time; low risk.
- [Provider tool-call schema description drift] → Some providers truncate or summarize tool-parameter descriptions. The headline framing lives in the system prompt's `SCHEMA_INSTRUCTIONS` text (not in the TypeBox parameter description), which is forwarded verbatim by direct providers and by claude-bridge ≥ commit 202ca4b — so this is unaffected.

## Migration Plan

No data migration required. Stored digests retain their existing schema. On the next natural digest write per session, the new prompt shape takes effect and headlines will gradually stabilize. Rollback is a single-commit revert of the prompt strings; no state cleanup needed.

## Open Questions

- How long do we observe before deciding whether prompt-only fixes are sufficient? (Suggested: a week of normal usage, or ~10–20 sessions where the user notices headline behavior either way.)
- Should we add a debug-log line that records the previous-vs-new headline on each incremental write to make drift observable without manual inspection? (Probably yes — small change, deferred to tasks.)

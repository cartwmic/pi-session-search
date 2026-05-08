## Why

The session digest's `headline` field drives the visible session title via `pi.setSessionName`, but in practice it drifts toward a snapshot of the most recent activity rather than acting as a stable title for the session as a whole. Two compounding pressures push it that way: the schema description ("a concise display title for the session") gives the model no signal that the headline should be stable across writes, and the incremental-mode prompt presents only the new delta with an "update if anything material changed" instruction that biases the model to rewrite the 80-char headline against the freshest content. Result: titles change every digest tick to track tactical work, even when the session's overall topic hasn't shifted.

## What Changes

- Sharpen the `headline` description in the digest schema instructions to explicitly frame it as a **stable, whole-session** title that should resist drift and only change on a fundamental topic pivot.
- In incremental-mode prompts, pass the previous `headline` to the LLM (in addition to the previous `body`) and instruct it to repeat the headline verbatim unless the session's overall topic has fundamentally shifted.
- Both changes are prompt-side only: no schema field changes, no storage changes, no behavioral change to lifecycle triggers, full re-summarize, or `pi.setSessionName` wiring.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `session-digest`: the schema-instruction text for `headline` and the incremental-mode prompt template are tightened to bias the LLM toward a stable session title. The `SessionDigest` schema itself is unchanged.

## Impact

- **Code**: `src/digest/builder.ts` — `SCHEMA_INSTRUCTIONS` constant (headline line) and `buildPrompt` incremental branch (user message template).
- **Tests**: `tests/digest/builder.test.ts` (or equivalent) — update prompt-shape assertions; add a test that incremental-mode prompts include the previous headline and the stickiness instruction.
- **Specs**: `openspec/specs/session-digest/spec.md` — strengthen the "Incremental vs full prompt selection" requirement to require previous-headline passthrough and headline stickiness language; add a scenario covering the new prompt shape.
- **APIs / dependencies**: none. No schema version bump (field shape unchanged). No migration of stored digests required; existing digests remain valid and will gradually re-converge to stable headlines on subsequent writes.
- **Risk**: prompt-only change; if it proves insufficient (headlines still drift after observation), the follow-up is a code-side carry-forward (option #3 from prior discussion) — out of scope here.

## 1. Prompt edits in `src/digest/builder.ts`

- [x] 1.1 Update the `headline` line in `SCHEMA_INSTRUCTIONS` to frame it as a stable, whole-session title (the through-line, not the latest activity) and explicitly tell the model to treat it as sticky and resist drift.
- [x] 1.2 In `buildPrompt`'s incremental branch, include `state.lastDigest.headline` in the user message (alongside the existing `state.lastDigest.body`) under a `Previous headline:` label.
- [x] 1.3 In `buildPrompt`'s incremental branch, append a stickiness directive instructing the LLM to keep the previous headline verbatim unless the session's overall topic has fundamentally pivoted, while leaving the body free to track new activity.
- [x] 1.4 Confirm the existing "repeat the previous digest verbatim if nothing material changed" instruction still appears in the incremental user message and is consistent with the new stickiness directive.
- [x] 1.5 Verify no change is needed to `capInput` envelope sizes — adding ~80 chars + framing fits comfortably inside the existing 4000-char incremental envelope.

## 2. Optional observability

- [x] 2.1 In `src/digest/lifecycle.ts` (or wherever the successful-write path lives), emit a debug-level log on incremental writes recording the previous and new `headline` values to make drift observable without manual inspection. Gate behind the existing `PI_SESSION_SEARCH_DEBUG_DIGEST` env flag (or similar) so it stays opt-in.

## 3. Tests in `src/__tests__/digest/builder.test.ts`

- [x] 3.1 Update the existing `incremental userMessage includes previous digest body` test to also assert the user message contains `state.lastDigest.headline`.
- [x] 3.2 Add a test asserting the incremental user message contains a stickiness directive (search for a stable substring such as "fundamentally pivoted" or whatever final wording is chosen) when a prior digest exists.
- [x] 3.3 Add a test asserting the system prompt's headline framing has been sharpened (search for a stable substring such as "as a whole" or "sticky" — match whatever final wording is chosen).
- [x] 3.4 Add a test asserting the full re-summarize prompt does NOT include any previous-headline line, since no prior digest is referenced in full mode.
- [x] 3.5 Run `npm test` and confirm all digest tests pass.

## 4. Spec sync

- [x] 4.1 Confirm the change's delta spec at `openspec/changes/stabilize-digest-headline/specs/session-digest/spec.md` covers the new prompt-shape requirements (previous-headline passthrough, stickiness directive, full-mode framing).
- [ ] 4.2 During archive, ensure the MODIFIED requirement merges cleanly into `openspec/specs/session-digest/spec.md`.

## 5. Validation

- [x] 5.1 Run `openspec validate stabilize-digest-headline --strict` and resolve any reported issues.
- [ ] 5.2 Manually exercise on a real session: trigger one full digest, then several incremental writes via `/digest:update`, and confirm the headline stays stable across incremental writes when the session's topic has not pivoted.
- [ ] 5.3 Manually exercise a topic-pivot case (deliberately steer the session into an unrelated subject, then `/digest:update`) and confirm the headline is permitted to change.
- [ ] 5.4 Decide on an observation window (e.g., one week of normal usage) before deciding whether to escalate to the code-side carry-forward follow-up.

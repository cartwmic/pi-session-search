## MODIFIED Requirements

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

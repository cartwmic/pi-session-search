## MODIFIED Requirements

### Requirement: Cheap-model auto-detection

The digest builder SHALL resolve the LLM model from `ctx.modelRegistry.getAvailable()` using a priority list when no explicit `provider`+`model` is configured.

The default priority list SHALL be: `gpt-5.4-nano`, `gpt-5.4-mini`, `claude-4-5-haiku`, `gemini-3-flash` (in order).

If an explicit `provider` and `model` are set in the digest config, those take precedence and no auto-detection runs.

When the resolver returns `undefined` AND `digestRequested === true` (see `digestRequested` predicate), the extension's mode-resolution verdict SHALL be `misconfigured` (see `session-indexing` capability), NOT a graceful demotion to a different mode. The session-digest layer never decides the active mode — it only contributes the "digest model resolved?" signal to the binary mode resolver.

#### Scenario: Auto-detect picks first available model

- **WHEN** digest config has no `provider`/`model`
- **AND** `ctx.modelRegistry.getAvailable()` returns models including `gpt-5.4-mini` and `claude-4-5-haiku` but not `gpt-5.4-nano`
- **THEN** the resolver returns `gpt-5.4-mini` (highest-priority available)

#### Scenario: Explicit override skips auto-detect

- **WHEN** digest config sets `provider: "anthropic"` and `model: "claude-4-5-sonnet"`
- **AND** the priority-list models are also available
- **THEN** the resolver returns `anthropic/claude-4-5-sonnet`

#### Scenario: No suitable model available with embedder configured AND digestRequested true → misconfigured (after async retry)

- **WHEN** none of the priority-list models are available and no explicit config is set
- **AND** an embedder IS configured in `~/.pi/session-search/config.json`
- **AND** `digestRequested === true` (e.g., `~/.pi/session-search/digest.json` exists)
- **AND** the registry does NOT populate within the async-retry window (~1000ms)
- **THEN** the resolver returns `undefined` AFTER the bounded retry
- **AND** the mode-resolution verdict is `misconfigured` with `missing: "digest"`
- **AND** search/digest commands and tools have verdict-aware bodies that return the remediation message on invocation
- **AND** `/session-embeddings-setup` and `/digest:settings` work normally (they ARE the recovery affordance)
- **AND** the extension sets a persistent error status line and emits ONE error notify per `session_start` (see `session-indexing` Mode auto-detection requirement)

#### Scenario: Registry populates within retry window → verdict transitions to digest-hybrid silently

- **WHEN** the synchronous first verdict resolution returns `misconfigured (missing: "digest")` because `ctx.modelRegistry.getAvailable()` has not yet populated
- **AND** `digestRequested === true`
- **AND** the registry populates within the ~1000ms retry window (the second resolution sees the digest model)
- **THEN** the verdict resolves to `digest-hybrid`
- **AND** no misconfigured notify or status line is shown
- **AND** the user does not need to `/reload` to recover from the registry-population race
- **AND** the resolver SHALL NOT retry for `missing: "embedder"` cases (embedder construction is synchronous; no benefit from retry)

#### Scenario: Legacy hybrid-raw user with no digest model on v3.0.0 upgrade → misconfigured + recovery commands

- **WHEN** a v2.x user upgrades to v3.0.0 with `lastMode === "hybrid-raw"` on disk and an embedder configured but `digestRequested === true` and no digest model resolvable
// ... 67 more lines (total: 116)
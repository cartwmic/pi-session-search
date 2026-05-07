## MODIFIED Requirements

### Requirement: Legacy config field migration

The loader SHALL detect and refuse legacy embedder configs that used the upstream's `type` discriminator field with non-`openai-compatible` values.

`createEmbedder(config.embedder, ...)` SHALL run BEFORE `resolveModeVerdict`. The legacy-rejection notify SHALL fire regardless of the eventual verdict (it is a configuration error that the user needs to know about even if their downstream verdict is `fts-raw`). The verdict resolver consumes the embedder-construction outcome (`null` if rejected, `Embedder` instance if successful) as one of its inputs.

When a legacy embedder is rejected, the resulting verdict depends on `digestRequested` (defined in `session-digest`: true if a digest config file exists OR explicit provider+model overrides are set):
- If `digestRequested === true`: rejected embedder + present digest intent resolves to `misconfigured` with `missing: "embedder"` (or `missing: "both"` if no digest model resolves either). The user sees the misconfigured remediation notify directing them to fix the embedder OR remove the digest config.
- If `digestRequested === false`: rejected embedder + no digest intent resolves to `fts-raw` (no embedder + no digest = no intent for digest-hybrid).

The legacy-rejection notify is emitted regardless of which downstream verdict applies.

#### Scenario: Legacy `type: "openai-compatible"` is silently stripped

- **WHEN** the loaded `config.json` contains `embedder: {type: "openai-compatible", baseUrl: ..., model: ...}`
- **THEN** the `type` field is silently ignored
- **AND** the embedder is constructed normally from the other fields

#### Scenario: Legacy `type: "bedrock"` with no digest intent → fts-raw

- **WHEN** the loaded `config.json` contains `embedder: {type: "bedrock", profile: "default", region: "us-east-1", model: "amazon.titan-embed-text-v2:0"}`
- **AND** `digestRequested === false` (no `digest.json` file exists in any scope AND no explicit `provider`/`model` overrides are present in the in-memory digest config)
- **THEN** `createEmbedder` returns `null` and emits one `ctx.ui.notify("session-search: legacy embedder type 'bedrock' is no longer supported. Run /session-embeddings-setup to reconfigure with a /v1/embeddings-compatible endpoint (e.g., LiteLLM proxy).", "error")`
- **AND** the verdict resolves to `fts-raw`
- **AND** the extension boots normally in fts-raw with `sessions-fts.db` populated

#### Scenario: Legacy `type: "bedrock"` with digest intent → misconfigured

- **WHEN** the loaded `config.json` contains `embedder: {type: "bedrock", ...}`
- **AND** `digestRequested === true` (any of: `~/.pi/session-search/digest.json` exists in global or project scope, OR explicit `provider`+`model` overrides are present)
- **THEN** `createEmbedder` returns `null` and emits the legacy-rejection notify
- **AND** the verdict resolves to `misconfigured` with `missing: "embedder"` (if a digest model resolves) OR `missing: "both"` (if no digest model resolves either)
- **AND** the persistent status line is set to the misconfigured message (matching the verdict's `missing` value)
- **AND** search/digest commands and tools are registered at module load with verdict-aware bodies that return the remediation message on invocation
- **AND** the recovery commands `/session-embeddings-setup` and `/digest:settings` are registered AND their handlers work normally

#### Scenario: createEmbedder runs before verdict resolution

- **WHEN** the extension's `session_start` handler runs
- **THEN** `createEmbedder(config.embedder, notifyFn)` is invoked as part of the synchronous startup sequence BEFORE `resolveModeVerdict` is called
- **AND** any legacy-rejection notify has fired by the time verdict resolution begins
- **AND** `resolveModeVerdict` consumes the embedder construction outcome (null vs Embedder instance) when computing its verdict

#### Scenario: Double-notify when bedrock + digestRequested + no model resolvable

- **WHEN** the loaded `config.json` has a legacy bedrock embedder AND `digestRequested === true` AND no digest model resolves (verdict is `misconfigured (missing: "both")`)
- **THEN** the user sees TWO notifies on the same `session_start`:
  1. The legacy-bedrock-rejection notify (from `createEmbedder`).
  2. The misconfigured-verdict remediation notify (from the verdict-resolution path).
- **AND** ordering is: legacy-rejection notify first, verdict notify second
- **AND** this stacking is intentional, NOT a bug — the user needs to see both pieces of information; the legacy notify points at `/session-embeddings-setup` while the verdict notify mentions both config files
- **AND** if the user runs `/session-embeddings-setup` to fix only the embedder, the next `session_start` shows only the verdict notify (now `missing: "digest"`), and the legacy notify does NOT re-fire because the config file is no longer using the legacy `type` field

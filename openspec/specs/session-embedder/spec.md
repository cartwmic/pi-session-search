# session-embedder Specification

## Purpose
TBD - created by archiving change add-digest-driven-indexing. Update Purpose after archive.
## Requirements
### Requirement: Single openai-compatible embedder class

The system SHALL provide exactly one embedder implementation: `OpenAICompatibleEmbedder`. It calls `POST <baseUrl>/v1/embeddings` with payload `{input: string[], model: string, dimensions?: number}` and `Authorization: Bearer <apiKey>` header.

The class SHALL implement the `Embedder` interface:

```ts
interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedBatch(texts: string[], signal?: AbortSignal): Promise<(number[] | null)[]>;
}
```

Batch size SHALL be 100 inputs per HTTP call. Inputs longer than 12000 characters SHALL be truncated client-side before being sent.

The class SHALL pass `dimensions` in the body only if it is defined in the config; absent dimensions means "use whatever the model returns natively." The stored embedding vector length is determined by the response, not pinned client-side.

#### Scenario: Embed a single text

- **WHEN** `embedder.embed("hello world")` is called
- **THEN** the embedder sends one HTTP request to `<baseUrl>/v1/embeddings` with `input: ["hello world"]`
- **AND** returns the resulting vector as a `number[]`

#### Scenario: Embed a batch larger than 100

- **WHEN** `embedder.embedBatch(texts)` is called with `texts.length = 250`
- **THEN** the embedder sends 3 HTTP requests (100 + 100 + 50) and returns 250 vectors in input order

#### Scenario: Long input is truncated

- **WHEN** `embedder.embed(text)` is called with `text.length = 50000`
- **THEN** the request body's `input[0]` is the first 12000 characters of `text`

#### Scenario: API error surfaces

- **WHEN** the embeddings endpoint returns HTTP 401 with body `{"error": "invalid api key"}`
- **THEN** `embed()` throws `Error("Embeddings API 401: ...")` including the first 200 chars of the response body

#### Scenario: Dimensions passthrough

- **WHEN** the embedder is configured with `dimensions: 512`
- **THEN** outgoing requests include `dimensions: 512` in the body
- **AND** stored vectors have length 512

#### Scenario: No dimensions configured

- **WHEN** the embedder is configured without `dimensions`
- **THEN** outgoing requests omit the `dimensions` field
- **AND** stored vectors have whatever length the model returns

### Requirement: Embedder configuration

The embedder config in `~/.pi/session-search/config.json` SHALL have this shape:

```ts
interface EmbedderConfig {
  baseUrl: string;        // required, e.g. "https://api.openai.com"
  apiKey?: string;        // optional; falls back to env var lookup
  apiKeyEnv?: string;     // optional; name of env var to read for the key (default: "OPENAI_API_KEY" if neither apiKey nor apiKeyEnv is set)
  model: string;          // required, e.g. "text-embedding-3-small"
  dimensions?: number;    // optional; passed through to API and stored as-is
  headers?: Record<string, string>; // optional, merged into request headers
}
```

The setup command `/session:embedder` SHALL prompt for `baseUrl`, `model`, and one of `apiKey` or `apiKeyEnv`, with no provider-specific branching.

#### Scenario: Config with apiKeyEnv resolves at runtime

- **WHEN** `apiKeyEnv: "OPENAI_API_KEY"` is in config
- **AND** `process.env.OPENAI_API_KEY = "sk-real-key"` at runtime
- **THEN** outgoing requests use `Authorization: Bearer sk-real-key`

#### Scenario: apiKey takes precedence over apiKeyEnv

- **WHEN** config has both `apiKey: "sk-explicit"` and `apiKeyEnv: "OPENAI_API_KEY"`
- **THEN** outgoing requests use `Authorization: Bearer sk-explicit`

#### Scenario: Custom headers are merged

- **WHEN** config has `headers: {"X-Custom": "v1"}`
- **THEN** outgoing requests include both `Authorization: Bearer ...` and `X-Custom: v1`

#### Scenario: Setup command writes config

- **WHEN** the user runs `/session:embedder`
- **AND** answers the prompts with `baseUrl: "https://api.together.xyz"`, `model: "togethercomputer/m2-bert-80M-8k-retrieval"`, `apiKey: "tk-x"`
- **THEN** `~/.pi/session-search/config.json` contains a valid `EmbedderConfig` with those values
- **AND** the user is told to `/reload` to activate

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
- **THEN** `createEmbedder` returns `null` and emits one `ctx.ui.notify("session-search: legacy embedder type 'bedrock' is no longer supported. Run /session:embedder to reconfigure with a /v1/embeddings-compatible endpoint (e.g., LiteLLM proxy).", "error")`
- **AND** the verdict resolves to `fts-raw`
- **AND** the extension boots normally in fts-raw with `sessions-fts.db` populated

#### Scenario: Legacy `type: "bedrock"` with digest intent → misconfigured

- **WHEN** the loaded `config.json` contains `embedder: {type: "bedrock", ...}`
- **AND** `digestRequested === true` (any of: `~/.pi/session-search/digest.json` exists in global or project scope, OR explicit `provider`+`model` overrides are present)
- **THEN** `createEmbedder` returns `null` and emits the legacy-rejection notify
- **AND** the verdict resolves to `misconfigured` with `missing: "embedder"` (if a digest model resolves) OR `missing: "both"` (if no digest model resolves either)
- **AND** the persistent status line is set to the misconfigured message (matching the verdict's `missing` value)
- **AND** search/digest commands and tools are registered at module load with verdict-aware bodies that return the remediation message on invocation
- **AND** the recovery commands `/session:embedder` and `/session:summarizer` are registered AND their handlers work normally

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
- **AND** this stacking is intentional, NOT a bug — the user needs to see both pieces of information; the legacy notify points at `/session:embedder` while the verdict notify mentions both config files
- **AND** if the user runs `/session:embedder` to fix only the embedder, the next `session_start` shows only the verdict notify (now `missing: "digest"`), and the legacy notify does NOT re-fire because the config file is no longer using the legacy `type` field

### Requirement: Removed providers and dependencies

The system SHALL NOT ship bedrock-specific, mistral-specific, or ollama-specific embedder classes.

The `package.json` `optionalDependencies` SHALL NOT include `@aws-sdk/client-bedrock-runtime` or `@aws-sdk/credential-providers`.

The `/session:embedder` command SHALL NOT contain provider-selection branches for bedrock / mistral / ollama. (Users wanting those endpoints configure them via the openai-compatible config with appropriate `baseUrl` — and in the case of Bedrock, via a LiteLLM proxy.)

#### Scenario: No AWS SDK in dependency tree

- **WHEN** `npm ls @aws-sdk/client-bedrock-runtime` is run after `npm install`
- **THEN** the package is not present

#### Scenario: Setup has no provider menu

- **WHEN** the user runs `/session:embedder`
- **THEN** the prompts are limited to `baseUrl`, `model`, `apiKey` / `apiKeyEnv`, optional `dimensions`, optional extra session/archive directories
- **AND** there is no "select provider: openai / mistral / bedrock / ollama / openai-compatible" menu


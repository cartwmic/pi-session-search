## ADDED Requirements

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

The setup command `/session-embeddings-setup` SHALL prompt for `baseUrl`, `model`, and one of `apiKey` or `apiKeyEnv`, with no provider-specific branching.

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

- **WHEN** the user runs `/session-embeddings-setup`
- **AND** answers the prompts with `baseUrl: "https://api.together.xyz"`, `model: "togethercomputer/m2-bert-80M-8k-retrieval"`, `apiKey: "tk-x"`
- **THEN** `~/.pi/session-search/config.json` contains a valid `EmbedderConfig` with those values
- **AND** the user is told to `/reload` to activate

### Requirement: Legacy config field migration

The loader SHALL detect and refuse legacy embedder configs that used the upstream's `type` discriminator field with non-`openai-compatible` values.

#### Scenario: Legacy `type: "openai-compatible"` is silently stripped

- **WHEN** the loaded `config.json` contains `embedder: {type: "openai-compatible", baseUrl: ..., model: ...}`
- **THEN** the `type` field is silently ignored
- **AND** the embedder is constructed normally from the other fields

#### Scenario: Legacy `type: "bedrock"` (or other non-openai-compatible) is refused

- **WHEN** the loaded `config.json` contains `embedder: {type: "bedrock", profile: "default", region: "us-east-1", model: "amazon.titan-embed-text-v2:0"}`
- **THEN** the loader emits one `ctx.ui.notify("session-search: legacy embedder type 'bedrock' is no longer supported. Run /session-embeddings-setup to reconfigure with a /v1/embeddings-compatible endpoint (e.g., LiteLLM proxy).", "error")`
- **AND** the embedder is NOT constructed
- **AND** the extension falls back to `fts-raw` mode (no embeddings)

### Requirement: Removed providers and dependencies

The system SHALL NOT ship bedrock-specific, mistral-specific, or ollama-specific embedder classes.

The `package.json` `optionalDependencies` SHALL NOT include `@aws-sdk/client-bedrock-runtime` or `@aws-sdk/credential-providers`.

The `/session-embeddings-setup` command SHALL NOT contain provider-selection branches for bedrock / mistral / ollama. (Users wanting those endpoints configure them via the openai-compatible config with appropriate `baseUrl` — and in the case of Bedrock, via a LiteLLM proxy.)

#### Scenario: No AWS SDK in dependency tree

- **WHEN** `npm ls @aws-sdk/client-bedrock-runtime` is run after `npm install`
- **THEN** the package is not present

#### Scenario: Setup has no provider menu

- **WHEN** the user runs `/session-embeddings-setup`
- **THEN** the prompts are limited to `baseUrl`, `model`, `apiKey` / `apiKeyEnv`, optional `dimensions`, optional extra session/archive directories
- **AND** there is no "select provider: openai / mistral / bedrock / ollama / openai-compatible" menu

/**
 * Embedding interface + factory.
 * Single OpenAI-compatible embedder — calls POST <baseUrl>/v1/embeddings.
 * Bedrock, Mistral, and Ollama provider-specific classes have been removed;
 * those endpoints are reachable via baseUrl configuration.
 */

export interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]>;
}

/** New flat config — no `type` discriminator. */
export interface EmbedderConfig {
  /** Required. e.g. "https://api.openai.com" */
  baseUrl: string;
  /** Required. e.g. "text-embedding-3-small" */
  model: string;
  /** Explicit API key. Takes precedence over apiKeyEnv and OPENAI_API_KEY. */
  apiKey?: string;
  /** Name of env var to read for the key. Fallback if apiKey is absent. */
  apiKeyEnv?: string;
  /** Optional dimensions, passed through to the API when set. */
  dimensions?: number;
  /** Optional extra headers merged into every request. */
  headers?: Record<string, string>;
}

/**
 * Factory. Returns null (and fires notify) in two cases:
 *   1. Legacy `type` field with a non-openai-compatible value.
 *   2. No API key resolvable after checking apiKey → apiKeyEnv → OPENAI_API_KEY.
 *
 * @param config   EmbedderConfig (may carry a legacy `type` field at runtime).
 * @param notify   Optional callback for user-visible warnings, matches
 *                 ctx.ui.notify(message, level) from the extension API.
 */
export function createEmbedder(
  config: EmbedderConfig,
  notify?: (message: string, level: string) => void
): Embedder | null {
  // ── Task 1.11: legacy type migration ──────────────────────────────
  // At runtime a user's existing config.json may still carry the upstream
  // `type` discriminator field.  Cast to any to inspect it.
  const raw = config as EmbedderConfig & { type?: string };
  if (raw.type !== undefined) {
    if (raw.type !== "openai-compatible") {
      notify?.(
        `session-search: legacy embedder type '${raw.type}' is no longer supported. ` +
          `Run /session:embedder to reconfigure with a /v1/embeddings-compatible ` +
          `endpoint (e.g., LiteLLM proxy).`,
        "error"
      );
      return null;
    }
    // type === "openai-compatible" → silently strip; fall through to construction
  }

  // ── Task 1.6: apiKey resolution ───────────────────────────────────
  const key =
    config.apiKey ||
    (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined) ||
    process.env.OPENAI_API_KEY;

  if (!key) {
    notify?.(
      "session-search: embedder configured but no API key resolvable. " +
        "Set apiKey, apiKeyEnv, or OPENAI_API_KEY in env. Falling back to fts-raw mode.",
      "warning"
    );
    return null;
  }

  return new OpenAICompatibleEmbedder(
    key,
    config.model,
    config.baseUrl,
    config.dimensions,
    config.headers
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function truncate(text: string, maxChars = 12000): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

// ─── OpenAI-Compatible ────────────────────────────────────────────────

class OpenAICompatibleEmbedder implements Embedder {
  private endpoint: string;

  constructor(
    private apiKey: string,
    private model: string,
    baseUrl: string,
    private dimensions?: number,
    private extraHeaders?: Record<string, string>
  ) {
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/v1/embeddings`;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const [result] = await this.embedBatch([text], signal);
    if (!result) throw new Error("Embedding failed");
    return result;
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]> {
    const BATCH = 100;
    const results: (number[] | null)[] = new Array(texts.length).fill(null);

    for (let i = 0; i < texts.length; i += BATCH) {
      if (signal?.aborted) throw new Error("Aborted");
      const batch = texts.slice(i, i + BATCH).map((t) => truncate(t));

      const body: Record<string, unknown> = {
        input: batch,
        model: this.model,
      };
      // Only include dimensions when explicitly configured
      if (this.dimensions !== undefined) {
        body.dimensions = this.dimensions;
      }

      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          // Task 1.7: merge custom headers (may override defaults except Authorization)
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(
          `Embeddings API ${res.status}: ${errBody.slice(0, 200)}`
        );
      }

      const json = (await res.json()) as {
        data: { embedding: number[]; index: number }[];
      };
      for (const item of json.data) {
        results[i + item.index] = item.embedding;
      }
    }
    return results;
  }
}

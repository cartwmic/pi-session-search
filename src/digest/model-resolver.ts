import type { Model, Api } from "@mariozechner/pi-ai";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DigestModelConfig {
	/** Explicit provider override (e.g. "anthropic"). */
	provider?: string;
	/** Explicit model-id override (e.g. "claude-haiku-4-5"). */
	model?: string;
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve the explicitly configured digest LLM model from a registry.
 *
 * Digest generation never selects a model implicitly. Both `provider` and
 * `model` must be present in digest.json and must match an available registry
 * entry. Missing, partial, or stale configuration returns undefined.
 */
export function resolveModel(
	config: DigestModelConfig,
	registry: Model<Api>[],
): Model<Api> | undefined {
	if (!config.provider || !config.model) return undefined;

	return registry.find(
		(m) =>
			(m.provider === config.provider && m.id === config.model) ||
			`${m.provider}/${m.id}` === `${config.provider}/${config.model}`,
	);
}

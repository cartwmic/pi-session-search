import type { Model, Api } from "@mariozechner/pi-ai";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DigestModelConfig {
	/** Explicit provider override (e.g. "anthropic"). */
	provider?: string;
	/** Explicit model-id override (e.g. "claude-haiku-4-5"). */
	model?: string;
}

// ─── Priority list ────────────────────────────────────────────────────────────
//
// IDs are empirically verified from `pi --list-models` on 2026-04-29:
//   "openai/gpt-5.4-nano"      → openrouter provider
//   "gpt-5.4-mini"             → openai-codex provider  ✅ resolves
//   "claude-haiku-4-5"         → claude-bridge provider
//   "google/gemini-3-flash-preview" → openrouter provider
//
// Phase-0 deviation: the spec's original list used "gpt-5.4-nano" (bare),
// "claude-4-5-haiku", and "gemini-3-flash" — none of which matched any
// Model.id exactly on the dev host.  Updated to the empirically-resolvable
// IDs above.  See tasks.md §0.5 for full deviation note.

export const AUTO_DETECT_MODELS: string[] = [
	"openai/gpt-5.4-nano",
	"gpt-5.4-mini",
	"claude-haiku-4-5",
	"google/gemini-3-flash-preview",
];

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve the digest LLM model from a registry.
 *
 * Priority:
 * 1. Explicit override — if both `config.provider` and `config.model` are set,
 *    find by matching provider+id fields (or composite "provider/id" string).
 * 2. Priority-list scan — try each AUTO_DETECT_MODELS id in order; return the
 *    first registry entry whose `model.id` matches exactly.
 * 3. Returns undefined if no model can be resolved.
 */
export function resolveModel(
	config: DigestModelConfig,
	registry: Model<Api>[],
): Model<Api> | undefined {
	if (config.provider && config.model) {
		return registry.find(
			(m) =>
				(m.provider === config.provider && m.id === config.model) ||
				`${m.provider}/${m.id}` === `${config.provider}/${config.model}`,
		);
	}

	for (const id of AUTO_DETECT_MODELS) {
		const found = registry.find((m) => m.id === id);
		if (found) return found;
	}

	return undefined;
}

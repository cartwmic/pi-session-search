import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Tool } from "@mariozechner/pi-ai";

// ─── SessionDigest ────────────────────────────────────────────────────────────

/**
 * Durable per-session digest produced by the LLM digest builder.
 * Stored at ~/.pi/session-search/digests/<uuid>.json.
 * The `body` field is the primary embedding / FTS target.
 */
export interface SessionDigest {
	schemaVersion: 1;
	/** 200–400 words of plain prose; the embedding/FTS target. */
	body: string;
	/** ≤80 chars; written to pi.setSessionName for the picker UX. */
	headline: string;
	/** ≤5 short topic tags, each ≤32 chars. */
	topics: string[];
	/** Optional 1-sentence outcome (≤200 chars). */
	outcome?: string;
	/** ISO-8601 timestamp of when this digest was generated. */
	generatedAt: string;
	/** "<provider>/<model-id>" of the model that produced this digest. */
	modelId: string;
	/** Estimated tokens of conversation input that produced this digest. */
	inputTokenCount: number;
	/** USD spent on the LLM call producing this digest. */
	cost: number;
}

// ─── Validator ───────────────────────────────────────────────────────────────

const SessionDigestSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	body: Type.String({ minLength: 1 }),
	headline: Type.String({ minLength: 1, maxLength: 80 }),
	topics: Type.Array(Type.String({ maxLength: 32 }), { minItems: 0, maxItems: 5 }),
	outcome: Type.Optional(Type.String({ maxLength: 200 })),
	generatedAt: Type.String({ minLength: 1 }),
	modelId: Type.String({ minLength: 3 }),
	inputTokenCount: Type.Number({ minimum: 0 }),
	cost: Type.Number({ minimum: 0 }),
});

/** Validate an unknown value as a SessionDigest. Returns null if invalid. */
export function validateDigest(obj: unknown): SessionDigest | null {
	if (Value.Check(SessionDigestSchema, obj)) {
		return obj as SessionDigest;
	}
	return null;
}

// ─── submit_digest tool ───────────────────────────────────────────────────────

/**
 * TypeBox schema for the LLM tool call arguments.
 * The builder instructs the LLM to call submit_digest exactly once.
 */
export const DigestArgs = Type.Object({
	body: Type.String({ minLength: 50 }),
	headline: Type.String({ minLength: 1, maxLength: 80 }),
	topics: Type.Array(Type.String({ maxLength: 32 }), { minItems: 0, maxItems: 5 }),
	outcome: Type.Optional(Type.String({ maxLength: 200 })),
});

export type DigestArgsType = Static<typeof DigestArgs>;

/**
 * Tool definition passed to the digest LLM call.
 * Lives here (alongside DigestArgs) so schema and tool stay in sync.
 */
export const submitDigestTool: Tool<typeof DigestArgs> = {
	name: "submit_digest",
	description:
		"Submit a structured digest summarizing the session conversation. " +
		"Call this tool exactly once with the complete digest. " +
		"Do not call any other tools or output any other text.",
	parameters: DigestArgs,
};

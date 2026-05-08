/**
 * Digest builder — pure, event-system-agnostic.
 *
 * Takes a ConversationView (not a pi ctx), so it can be driven by both the
 * live agent_end path and the backfill path without modification.
 * Lifecycle wiring (debounce, session_start reload, setSessionName) is left
 * to digest/lifecycle.ts (Phase 4).
 */

// complete is imported lazily so that tsx's CJS compilation does not
// attempt require("@mariozechner/pi-ai") at load time (pi-ai is ESM-only).
// Production callers omit _completeFn; test callers inject a fake.
import type { Model, Api, AssistantMessage, ToolCall } from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";
import { submitDigestTool, validateDigest, DigestArgs } from "./schema";
import type { SessionDigest } from "./schema";
import type { ConversationView } from "./conversation-view";
import { log } from "../log";

// ─── BuilderState ─────────────────────────────────────────────────────────────

/**
 * In-memory builder state for one session.
 * The persisted subset is stored via storage.saveBuilderState / loadBuilderState.
 *
 * `lastWrittenMessageIndex` — index into ConversationView.messages at the time
 * of the last successful digest write; used as the delta anchor for incremental
 * prompts.  `lastWrittenSummaryIndex` — analogous anchor for compactionSummaries.
 */
export interface BuilderState {
	lastDigest: SessionDigest | null;
	convTokensAtLastWrite: number;
	lastWrittenMessageIndex: number;
	lastWrittenSummaryIndex: number;
	lastWriteTime: number | null;
	pendingCall: boolean;
	dirty: boolean;
}

export function emptyBuilderState(): BuilderState {
	return {
		lastDigest: null,
		convTokensAtLastWrite: 0,
		lastWrittenMessageIndex: 0,
		lastWrittenSummaryIndex: 0,
		lastWriteTime: null,
		pendingCall: false,
		dirty: false,
	};
}

// ─── Token estimation ────────────────────────────────────────────────────────

/**
 * Rough token count: 1 token ≈ 4 chars.
 * Matches the estimator used by pasky/pi-session-summary.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ─── Delta extraction ────────────────────────────────────────────────────────

/**
 * Return a new view containing only `messages[anchor..]`.
 * Anchor 0 returns the full message list (used for full re-summarize).
 * `compactionSummaries` are always carried through unchanged.
 */
export function extractDelta(
	view: ConversationView,
	anchor: number,
): ConversationView {
	return {
		messages: view.messages.slice(anchor),
		compactionSummaries: view.compactionSummaries,
	};
}

// ─── Input capping ───────────────────────────────────────────────────────────

/** Serialize a view to a flat string for length measurement. */
function serializeView(view: ConversationView): string {
	const parts: string[] = [
		...view.compactionSummaries,
		...view.messages.map((m) => `${m.role}: ${m.text}`),
	];
	return parts.join("\n\n");
}

/**
 * Cap the input view to fit within the model's effective context budget.
 *
 * Budget formula (in chars, approximating tokens×4):
 *   min(100_000, contextWindow×4 − maxTokens×4 − envelope)
 *
 * where `envelope` is 4000 when prev-digest is included in the prompt
 * (incremental mode), or 2000 otherwise (full mode).
 *
 * Truncation strategy when over budget:
 *   1. Keep ALL compaction summaries (high-signal, small)
 *   2. Keep the first user message (session opener)
 *   3. Append the most-recent messages from the tail until budget is exhausted
 *   4. Middle messages are dropped
 *
 * Applied to both full and incremental modes.
 */
export function capInput(
	view: ConversationView,
	model: Model<Api>,
	includesPrevDigest: boolean,
): ConversationView {
	const envelope = includesPrevDigest ? 4000 : 2000;
	const contextChars = (model.contextWindow ?? 25_000) * 4;
	const maxTokChars = (model.maxTokens ?? 4_096) * 4;
	const cap = Math.min(100_000, contextChars - maxTokChars - envelope);

	const serialized = serializeView(view);
	if (serialized.length <= cap) return view;

	const summaryText = view.compactionSummaries.join("\n\n");
	const firstMsg = view.messages[0] ?? null;
	const firstMsgText = firstMsg ? `${firstMsg.role}: ${firstMsg.text}` : "";
	const overhead = summaryText.length + firstMsgText.length + 100;

	let remaining = Math.max(0, cap - overhead);

	// Walk from the tail, accumulating recent messages
	const tail: ConversationView["messages"] = [];
	for (let i = view.messages.length - 1; i >= 1; i--) {
		const msg = view.messages[i];
		const len = `${msg.role}: ${msg.text}\n\n`.length;
		if (len > remaining) break;
		remaining -= len;
		tail.unshift(msg);
	}

	const messages: ConversationView["messages"] = [];
	if (firstMsg) messages.push(firstMsg);
	messages.push(...tail);

	return { messages, compactionSummaries: view.compactionSummaries };
}

// ─── Prompt building ──────────────────────────────────────────────────────────

function serializeForPrompt(view: ConversationView): string {
	const parts: string[] = [];
	for (const s of view.compactionSummaries) {
		parts.push(`[compaction summary]: ${s}`);
	}
	for (const m of view.messages) {
		parts.push(`${m.role === "user" ? "User" : "Assistant"}: ${m.text}`);
	}
	return parts.join("\n\n");
}

// The digest builder asks the LLM to call `submit_digest` exactly once with
// a structured argument matching the SessionDigest schema. Direct providers
// (openai, anthropic, google, mistral, openrouter) return the call as a
// `toolCall` content block. claude-bridge ≥ commit 202ca4b classifies
// non-pi-registered tools via `pi.getActiveTools()` and routes them through
// the Claude Agent SDK's `outputFormat.json_schema` channel, synthesizing a
// `toolCall` block from `result.structured_output`. On every working path,
// `extractDigestArgs` finds the call and returns its arguments.
//
// Schema instructions live in the system prompt only — the bridge's capture
// path forwards `ctx.systemPrompt` verbatim, and direct providers always
// honor it.

const SCHEMA_INSTRUCTIONS =
	`Produce a JSON object with EXACTLY these fields (other field names will be rejected):\n` +
	`  - body (string, ≥50 chars): 200–400 words of plain prose describing what was worked on\n` +
	`  - headline (string, 1–80 chars): a concise display title for the session\n` +
	`  - topics (array of strings, max 5, each ≤32 chars): main subject tags\n` +
	`  - outcome (optional string, ≤200 chars): one sentence of what was accomplished\n\n` +
	`Output ONLY the JSON object. No preamble, no markdown fences, no commentary. ` +
	`Field names MUST be exactly "body", "headline", "topics", "outcome" — not "summary", "explanation", "title", "topic", "tags", or anything else.`;

const SYSTEM_PROMPT_BASE =
	`You are a session digest writer. ${SCHEMA_INSTRUCTIONS}`;

const SYSTEM_PROMPT_STRICT =
	`${SYSTEM_PROMPT_BASE}\n\n` +
	`IMPORTANT: Your previous response failed validation. Common mistakes: wrong field names, ` +
	`headline >80 chars, body <50 chars, topics not an array, markdown code fences around the JSON. ` +
	`Output the raw JSON object directly.`;

/**
 * Build the prompt for a digest write.  Pure — no I/O.
 *
 * Mode selection:
 * - `full`        → no prior digest, OR tokens-since-last-write ≥ threshold
 * - `incremental` → prior digest exists AND delta is below threshold
 */
export function buildPrompt(
	state: BuilderState,
	view: ConversationView,
	threshold: number,
	model: Model<Api>,
): { mode: "incremental" | "full"; systemPrompt: string; userMessage: string } {
	const convTokens = estimateTokens(serializeView(view));
	const tokensSinceLastWrite = convTokens - state.convTokensAtLastWrite;
	const hasLastDigest = state.lastDigest != null;

	const mode: "incremental" | "full" =
		!hasLastDigest || tokensSinceLastWrite >= threshold ? "full" : "incremental";

	let userMessage: string;

	if (mode === "incremental") {
		const delta = extractDelta(view, state.lastWrittenMessageIndex);
		const capped = capInput(delta, model, /* includesPrevDigest */ true);
		const deltaText = serializeForPrompt(capped);
		userMessage =
			`Previous digest:\n${state.lastDigest!.body}\n\n` +
			`New messages since last digest:\n${deltaText}\n\n` +
			`Update the digest if anything material changed. Otherwise repeat the previous digest verbatim. ` +
			`Call submit_digest now.`;
	} else {
		const capped = capInput(view, model, /* includesPrevDigest */ false);
		const convText = serializeForPrompt(capped);
		userMessage =
			`Here is the full conversation to digest:\n\n${convText}\n\n` +
			`Call submit_digest now.`;
	}

	return { mode, systemPrompt: SYSTEM_PROMPT_BASE, userMessage };
}

// ─── Generate ────────────────────────────────────────────────────────────────

type CompleteFn = (
	model: Model<Api>,
	ctx: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] },
	opts?: { signal?: AbortSignal },
) => Promise<AssistantMessage>;

export interface GenerateOpts {
	signal?: AbortSignal;
	/** Threshold (tokens) above which full re-summarize is triggered. Default: 10 000. */
	resummarizeTokenThreshold?: number;
	/**
	 * Override the complete function.  Used in tests to inject a fake.
	 * Production code leaves this undefined and uses pi-ai's `complete`.
	 */
	_completeFn?: CompleteFn;
}

/**
 * Generate a SessionDigest for a session conversation.
 *
 * Calls `complete()` from @mariozechner/pi-ai with the `submit_digest` tool.
 * On tool-call validation failure: retries once with a stricter prompt.
 * If both attempts fail, returns null (the caller must leave the prior digest
 * untouched and must NOT call pi.setSessionName).
 *
 * Returns `{ digest, anchor }` where `anchor = view.messages.length` — the
 * caller stores this as `lastWrittenMessageIndex` for the next incremental prompt.
 */
export async function generateDigest(
	model: Model<Api>,
	view: ConversationView,
	state: BuilderState,
	opts: GenerateOpts = {},
): Promise<{ digest: SessionDigest; anchor: number } | null> {
	const threshold = opts.resummarizeTokenThreshold ?? 10_000;

	// Resolve the complete function: use the injected fake (tests) or lazy-load
	// pi-ai's real complete (production). The lazy import avoids tsx compiling
	// a static `import` to a CJS `require()` at module load time, which would
	// fail because @mariozechner/pi-ai is an ESM-only package.
	let completeFn: CompleteFn;
	if (opts._completeFn) {
		completeFn = opts._completeFn;
	} else {
		const piAi = await import("@mariozechner/pi-ai");
		completeFn = piAi.complete as unknown as CompleteFn;
	}

	const { systemPrompt, userMessage } = buildPrompt(state, view, threshold, model);

	// Pass `submit_digest` as a capture-only tool on every provider. Direct API
	// providers return the tool call as terminal output. claude-bridge ≥ the
	// output-capture commit (202ca4b) classifies non-pi-registered tools via
	// pi.getActiveTools() and routes them through the SDK's outputFormat
	// channel, also returning the call as terminal output. The JSON-text
	// fallback in extractDigestArgs remains as a defensive safety net.
	const makeCtx = (sysPrompt: string, msg: string) => ({
		systemPrompt: sysPrompt,
		messages: [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: msg }],
				timestamp: Date.now(),
			},
		],
		tools: [submitDigestTool],
	});

	// Extract digest args from a `submit_digest` tool call in the response.
	// Direct providers return the call as a toolCall content block. claude-bridge
	// (≥ commit 202ca4b) synthesizes a toolCall block from outputFormat.json_schema
	// structured_output. If the model fails to call the tool, return null so the
	// caller can retry with a stricter prompt.
	function extractDigestArgs(response: AssistantMessage): unknown | null {
		const toolCall = response.content.find(
			(c): c is ToolCall =>
				(c as ToolCall).type === "toolCall" &&
				(c as ToolCall).name === "submit_digest",
		) as ToolCall | undefined;
		return toolCall?.arguments ?? null;
	}

	const attemptCall = async (
		sysPrompt: string,
		msg: string,
	): Promise<{ digest: SessionDigest; response: AssistantMessage } | null> => {
		let response: AssistantMessage;
		try {
			response = await completeFn(model, makeCtx(sysPrompt, msg), {
				signal: opts.signal,
			});
		} catch {
			return null;
		}

		const rawArgs = extractDigestArgs(response);
		if (rawArgs === null) {
			// Always log extraction failure — always-on logger; PI_SESSION_SEARCH_DEBUG_DIGEST
			// kept as opt-in for the *full* response dump (can be large).
			log.warn({ comp: "digest" }, "extractDigestArgs returned null");
			if (process.env.PI_SESSION_SEARCH_DEBUG_DIGEST) {
				log.debug(
					{ comp: "digest", responseSlice: JSON.stringify(response, null, 2).slice(0, 2000) },
					"extractDigestArgs response dump",
				);
			}
			return null;
		}
		if (process.env.PI_SESSION_SEARCH_DEBUG_DIGEST) {
			log.debug({ comp: "digest", rawArgs: JSON.stringify(rawArgs).slice(0, 500) }, "rawArgs");
		}

		// Validate arguments against the TypeBox schema
		if (!Value.Check(DigestArgs, rawArgs)) {
			return null;
		}

		const args = rawArgs as {
			body: string;
			headline: string;
			topics: string[];
			outcome?: string;
		};

		const digest: SessionDigest = {
			schemaVersion: 1,
			body: args.body,
			headline: args.headline,
			topics: args.topics,
			...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
			generatedAt: new Date().toISOString(),
			modelId: `${model.provider}/${model.id}`,
			inputTokenCount: estimateTokens(serializeView(view)),
			cost: response.usage?.cost?.total ?? 0,
		};

		return { digest, response };
	};

	// First attempt
	const first = await attemptCall(systemPrompt, userMessage);
	if (first) {
		return { digest: first.digest, anchor: view.messages.length };
	}

	// Retry with a stricter prompt
	const second = await attemptCall(SYSTEM_PROMPT_STRICT, userMessage);
	if (second) {
		return { digest: second.digest, anchor: view.messages.length };
	}

	return null;
}

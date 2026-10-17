/**
 * Digest builder — pure, event-system-agnostic.
 *
 * Takes a ConversationView (not a pi ctx), so it can be driven by both the
 * live agent_end path and the backfill path without modification.
 * Lifecycle wiring (debounce, session_start reload, setSessionName) is left
 * to digest/lifecycle.ts (Phase 4).
 */

import type { Model, Api, AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { submitDigestTool, validateDigest, DigestArgs } from "./schema";
import type { SessionDigest } from "./schema";
import type { ConversationView } from "./conversation-view";
import { log } from "../log";
import type { CompleteFn } from "./completion";

export type { CompleteFn } from "./completion";

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

/** First user message is kept for context but never allowed to dominate the budget. */
const FIRST_MESSAGE_MAX_CHARS = 4_000;
/** Lower bound for the compaction-summary share, so tiny windows still keep small summaries. */
const SUMMARY_FLOOR_CHARS = 12_000;

/** Keep the start and end of an over-long text, with an explicit marker for what was dropped. */
export function clipMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const marker = (n: number) => `
[... ${n} characters omitted ...]
`;
	const room = Math.max(0, max - marker(text.length).length);
	const head = Math.ceil(room * 2 / 3), tail = room - head;
	return text.slice(0, head) + marker(text.length - head - tail) + (tail > 0 ? text.slice(text.length - tail) : "");
}

/**
 * Cap the input view to fit within the model's effective context budget.
 *
 * Budget formula (in chars, approximating tokens×4):
 *   min(100_000, contextWindow×4 − maxTokens×4 − envelope) × scale
 *
 * where `envelope` is 4000 when prev-digest is included in the prompt
 * (incremental mode), or 2000 otherwise (full mode), and `scale` (0 < scale ≤ 1)
 * is lowered after the provider reported a context-window error.
 *
 * Every part of the prompt is held to the budget (a compaction summary can be ~300 000 chars
 * and a long session can carry dozens of them; keeping them all uncapped made the prompt exceed
 * the window on every attempt):
 *   1. Compaction summaries get at most max(12 000, 60% of the budget), newest first. The newest
 *      one supersedes the earlier ones, so older ones are kept only while they fit whole; a newest
 *      summary that alone exceeds the share is clipped (start and end kept, middle marked).
 *   2. The first user message (session opener) is kept, clipped to 4 000 chars.
 *   3. The most-recent messages from the tail fill what is left; middle messages are dropped.
 *
 * A view already within the budget is returned unchanged. Applied to both full and incremental modes.
 */
export function capInput(
	view: ConversationView,
	model: Model<Api>,
	includesPrevDigest: boolean,
	scale = 1,
): ConversationView {
	const envelope = includesPrevDigest ? 4000 : 2000;
	const contextChars = (model.contextWindow ?? 25_000) * 4;
	const maxTokChars = (model.maxTokens ?? 4_096) * 4;
	const factor = Number.isFinite(scale) && scale > 0 ? Math.min(1, scale) : 1;
	const cap = Math.floor(Math.min(100_000, contextChars - maxTokChars - envelope) * factor);

	const serialized = serializeView(view);
	if (serialized.length <= cap) return view;

	// 1. compaction summaries, newest first, within their share
	const summaryBudget = Math.max(SUMMARY_FLOOR_CHARS, Math.floor(cap * 0.6));
	const keptSummaries: string[] = [];
	let summaryUsed = 0, omitted = 0;
	for (let i = view.compactionSummaries.length - 1; i >= 0; i--) {
		const text = view.compactionSummaries[i];
		const cost = text.length + 2;
		if (keptSummaries.length === 0 && cost > summaryBudget) { const clipped = clipMiddle(text, summaryBudget - 2); keptSummaries.unshift(clipped); summaryUsed += clipped.length + 2; continue; }
		if (summaryUsed + cost > summaryBudget) { omitted++; continue; }
		keptSummaries.unshift(text); summaryUsed += cost;
	}
	const summaries = omitted > 0 ? [`[${omitted} earlier compaction summaries omitted]`, ...keptSummaries] : keptSummaries;
	if (omitted > 0) summaryUsed += summaries[0].length + 2;

	// 2. first message, clipped
	const firstMsg = view.messages[0] ?? null;
	const firstText = firstMsg ? clipMiddle(firstMsg.text, FIRST_MESSAGE_MAX_CHARS) : "";
	const firstMsgText = firstMsg ? `${firstMsg.role}: ${firstText}` : "";
	const overhead = summaryUsed + firstMsgText.length + 100;

	// 3. recent messages fill the rest
	let remaining = Math.max(0, cap - overhead);

	// Walk from the tail, accumulating recent messages
	const tail: ConversationView["messages"] = [];
	for (let i = view.messages.length - 1; i >= 1; i--) {
		const msg = view.messages[i];
		const len = `${msg.role}: ${msg.text}

`.length;
		if (len > remaining) break;
		remaining -= len;
		tail.unshift(msg);
	}

	const messages: ConversationView["messages"] = [];
	if (firstMsg) messages.push(firstText === firstMsg.text ? firstMsg : { ...firstMsg, text: firstText });
	messages.push(...tail);

	return { messages, compactionSummaries: summaries };
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
	`  - headline (string, 1–80 chars): a stable title describing the session as a whole — the through-line or overarching goal, not the latest activity. Treat the headline as sticky: do not rewrite it to track tactical shifts in the work; only change it when the session's overall topic has fundamentally pivoted.\n` +
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
	budgetScale = 1,
): { mode: "incremental" | "full"; systemPrompt: string; userMessage: string } {
	const convTokens = estimateTokens(serializeView(view));
	const tokensSinceLastWrite = convTokens - state.convTokensAtLastWrite;
	const hasLastDigest = state.lastDigest != null;

	const mode: "incremental" | "full" =
		!hasLastDigest || tokensSinceLastWrite >= threshold ? "full" : "incremental";

	let userMessage: string;

	if (mode === "incremental") {
		const delta = extractDelta(view, state.lastWrittenMessageIndex);
		const capped = capInput(delta, model, /* includesPrevDigest */ true, budgetScale);
		const deltaText = serializeForPrompt(capped);
		userMessage =
			`Previous headline: ${JSON.stringify(state.lastDigest!.headline)}\n` +
			`Previous digest:\n${state.lastDigest!.body}\n\n` +
			`New messages since last digest:\n${deltaText}\n\n` +
			`Keep the previous headline verbatim unless the session's overall topic has fundamentally pivoted; the body should track new activity but the headline should not. ` +
			`Update the digest if anything material changed. Otherwise repeat the previous digest verbatim. ` +
			`Call submit_digest now.`;
	} else {
		const capped = capInput(view, model, /* includesPrevDigest */ false, budgetScale);
		const convText = serializeForPrompt(capped);
		userMessage =
			`Here is the full conversation to digest:\n\n${convText}\n\n` +
			`Call submit_digest now.`;
	}

	return { mode, systemPrompt: SYSTEM_PROMPT_BASE, userMessage };
}

// ─── Generate ────────────────────────────────────────────────────────────────

export interface GenerateOpts {
	signal?: AbortSignal;
	/** Threshold (tokens) above which full re-summarize is triggered. Default: 10 000. */
	resummarizeTokenThreshold?: number;
	/** Host-bound completion function. Production callers resolve this from Pi's ModelRegistry. */
	completeFn?: CompleteFn;
	/** @deprecated Test compatibility alias. Prefer `completeFn`. */
	_completeFn?: CompleteFn;
	/** Input-budget multiplier (0 < scale <= 1). The lifecycle lowers it after a context-window error. Default 1. */
	budgetScale?: number;
	/** Filled in by generateDigest so the caller can react without a changed return type. */
	diagnostics?: GenerateDiagnostics;
}

export interface GenerateDiagnostics {
	/** True when the provider rejected the input as exceeding the context window on the last attempt. */
	contextWindowExceeded?: boolean;
	/** The budget scale used by the last attempt. */
	scaleUsed?: number;
}

/** Provider errors that mean "the input is too large", not a transient failure. Mirrors pi-ai's overflow patterns without a runtime import. */
const CONTEXT_OVERFLOW = /exceeds? the context window|context[ _-]?(window|length)[^.]{0,40}(exceed|too|limit)|maximum context|prompt is too long|input is too long|too many (input )?tokens|reduce the length of the (messages|prompt)|context_length_exceeded/i;
const NOT_OVERFLOW = /rate[ _-]?limit|throttl|quota|overloaded/i;
export function isContextWindowError(message: string | undefined): boolean {
	return !!message && !NOT_OVERFLOW.test(message) && CONTEXT_OVERFLOW.test(message);
}
/** Smallest budget scale a retry will use. */
export const MIN_BUDGET_SCALE = 0.05;

/**
 * Generate a SessionDigest for a session conversation.
 *
 * Calls the supplied host-bound completion function with the `submit_digest` tool.
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

	const completeFn = opts.completeFn ?? opts._completeFn;
	if (!completeFn) {
		throw new Error("generateDigest requires a host-bound completeFn");
	}

	const baseScale = Number.isFinite(opts.budgetScale) && (opts.budgetScale as number) > 0 ? Math.min(1, opts.budgetScale as number) : 1;
	const diag = opts.diagnostics;
	if (diag) { diag.contextWindowExceeded = false; diag.scaleUsed = baseScale; }
	let contextRejected = false; // set by attemptCall when the provider says the input is too large

	const { systemPrompt, userMessage } = buildPrompt(state, view, threshold, model, baseScale);

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
		} catch (err: unknown) {
			const msg2 = err instanceof Error ? err.message : String(err);
			log.warn({ comp: "digest", provider: model.provider, model: model.id, err: msg2 }, "digest complete() threw");
			contextRejected = isContextWindowError(msg2);
			return null;
		}

		// pi-ai's complete() does NOT throw on provider/auth failures — it resolves
		// to an AssistantMessage with stopReason "error" and an errorMessage. Surface
		// that explicitly; otherwise it is silently mis-reported as a missing tool
		// call ("extractDigestArgs returned null"), which masks real causes such as
		// `No API key for provider: cursor`.
		if ((response as { stopReason?: string }).stopReason === "error") {
			const errorMessage =
				(response as { errorMessage?: string }).errorMessage ?? "unknown error";
			contextRejected = isContextWindowError(errorMessage);
			log.warn(
				{ comp: "digest", provider: model.provider, model: model.id, errorMessage },
				"digest completion returned an error response",
			);
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
	contextRejected = false;
	const first = await attemptCall(systemPrompt, userMessage);
	if (first) {
		return { digest: first.digest, anchor: view.messages.length };
	}

	if (contextRejected) {
		// The same input would be rejected again, so a stricter prompt is pointless: retry ONCE with half the budget.
		const scale = Math.max(MIN_BUDGET_SCALE, baseScale / 2);
		if (diag) diag.scaleUsed = scale;
		const smaller = buildPrompt(state, view, threshold, model, scale);
		contextRejected = false;
		const retry = await attemptCall(smaller.systemPrompt, smaller.userMessage);
		if (retry) return { digest: retry.digest, anchor: view.messages.length };
		if (diag) diag.contextWindowExceeded = contextRejected;
		return null;
	}

	// Retry with a stricter prompt (the failure was a missing tool call or a validation error, not the input size)
	const second = await attemptCall(SYSTEM_PROMPT_STRICT, userMessage);
	if (second) {
		return { digest: second.digest, anchor: view.messages.length };
	}
	if (diag) diag.contextWindowExceeded = contextRejected;
	return null;
}

/**
 * ConversationView — a normalized, source-agnostic view of a session.
 *
 * Two adapters bridge the two data paths:
 *
 * ## Live path  (`liveConversationView`)
 * Walks the active branch via `sessionManager.getBranch()`.  By definition
 * this returns only messages on the current branch, so the view is always
 * consistent with what the user is looking at.
 *
 * ## Backfill path  (`parsedConversationView`)
 * Uses the flat output of `parseSession()` — `userMessages[]`, `assistantText`,
 * and `compactionSummaries[]`.  The existing parser does NOT preserve branch
 * graph topology; for sessions with multiple branches the backfill view includes
 * messages from all branches in JSONL order.
 *
 * **Known limitation**: live and backfill views diverge for branched sessions.
 * The first live `agent_end` after a backfill write self-corrects the digest
 * to the active-branch view.  See design.md "Backfill data path" decision.
 *
 * Alternative considered and rejected: extending `ParsedSession` with branch
 * lineage — costs parser changes + storage growth for an uncommon case.
 */

import type { ParsedSession } from "../parser";

// ─── Public interface ─────────────────────────────────────────────────────────

export interface ConversationMessage {
	role: "user" | "assistant";
	text: string;
}

export interface ConversationView {
	messages: ConversationMessage[];
	compactionSummaries: string[];
}

// ─── Live adapter ─────────────────────────────────────────────────────────────

/**
 * Minimal interface needed from sessionManager for the live adapter.
 * Using a structural type (not importing SessionManager directly) keeps
 * this module free of pi-coding-agent at test time.
 */
export interface LiveSource {
	getBranch(): Array<{
		type: string;
		[key: string]: unknown;
	}>;
}

/** Extract plain-text from a pi-ai content block or raw string. */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>)
		.filter((b) => b != null && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join(" ");
}

/**
 * Build a ConversationView from the active branch of a live session.
 *
 * Included: user messages, assistant text-content blocks, compaction summaries.
 * Skipped: tool calls, tool results, thinking blocks, model/branch-summary entries.
 */
export function liveConversationView(sm: LiveSource): ConversationView {
	const entries = sm.getBranch();
	const messages: ConversationMessage[] = [];
	const compactionSummaries: string[] = [];

	for (const entry of entries) {
		if (entry.type === "compaction") {
			const summary = entry["summary"];
			if (typeof summary === "string" && summary) {
				compactionSummaries.push(summary);
			}
			continue;
		}

		if (entry.type === "message") {
			const msg = entry["message"] as { role?: string; content?: unknown } | undefined;
			if (!msg) continue;

			const { role, content } = msg;
			if (role === "user") {
				const text = extractText(content);
				if (text.trim()) messages.push({ role: "user", text });
			} else if (role === "assistant") {
				const text = extractText(content);
				if (text.trim()) messages.push({ role: "assistant", text });
			}
		}
	}

	return { messages, compactionSummaries };
}

// ─── Backfill adapter ─────────────────────────────────────────────────────────

/**
 * Build a ConversationView from a ParsedSession (backfill path).
 *
 * Each item in `userMessages[]` becomes a user-role message.
 * The concatenated `assistantText` becomes a single trailing assistant message.
 * `compactionSummaries` are passed through as-is.
 *
 * Limitation: branch topology is lost — see module docblock.
 */
export function parsedConversationView(parsed: ParsedSession): ConversationView {
	const messages: ConversationMessage[] = parsed.userMessages.map((text) => ({
		role: "user" as const,
		text,
	}));

	if (parsed.assistantText?.trim()) {
		messages.push({ role: "assistant", text: parsed.assistantText });
	}

	return {
		messages,
		compactionSummaries: parsed.compactionSummaries ?? [],
	};
}

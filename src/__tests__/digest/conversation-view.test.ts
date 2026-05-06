import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { liveConversationView, parsedConversationView } from "../../digest/conversation-view";
import type { ParsedSession } from "../../parser";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function messageEntry(role: "user" | "assistant", text: string) {
	return {
		type: "message",
		id: `msg-${Math.random()}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role,
			content: [{ type: "text", text }],
		},
	};
}

function compactionEntry(summary: string) {
	return {
		type: "compaction",
		id: `cmp-${Math.random()}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId: "x",
		tokensBefore: 1000,
	};
}

function modelChangeEntry() {
	return {
		type: "model_change",
		id: "mc-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		provider: "anthropic",
		modelId: "claude-4-5-sonnet",
	};
}

function toolCallEntry() {
	return {
		type: "message",
		id: "tc-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
		},
	};
}

function userStringContent(text: string) {
	return {
		type: "message",
		id: "us-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text },
	};
}

function makeParsed(overrides: Partial<ParsedSession> = {}): ParsedSession {
	return {
		file: "/tmp/test.jsonl",
		id: "test-id",
		startedAt: "2026-01-01T00:00:00Z",
		endedAt: "2026-01-01T01:00:00Z",
		cwd: "/tmp",
		archived: false,
		projectSlug: "--tmp--",
		models: [],
		userMessageCount: 0,
		assistantMessageCount: 0,
		toolCalls: [],
		filesRead: [],
		filesModified: [],
		firstUserMessage: "",
		userMessages: [],
		assistantText: "",
		compactionSummaries: [],
		branchSummaries: [],
		totalCost: 0,
		totalTokens: 0,
		...overrides,
	};
}

// ─── liveConversationView ─────────────────────────────────────────────────────

describe("liveConversationView", () => {
	it("extracts user and assistant messages", () => {
		const sm = {
			getBranch: () => [
				messageEntry("user", "Hello"),
				messageEntry("assistant", "World"),
			],
		};
		const view = liveConversationView(sm);
		assert.equal(view.messages.length, 2);
		assert.equal(view.messages[0].role, "user");
		assert.equal(view.messages[0].text, "Hello");
		assert.equal(view.messages[1].role, "assistant");
		assert.equal(view.messages[1].text, "World");
	});

	it("extracts compaction summaries", () => {
		const sm = {
			getBranch: () => [
				compactionEntry("Summary A"),
				messageEntry("user", "Hello"),
			],
		};
		const view = liveConversationView(sm);
		assert.deepEqual(view.compactionSummaries, ["Summary A"]);
	});

	it("skips model_change entries", () => {
		const sm = {
			getBranch: () => [
				modelChangeEntry(),
				messageEntry("user", "Hi"),
			],
		};
		const view = liveConversationView(sm);
		assert.equal(view.messages.length, 1);
	});

	it("skips assistant messages with no text content", () => {
		const sm = {
			getBranch: () => [toolCallEntry()],
		};
		const view = liveConversationView(sm);
		// toolCall entry has no text block → skipped
		assert.equal(view.messages.length, 0);
	});

	it("handles user message with string content", () => {
		const sm = {
			getBranch: () => [userStringContent("plain string")],
		};
		const view = liveConversationView(sm);
		assert.equal(view.messages.length, 1);
		assert.equal(view.messages[0].text, "plain string");
	});

	it("returns empty view for empty branch", () => {
		const sm = { getBranch: () => [] };
		const view = liveConversationView(sm);
		assert.equal(view.messages.length, 0);
		assert.equal(view.compactionSummaries.length, 0);
	});

	it("collects multiple compaction summaries", () => {
		const sm = {
			getBranch: () => [
				compactionEntry("First"),
				messageEntry("user", "msg"),
				compactionEntry("Second"),
			],
		};
		const view = liveConversationView(sm);
		assert.deepEqual(view.compactionSummaries, ["First", "Second"]);
	});
});

// ─── parsedConversationView ───────────────────────────────────────────────────

describe("parsedConversationView", () => {
	it("maps userMessages to user-role messages", () => {
		const parsed = makeParsed({ userMessages: ["Hello", "World"] });
		const view = parsedConversationView(parsed);
		assert.equal(view.messages.filter((m) => m.role === "user").length, 2);
		assert.equal(view.messages[0].text, "Hello");
	});

	it("appends assistantText as a trailing assistant message", () => {
		const parsed = makeParsed({
			userMessages: ["Hi"],
			assistantText: "Sure, here is the answer.",
		});
		const view = parsedConversationView(parsed);
		const assistantMsgs = view.messages.filter((m) => m.role === "assistant");
		assert.equal(assistantMsgs.length, 1);
		assert.equal(assistantMsgs[0].text, "Sure, here is the answer.");
	});

	it("omits assistantText when it is empty/whitespace", () => {
		const parsed = makeParsed({ userMessages: ["Hi"], assistantText: "   " });
		const view = parsedConversationView(parsed);
		assert.equal(view.messages.filter((m) => m.role === "assistant").length, 0);
	});

	it("passes through compactionSummaries", () => {
		const parsed = makeParsed({
			compactionSummaries: ["Sum A", "Sum B"],
		});
		const view = parsedConversationView(parsed);
		assert.deepEqual(view.compactionSummaries, ["Sum A", "Sum B"]);
	});

	it("handles empty ParsedSession gracefully", () => {
		const view = parsedConversationView(makeParsed());
		assert.equal(view.messages.length, 0);
		assert.equal(view.compactionSummaries.length, 0);
	});

	it("produces messages in user-first order", () => {
		const parsed = makeParsed({
			userMessages: ["First question"],
			assistantText: "First answer",
		});
		const view = parsedConversationView(parsed);
		assert.equal(view.messages[0].role, "user");
		assert.equal(view.messages[1].role, "assistant");
	});
});

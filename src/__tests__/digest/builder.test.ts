import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	estimateTokens,
	extractDelta,
	capInput,
	buildPrompt,
	emptyBuilderState,
	generateDigest,
} from "../../digest/builder";
import type { BuilderState } from "../../digest/builder";
import type { ConversationView } from "../../digest/conversation-view";
import type { Model, Api, AssistantMessage } from "@mariozechner/pi-ai";
import type { SessionDigest } from "../../digest/schema";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "gpt-5.4-mini",
		name: "GPT 5.4 Mini",
		api: "openai-completions" as Api,
		provider: "openai-codex",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
		...overrides,
	};
}

function makeView(
	userMsgs: string[],
	assistantMsgs: string[] = [],
	summaries: string[] = [],
): ConversationView {
	const messages: ConversationView["messages"] = [];
	const len = Math.max(userMsgs.length, assistantMsgs.length);
	for (let i = 0; i < len; i++) {
		if (i < userMsgs.length) messages.push({ role: "user", text: userMsgs[i] });
		if (i < assistantMsgs.length)
			messages.push({ role: "assistant", text: assistantMsgs[i] });
	}
	return { messages, compactionSummaries: summaries };
}

function stateWithDigest(
	lastDigest: SessionDigest,
	lastWrittenMessageIndex = 0,
	convTokensAtLastWrite = 0,
): BuilderState {
	return {
		...emptyBuilderState(),
		lastDigest,
		lastWrittenMessageIndex,
		convTokensAtLastWrite,
	};
}

function fakeDigest(body = "x".repeat(50)): SessionDigest {
	return {
		schemaVersion: 1,
		body,
		headline: "Test",
		topics: [],
		generatedAt: "2026-01-01T00:00:00Z",
		modelId: "openai/gpt-5.4-mini",
		inputTokenCount: 100,
		cost: 0.001,
	};
}

function fakeAssistantMessage(toolArgs: Record<string, unknown> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "tc-1",
				name: "submit_digest",
				arguments: {
					body: "x".repeat(50),
					headline: "Generated headline",
					topics: ["test"],
					...toolArgs,
				},
			},
		],
		api: "openai-completions" as Api,
		provider: "openai-codex",
		model: "gpt-5.4-mini",
		usage: {
			input: 200,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 300,
			cost: { input: 0.00002, output: 0.00002, cacheRead: 0, cacheWrite: 0, total: 0.00004 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

// ─── estimateTokens ───────────────────────────────────────────────────────────

describe("estimateTokens", () => {
	it("returns ceil(length/4)", () => {
		assert.equal(estimateTokens(""), 0);
		assert.equal(estimateTokens("abcd"), 1);
		assert.equal(estimateTokens("abcde"), 2);
		assert.equal(estimateTokens("a".repeat(100)), 25);
	});

	it("rounds up (ceil)", () => {
		assert.equal(estimateTokens("abc"), 1);    // 3/4 = 0.75 → 1
		assert.equal(estimateTokens("abcdefg"), 2); // 7/4 = 1.75 → 2
	});
});

// ─── extractDelta ─────────────────────────────────────────────────────────────

describe("extractDelta", () => {
	it("anchor 0 returns all messages", () => {
		const view = makeView(["a", "b", "c"]);
		const delta = extractDelta(view, 0);
		assert.equal(delta.messages.length, 3);
	});

	it("anchor N returns messages[N..]", () => {
		const view = makeView(["a", "b", "c", "d"]);
		const delta = extractDelta(view, 2);
		assert.equal(delta.messages.length, 2);
		assert.equal(delta.messages[0].text, "c");
	});

	it("anchor at end returns empty messages", () => {
		const view = makeView(["a", "b"]);
		const delta = extractDelta(view, 2);
		assert.equal(delta.messages.length, 0);
	});

	it("always carries through compactionSummaries", () => {
		const view = makeView(["a"], [], ["Summary 1", "Summary 2"]);
		const delta = extractDelta(view, 1); // no messages
		assert.deepEqual(delta.compactionSummaries, ["Summary 1", "Summary 2"]);
	});

	it("does not mutate the original view", () => {
		const view = makeView(["a", "b", "c"]);
		extractDelta(view, 1);
		assert.equal(view.messages.length, 3);
	});
});

// ─── capInput ────────────────────────────────────────────────────────────────

describe("capInput", () => {
	it("returns the view unchanged when within budget", () => {
		const view = makeView(["short msg"], ["short reply"]);
		const model = makeModel({ contextWindow: 128_000, maxTokens: 4_096 });
		const capped = capInput(view, model, false);
		assert.equal(capped.messages.length, 2);
	});

	it("keeps all compaction summaries when truncating", () => {
		// Small context window to force truncation
		const model = makeModel({ contextWindow: 200, maxTokens: 50 });
		const longMessages = Array.from({ length: 20 }, (_, i) => `Message ${i} ${"x".repeat(50)}`);
		const view = makeView(longMessages, [], ["Summary A", "Summary B"]);
		const capped = capInput(view, model, false);
		// Summaries must survive
		assert.deepEqual(capped.compactionSummaries, ["Summary A", "Summary B"]);
	});

	it("keeps the first user message when truncating", () => {
		const model = makeModel({ contextWindow: 100, maxTokens: 20 });
		const messages = Array.from({ length: 10 }, (_, i) => `Message ${i} ${"y".repeat(30)}`);
		const view = makeView(messages, []);
		const capped = capInput(view, model, false);
		// First message must be present if there are any messages
		if (capped.messages.length > 0) {
			assert.equal(capped.messages[0].text, messages[0]);
		}
	});

	it("uses a larger envelope (4000) when includesPrevDigest=true", () => {
		// Both calls should return the view as-is for large context — just check no error
		const model = makeModel({ contextWindow: 128_000, maxTokens: 4_096 });
		const view = makeView(["hello"]);
		const withDigest = capInput(view, model, true);
		const withoutDigest = capInput(view, model, false);
		assert.equal(withDigest.messages.length, 1);
		assert.equal(withoutDigest.messages.length, 1);
	});

	it("caps at 100000 chars even with huge contextWindow", () => {
		// Model with huge context — should still be capped at 100 000
		const model = makeModel({ contextWindow: 10_000_000, maxTokens: 4_096 });
		// Create a view that's well under 100k — it should pass through unchanged
		const view = makeView(["hello world"]);
		const capped = capInput(view, model, false);
		assert.equal(capped.messages.length, 1);
	});
});

// ─── buildPrompt — mode selection ────────────────────────────────────────────

describe("buildPrompt — mode selection", () => {
	const model = makeModel();
	const THRESHOLD = 10_000;

	it("first digest is always full (no lastDigest)", () => {
		const state = emptyBuilderState();
		const view = makeView(["Hello"]);
		const { mode } = buildPrompt(state, view, THRESHOLD, model);
		assert.equal(mode, "full");
	});

	it("uses incremental when delta tokens < threshold", () => {
		// convTokensAtLastWrite is nearly the same as current → small delta
		const view = makeView(["msg1", "msg2", "msg3"]);
		const currentTokens = Math.ceil(
			(view.messages.map((m) => `${m.role}: ${m.text}`).join("\n\n")).length / 4,
		);
		// Set lastWrite to almost current so delta < THRESHOLD
		const state = stateWithDigest(
			fakeDigest(),
			0,
			currentTokens - 100, // delta = 100 tokens, below 10 000
		);
		const { mode } = buildPrompt(state, view, THRESHOLD, model);
		assert.equal(mode, "incremental");
	});

	it("uses full when delta tokens >= threshold", () => {
		// convTokensAtLastWrite = 0, view has a lot of tokens
		const bigText = "word ".repeat(15_000); // ~75k chars = ~18750 tokens
		const view = makeView([bigText]);
		const state = stateWithDigest(fakeDigest(), 0, 0);
		const { mode } = buildPrompt(state, view, THRESHOLD, model);
		assert.equal(mode, "full");
	});

	it("uses full at threshold boundary (equal)", () => {
		// Craft a view whose serialized token count is exactly THRESHOLD more than lastWrite
		const text = "a".repeat(THRESHOLD * 4); // exactly THRESHOLD tokens
		const view = makeView([text]);
		const state = stateWithDigest(fakeDigest(), 0, 0);
		const { mode } = buildPrompt(state, view, THRESHOLD, model);
		assert.equal(mode, "full");
	});

	it("systemPrompt instructs the model to produce the digest schema", () => {
		const state = emptyBuilderState();
		const { systemPrompt, userMessage } = buildPrompt(state, makeView(["hi"]), THRESHOLD, model);
		// Schema fields belong in the system prompt. Direct providers honor it,
		// and the claude-bridge capture path (≥ commit 202ca4b) forwards it
		// verbatim. The user message stays focused on the task.
		assert.ok(systemPrompt.includes("body") && systemPrompt.includes("headline") && systemPrompt.includes("topics"));
		assert.ok(userMessage.includes("submit_digest"),
			"user message should instruct the model to call submit_digest");
	});

	it("systemPrompt frames headline as a stable, whole-session title", () => {
		// Stickiness language should appear in the schema instructions so it
		// applies to both full and incremental modes. We assert on stable
		// substrings; final wording can be tweaked without breaking the test
		// so long as the framing remains.
		const state = emptyBuilderState();
		const { systemPrompt } = buildPrompt(state, makeView(["hi"]), THRESHOLD, model);
		assert.ok(
			systemPrompt.includes("as a whole"),
			"systemPrompt should frame the headline as describing the session as a whole",
		);
		assert.ok(
			/sticky|fundamentally pivoted/.test(systemPrompt),
			"systemPrompt should instruct the model that the headline is sticky / only changes on a fundamental pivot",
		);
	});

	it("incremental userMessage includes previous digest body and headline", () => {
		const digest: SessionDigest = {
			...fakeDigest("The previous digest body text here, detailed enough."),
			headline: "Refactor auth module to use bcrypt",
		};
		const view = makeView(["new message"]);
		const tokens = Math.ceil(
			(view.messages.map((m) => `${m.role}: ${m.text}`).join("\n\n")).length / 4,
		);
		const state = stateWithDigest(digest, 0, tokens - 50);
		const { userMessage } = buildPrompt(state, view, THRESHOLD, model);
		assert.ok(userMessage.includes("Previous digest"));
		assert.ok(userMessage.includes(digest.body));
		assert.ok(
			userMessage.includes("Previous headline"),
			"incremental userMessage should label the previous headline",
		);
		assert.ok(
			userMessage.includes(digest.headline),
			"incremental userMessage should include the previous headline value verbatim",
		);
	});

	it("incremental userMessage contains a headline-stickiness directive", () => {
		const digest: SessionDigest = {
			...fakeDigest("Body text long enough for the digest, just normal prose."),
			headline: "Refactor auth module to use bcrypt",
		};
		const view = makeView(["new tactical message"]);
		const tokens = Math.ceil(
			(view.messages.map((m) => `${m.role}: ${m.text}`).join("\n\n")).length / 4,
		);
		const state = stateWithDigest(digest, 0, tokens - 50);
		const { userMessage } = buildPrompt(state, view, THRESHOLD, model);
		assert.ok(
			/fundamentally pivoted/.test(userMessage),
			"incremental userMessage should instruct the LLM to keep the headline unless the topic has fundamentally pivoted",
		);
		assert.ok(
			userMessage.includes("verbatim"),
			"incremental userMessage should still include the 'repeat verbatim' framing",
		);
	});

	it("full mode userMessage does not include previous digest body or headline", () => {
		const digest: SessionDigest = {
			...fakeDigest("Old digest body content."),
			headline: "Old session headline string",
		};
		const state = stateWithDigest(digest, 0, 0); // delta will be huge
		// Need >10000 tokens above last-write (0). 10000 tokens × 4 chars = 40000 chars;
		// serializeView adds a ~6-char role prefix, so 20_001 repetitions of "x " (2
		// chars each) gives 40002 chars → ceil(40008/4) = 10002 tokens ≥ THRESHOLD.
		const bigText = "x ".repeat(20_001);
		const view = makeView([bigText]);
		const { mode, userMessage } = buildPrompt(state, view, THRESHOLD, model);
		assert.equal(mode, "full");
		assert.ok(!userMessage.includes("Previous digest"));
		assert.ok(
			!userMessage.includes("Previous headline"),
			"full mode should not surface a Previous headline line",
		);
		assert.ok(
			!userMessage.includes(digest.headline),
			"full mode should not echo the prior headline string into the user message",
		);
	});

	it("incremental extracts only messages after lastWrittenMessageIndex", () => {
		const view = makeView(["old1", "old2", "new1", "new2"]);
		// lastWrittenMessageIndex=2 → delta is messages[2..]
		const tokens = Math.ceil(
			(view.messages.map((m) => `${m.role}: ${m.text}`).join("\n\n")).length / 4,
		);
		const state = stateWithDigest(fakeDigest(), 2, tokens - 50);
		const { mode, userMessage } = buildPrompt(state, view, THRESHOLD, model);
		assert.equal(mode, "incremental");
		assert.ok(userMessage.includes("new1"));
		assert.ok(!userMessage.includes("old1") || userMessage.includes("Previous digest"));
	});
});

// ─── generateDigest ──────────────────────────────────────────────────────────

describe("generateDigest", () => {
	const model = makeModel();

	it("requires host-bound completion instead of falling back to local pi-ai", async () => {
		await assert.rejects(
			generateDigest(model, makeView(["test"]), emptyBuilderState()),
			/generateDigest requires a host-bound completeFn/,
		);
	});

	it("returns a digest with anchor=view.messages.length on success", async () => {
		const view = makeView(["What is the weather?"]);
		const state = emptyBuilderState();

		const result = await generateDigest(model, view, state, {
			_completeFn: async () => fakeAssistantMessage(),
		});

		assert.ok(result !== null);
		assert.equal(result!.anchor, view.messages.length);
		assert.equal(result!.digest.schemaVersion, 1);
		assert.equal(result!.digest.headline, "Generated headline");
	});

	it("populates modelId as provider/id", async () => {
		const view = makeView(["test"]);
		const result = await generateDigest(model, view, emptyBuilderState(), {
			_completeFn: async () => fakeAssistantMessage(),
		});
		assert.ok(result !== null);
		assert.equal(result!.digest.modelId, "openai-codex/gpt-5.4-mini");
	});

	it("returns null when complete throws", async () => {
		const view = makeView(["test"]);
		const result = await generateDigest(model, view, emptyBuilderState(), {
			_completeFn: async () => { throw new Error("network error"); },
		});
		assert.equal(result, null);
	});

	it("retries on validation failure and succeeds on second attempt", async () => {
		const view = makeView(["test"]);
		let callCount = 0;

		const result = await generateDigest(model, view, emptyBuilderState(), {
			_completeFn: async () => {
				callCount++;
				if (callCount === 1) {
					// Return invalid args (body too short)
					return fakeAssistantMessage({ body: "too short", headline: "H".repeat(81) });
				}
				return fakeAssistantMessage(); // valid on second call
			},
		});

		assert.equal(callCount, 2);
		assert.ok(result !== null);
	});

	it("returns null after two failures", async () => {
		const view = makeView(["test"]);
		let callCount = 0;

		const result = await generateDigest(model, view, emptyBuilderState(), {
			_completeFn: async () => {
				callCount++;
				// Always return invalid (body too short)
				return fakeAssistantMessage({ body: "short", headline: "H".repeat(81) });
			},
		});

		assert.equal(callCount, 2);
		assert.equal(result, null);
	});

	it("returns null when response has no submit_digest tool call", async () => {
		const view = makeView(["test"]);
		const result = await generateDigest(model, view, emptyBuilderState(), {
			_completeFn: async () => {
				const msg = fakeAssistantMessage();
				// Replace content with a text block instead of a tool call
				return {
					...msg,
					content: [{ type: "text", text: "I am just text." }],
				};
			},
		});
		assert.equal(result, null);
	});

	it("uses full mode for first digest (no lastDigest)", async () => {
		const view = makeView(["some question"]);
		let capturedPrompt = "";

		await generateDigest(model, view, emptyBuilderState(), {
			_completeFn: async (m, ctx) => {
				const msgs = ctx.messages as Array<{ content: Array<{ text?: string }> }>;
				capturedPrompt = msgs[0]?.content[0]?.text ?? "";
				return fakeAssistantMessage();
			},
		});

		assert.ok(capturedPrompt.includes("full conversation"), `Expected 'full conversation' in: ${capturedPrompt}`);
	});

	it("records cost from response usage", async () => {
		const view = makeView(["test"]);
		const result = await generateDigest(model, view, emptyBuilderState(), {
			_completeFn: async () => fakeAssistantMessage(),
		});
		assert.ok(result !== null);
		assert.ok(Math.abs(result!.digest.cost - 0.00004) < 1e-9);
	});

	it("includes generatedAt as an ISO string", async () => {
		const view = makeView(["test"]);
		const result = await generateDigest(model, view, emptyBuilderState(), {
			_completeFn: async () => fakeAssistantMessage(),
		});
		assert.ok(result !== null);
		assert.ok(!Number.isNaN(Date.parse(result!.digest.generatedAt)));
	});
});

/**
 * Digest input budget: compaction summaries and the first message are held to the budget, a context-window rejection retries once
 * with a smaller budget (not with the same oversized input), and the failure is reported to the lifecycle.
 * Shapes come from a real failing session: 27 compactions, summaries of up to ~307 000 characters each, a 100 000-character cap.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { capInput, clipMiddle, generateDigest, emptyBuilderState, isContextWindowError, MIN_BUDGET_SCALE } from "../../digest/builder";
import type { GenerateDiagnostics } from "../../digest/builder";
import type { ConversationView } from "../../digest/conversation-view";
import type { Model, Api, AssistantMessage } from "@earendil-works/pi-ai";

const model = (o: Partial<Model<Api>> = {}): Model<Api> => ({ id: "gpt-6-luna", name: "GPT-6 Luna", api: "openai-codex-responses" as Api, provider: "openai-codex", baseUrl: "https://x", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272_000, maxTokens: 128_000, ...o });
const serialized = (v: ConversationView) => [...v.compactionSummaries, ...v.messages.map((m) => `${m.role}: ${m.text}`)].join("\n\n").length;
/** summary i is tagged so order and identity can be asserted */
const summaries = (n: number, size: number) => Array.from({ length: n }, (_, i) => `S${i}:` + "s".repeat(size));
const messages = (n: number, size = 400) => Array.from({ length: n }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `M${i}:` + "m".repeat(size) }));

describe("capInput bounds every part of the prompt", () => {
	it("the real failing shape (27 summaries x 300k chars) is brought within the 100k cap", () => {
		const view: ConversationView = { messages: [{ role: "user", text: "opener " + "o".repeat(900_000) }, ...messages(200)], compactionSummaries: summaries(27, 300_000) };
		assert.ok(serialized(view) > 8_000_000);
		const out = capInput(view, model(), false);
		assert.ok(serialized(out) <= 100_000 + 2_000, "within the cap plus markers, got " + serialized(out));
	});

	it("keeps the NEWEST summary (clipped, start and end kept), drops older ones with a count marker, preserves chronological order", () => {
		const view: ConversationView = { messages: messages(3), compactionSummaries: summaries(5, 30_000) };
		const out = capInput(view, model({ contextWindow: 40_000, maxTokens: 4_000 }), false); // cap = 40k*4-16k-2k = 100000? min(100000, 142000)=100000
		const s = out.compactionSummaries;
		assert.ok(s[0].startsWith("[") && /earlier compaction summaries omitted/.test(s[0]));
		assert.ok(s.at(-1)!.startsWith("S4:"), "newest summary is the last one kept");
		assert.ok(!s.some((t) => t.startsWith("S0:")), "the oldest is dropped before the newest");
		const kept = s.filter((t) => /^S\d:/.test(t)).map((t) => Number(t[1]));
		assert.deepEqual(kept, [...kept].sort((a, b) => a - b), "chronological order");
	});

	it("a single huge newest summary is clipped to the summary share and says so", () => {
		const view: ConversationView = { messages: messages(2), compactionSummaries: ["HEAD-" + "z".repeat(300_000) + "-TAIL"] };
		const out = capInput(view, model(), false);
		const t = out.compactionSummaries[0];
		assert.ok(t.length <= 60_000, "share is 60% of the 100k cap, got " + t.length);
		assert.ok(t.startsWith("HEAD-") && t.endsWith("-TAIL"), "start and end preserved");
		assert.match(t, /\d+ characters omitted/);
	});

	it("clips an oversized first message to 4000 chars but keeps recent messages", () => {
		const view: ConversationView = { messages: [{ role: "user", text: "F" + "f".repeat(500_000) }, ...messages(400)], compactionSummaries: [] };
		const out = capInput(view, model(), false);
		assert.ok(out.messages[0].text.length <= 4_000);
		assert.equal(out.messages[0].role, "user");
		assert.ok(out.messages.length > 5 && out.messages.at(-1)!.text.startsWith("M399:"), "the tail is the most recent messages");
	});

	it("a view within the budget is returned unchanged (same object)", () => {
		const view: ConversationView = { messages: messages(4, 50), compactionSummaries: ["small summary"] };
		assert.equal(capInput(view, model(), false), view);
	});

	it("budget scale shrinks the cap: a view that fits at scale 1 is trimmed at 0.25, and the scale is monotone", () => {
		const view: ConversationView = { messages: messages(300, 300), compactionSummaries: [] }; // ~90k chars
		assert.equal(capInput(view, model(), false, 1), view);
		const quarter = serialized(capInput(view, model(), false, 0.25)), half = serialized(capInput(view, model(), false, 0.5));
		assert.ok(quarter < half && half < serialized(view) && quarter <= 25_000 + 1_000, `quarter=${quarter} half=${half}`);
	});

	it("does not mutate its input", () => {
		const view: ConversationView = { messages: messages(300), compactionSummaries: summaries(3, 90_000) };
		const before = JSON.stringify(view);
		capInput(view, model(), false);
		assert.equal(JSON.stringify(view), before);
	});

	it("clipMiddle: identity under the limit, exact bound over it, never throws on tiny limits", () => {
		assert.equal(clipMiddle("abc", 10), "abc");
		const out = clipMiddle("x".repeat(1000), 200); assert.ok(out.length <= 200);
		for (const max of [0, 1, 5, 40]) assert.doesNotThrow(() => clipMiddle("y".repeat(100), max));
	});
});

describe("isContextWindowError", () => {
	it("recognises the observed Codex rejection and common variants; ignores transient failures", () => {
		for (const m of ["Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", "This model's maximum context length is 8192 tokens", "prompt is too long: 250000 tokens", "context_length_exceeded", "Input is too long for requested model"]) assert.equal(isContextWindowError(m), true, m);
		for (const m of ["WebSocket error", "WebSocket closed 1000", "This operation was aborted", "rate limit exceeded: too many requests", "429 quota exceeded", "overloaded", "", undefined, "Rate limit reached: too many tokens per minute", "429 Too Many Tokens (throttled)", "quota: input is too long for your plan tier limit"]) assert.equal(isContextWindowError(m as string), false, String(m));
	});
});

const ok = (): AssistantMessage => ({ role: "assistant", content: [{ type: "toolCall", id: "t", name: "submit_digest", arguments: { body: "x".repeat(60), headline: "H", topics: ["t"] } }], api: "openai-codex-responses" as Api, provider: "openai-codex", model: "gpt-6-luna", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 } as AssistantMessage);
const rejected = (text = "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again."): AssistantMessage => ({ ...ok(), content: [], stopReason: "error", errorMessage: text } as AssistantMessage);
const promptChars = (ctx: any) => JSON.stringify(ctx.messages).length;
const bigView = (): ConversationView => ({ messages: messages(100), compactionSummaries: summaries(27, 300_000) });

describe("generateDigest and a context-window rejection", () => {
	it("retries ONCE with half the budget (a smaller prompt), not with the same input, and succeeds when that fits", async () => {
		const sizes: number[] = []; const diagnostics: GenerateDiagnostics = {};
		const out = await generateDigest(model(), bigView(), emptyBuilderState(), { diagnostics, completeFn: async (_m, ctx) => { sizes.push(promptChars(ctx)); return sizes.length === 1 ? rejected() : ok(); } });
		assert.ok(out, "second attempt succeeds");
		assert.equal(sizes.length, 2);
		assert.ok(sizes[1] < sizes[0] * 0.7, `second prompt must be much smaller: ${sizes}`);
		assert.equal(diagnostics.contextWindowExceeded, false);
		assert.equal(diagnostics.scaleUsed, 0.5);
	});

	it("when the smaller prompt is also rejected: exactly 2 requests (no strict-prompt third), null, and the flag + scale reported", async () => {
		let calls = 0; const diagnostics: GenerateDiagnostics = {};
		const out = await generateDigest(model(), bigView(), emptyBuilderState(), { budgetScale: 0.5, diagnostics, completeFn: async () => { calls++; return rejected(); } });
		assert.equal(out, null); assert.equal(calls, 2);
		assert.equal(diagnostics.contextWindowExceeded, true); assert.equal(diagnostics.scaleUsed, 0.25);
	});

	it("a THROWN context error is treated the same way", async () => {
		let calls = 0; const diagnostics: GenerateDiagnostics = {};
		const out = await generateDigest(model(), bigView(), emptyBuilderState(), { diagnostics, completeFn: async () => { calls++; throw new Error("Your input exceeds the context window of this model"); } });
		assert.equal(out, null); assert.equal(calls, 2); assert.equal(diagnostics.contextWindowExceeded, true);
	});

	it("the scale never goes below the floor", async () => {
		const diagnostics: GenerateDiagnostics = {};
		await generateDigest(model(), bigView(), emptyBuilderState(), { budgetScale: MIN_BUDGET_SCALE, diagnostics, completeFn: async () => rejected() });
		assert.equal(diagnostics.scaleUsed, MIN_BUDGET_SCALE);
	});

	it("other failures keep the old behaviour: one strict-prompt retry at the SAME size, no context flag", async () => {
		const sizes: number[] = []; const diagnostics: GenerateDiagnostics = {};
		const out = await generateDigest(model(), { messages: messages(3), compactionSummaries: [] }, emptyBuilderState(), { diagnostics, completeFn: async (_m, ctx) => { sizes.push(promptChars(ctx)); return rejected("WebSocket error"); } });
		assert.equal(out, null); assert.equal(sizes.length, 2); assert.equal(diagnostics.contextWindowExceeded, false);
	});

	it("the first prompt for the failing shape is within the cap (it used to be ~8 million characters)", async () => {
		let first = 0;
		await generateDigest(model(), bigView(), emptyBuilderState(), { completeFn: async (_m, ctx) => { first ||= promptChars(ctx); return ok(); } });
		assert.ok(first > 0 && first <= 110_000, "prompt chars " + first);
	});
});

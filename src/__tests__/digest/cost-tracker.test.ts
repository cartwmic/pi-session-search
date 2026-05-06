import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emptyRollup, record, format } from "../../digest/cost-tracker";
import type { AssistantMessage } from "@mariozechner/pi-ai";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fakeResponse(overrides: Partial<AssistantMessage["usage"]> = {}): AssistantMessage {
	const usage = {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0003 },
		...overrides,
	};
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-5.4-mini",
		usage: usage as AssistantMessage["usage"],
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

// ─── emptyRollup ─────────────────────────────────────────────────────────────

describe("emptyRollup", () => {
	it("returns zero values", () => {
		const r = emptyRollup();
		assert.equal(r.calls, 0);
		assert.equal(r.tokensIn, 0);
		assert.equal(r.tokensOut, 0);
		assert.equal(r.cost.total, 0);
	});
});

// ─── record ──────────────────────────────────────────────────────────────────

describe("record", () => {
	it("accumulates a single response", () => {
		const r = record(emptyRollup(), fakeResponse());
		assert.equal(r.calls, 1);
		assert.equal(r.tokensIn, 100);
		assert.equal(r.tokensOut, 50);
		assert.ok(Math.abs(r.cost.total - 0.0003) < 1e-9);
	});

	it("accumulates multiple responses", () => {
		let r = emptyRollup();
		r = record(r, fakeResponse());
		r = record(r, fakeResponse());
		r = record(r, fakeResponse());
		assert.equal(r.calls, 3);
		assert.equal(r.tokensIn, 300);
		assert.equal(r.tokensOut, 150);
		assert.ok(Math.abs(r.cost.total - 0.0009) < 1e-9);
	});

	it("is pure — does not mutate the input rollup", () => {
		const original = emptyRollup();
		record(original, fakeResponse());
		assert.equal(original.calls, 0);
	});

	it("accumulates cache costs", () => {
		const resp = fakeResponse({
			input: 0,
			output: 0,
			cacheRead: 10,
			cacheWrite: 5,
			cost: { input: 0, output: 0, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0003 },
		} as any);
		const r = record(emptyRollup(), resp);
		assert.ok(Math.abs(r.cost.cacheRead - 0.0001) < 1e-9);
		assert.ok(Math.abs(r.cost.cacheWrite - 0.0002) < 1e-9);
	});
});

// ─── format ──────────────────────────────────────────────────────────────────

describe("format", () => {
	it("includes 'this process' wording", () => {
		const line = format(emptyRollup(), "gpt-5.4-mini");
		assert.ok(line.includes("this process"));
	});

	it("includes the model name", () => {
		const line = format(emptyRollup(), "claude-haiku-4-5");
		assert.ok(line.includes("claude-haiku-4-5"));
	});

	it("includes call count", () => {
		let r = emptyRollup();
		r = record(r, fakeResponse());
		r = record(r, fakeResponse());
		const line = format(r, "gpt-5.4-mini");
		assert.ok(line.includes("calls: 2"));
	});

	it("includes token counts", () => {
		const r = record(emptyRollup(), fakeResponse());
		const line = format(r, "gpt-5.4-mini");
		assert.ok(line.includes("tokens in: 100"));
		assert.ok(line.includes("out: 50"));
	});

	it("formats cost to 4 decimal places", () => {
		const r = record(emptyRollup(), fakeResponse());
		const line = format(r, "gpt-5.4-mini");
		assert.ok(line.includes("$0.0003"), `Expected $0.0003 in: ${line}`);
	});

	it("formats zero cost as $0.0000", () => {
		const line = format(emptyRollup(), "model");
		assert.ok(line.includes("$0.0000"), `Expected $0.0000 in: ${line}`);
	});
});

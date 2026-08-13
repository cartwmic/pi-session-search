import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveModel } from "../../digest/model-resolver";
import type { Model, Api } from "@mariozechner/pi-ai";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeModel(id: string, provider: string, costInput = 0.1): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions" as Api,
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: costInput, output: costInput * 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

const registryWithAll: Model<Api>[] = [
	makeModel("openai/gpt-5.4-nano", "openrouter"),
	makeModel("gpt-5.4-mini", "openai-codex"),
	makeModel("claude-haiku-4-5", "claude-bridge"),
	makeModel("google/gemini-3-flash-preview", "openrouter"),
	makeModel("claude-3-5-sonnet", "anthropic"),
];

// ─── resolveModel — explicit config ──────────────────────────────────────────

describe("resolveModel — explicit override", () => {
	it("returns the model matching provider+id", () => {
		const result = resolveModel(
			{ provider: "anthropic", model: "claude-3-5-sonnet" },
			registryWithAll,
		);
		assert.ok(result !== undefined);
		assert.equal(result!.id, "claude-3-5-sonnet");
		assert.equal(result!.provider, "anthropic");
	});

	it("returns undefined when the explicit model is not in the registry", () => {
		const result = resolveModel(
			{ provider: "anthropic", model: "nonexistent-model" },
			registryWithAll,
		);
		assert.equal(result, undefined);
	});

	it("matches by composite provider/id string", () => {
		// Model stored as provider="openrouter", id="openai/gpt-5.4-nano"
		const result = resolveModel(
			{ provider: "openrouter", model: "openai/gpt-5.4-nano" },
			registryWithAll,
		);
		assert.ok(result !== undefined);
		assert.equal(result!.id, "openai/gpt-5.4-nano");
	});
});

// ─── resolveModel — missing or partial config ────────────────────────────────

describe("resolveModel — config required", () => {
	it("returns undefined without provider and model", () => {
		assert.equal(resolveModel({}, registryWithAll), undefined);
	});

	it("returns undefined when only provider is configured", () => {
		assert.equal(resolveModel({ provider: "anthropic" }, registryWithAll), undefined);
	});

	it("returns undefined when only model is configured", () => {
		assert.equal(resolveModel({ model: "gpt-5.4-mini" }, registryWithAll), undefined);
	});

	it("returns undefined for an empty registry", () => {
		assert.equal(
			resolveModel({ provider: "anthropic", model: "claude-3-5-sonnet" }, []),
			undefined,
		);
	});
});

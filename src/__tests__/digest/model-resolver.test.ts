import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveModel, AUTO_DETECT_MODELS } from "../../digest/model-resolver";
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

// ─── AUTO_DETECT_MODELS ───────────────────────────────────────────────────────

describe("AUTO_DETECT_MODELS", () => {
	it("contains the four empirically-verified IDs", () => {
		assert.deepEqual(AUTO_DETECT_MODELS, [
			"openai/gpt-5.4-nano",
			"gpt-5.4-mini",
			"claude-haiku-4-5",
			"google/gemini-3-flash-preview",
		]);
	});
});

// ─── resolveModel — explicit override ────────────────────────────────────────

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

	it("skips the priority list when explicit config is set", () => {
		// gpt-5.4-nano is first in the priority list but we ask for something else
		const result = resolveModel(
			{ provider: "anthropic", model: "claude-3-5-sonnet" },
			registryWithAll,
		);
		assert.equal(result!.id, "claude-3-5-sonnet");
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

// ─── resolveModel — priority-list scan ───────────────────────────────────────

describe("resolveModel — priority-list scan", () => {
	it("returns the first available model in priority order", () => {
		// All four are present; should return index-0
		const result = resolveModel({}, registryWithAll);
		assert.ok(result !== undefined);
		assert.equal(result!.id, "openai/gpt-5.4-nano");
	});

	it("skips unavailable priority entries and picks the next one", () => {
		// Remove gpt-5.4-nano → should pick gpt-5.4-mini
		const registry = registryWithAll.filter((m) => m.id !== "openai/gpt-5.4-nano");
		const result = resolveModel({}, registry);
		assert.ok(result !== undefined);
		assert.equal(result!.id, "gpt-5.4-mini");
	});

	it("returns undefined when none of the priority models are available", () => {
		const registry = [makeModel("some-other-model", "provider-x")];
		const result = resolveModel({}, registry);
		assert.equal(result, undefined);
	});

	it("returns undefined for an empty registry", () => {
		const result = resolveModel({}, []);
		assert.equal(result, undefined);
	});

	it("falls back to last in the list when only that one is present", () => {
		const registry = [makeModel("google/gemini-3-flash-preview", "openrouter")];
		const result = resolveModel({}, registry);
		assert.ok(result !== undefined);
		assert.equal(result!.id, "google/gemini-3-flash-preview");
	});
});

// ─── resolveModel — partial config (only provider or only model) ──────────────

describe("resolveModel — partial config", () => {
	it("falls back to priority scan when only provider is set", () => {
		// Only provider set, no model → auto-detect
		const result = resolveModel({ provider: "anthropic" }, registryWithAll);
		assert.ok(result !== undefined);
		assert.equal(result!.id, "openai/gpt-5.4-nano"); // first in priority list
	});

	it("falls back to priority scan when only model is set", () => {
		// Only model set, no provider → auto-detect
		const result = resolveModel({ model: "gpt-5.4-mini" }, registryWithAll);
		assert.ok(result !== undefined);
		assert.equal(result!.id, "openai/gpt-5.4-nano"); // first in priority list, not the model
	});
});

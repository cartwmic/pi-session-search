import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveHostCompleteFn } from "../../digest/completion";
import type { HostModelRegistry } from "../../digest/completion";

function makeModel(provider: string, api: string) {
	return {
		id: "test-model",
		provider,
		api,
		baseUrl: "https://catalog.example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	} as any;
}

function makeResponse() {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as any;
}

describe("resolveHostCompleteFn", () => {
	it("uses the registry to normalize digest prompts and tools before dispatch", async () => {
		const model = makeModel("openai-codex", "openai-codex-responses");
		const response = makeResponse();
		const context = {
			systemPrompt: "You are a session digest writer",
			messages: [{ role: "user", content: [{ type: "text", text: "Summarize this session" }] }],
			tools: [{ name: "submit_digest", description: "Submit a digest", parameters: {} }],
		};
		let registryCalls = 0;
		const registry: HostModelRegistry = {
			getProvider: () => ({ stream: () => { throw new Error("raw provider dispatch bypassed normalization"); } }),
			stream(requestModel, requestContext) {
				registryCalls++;
				assert.equal(requestModel, model);
				assert.equal(requestContext, context);
				return { result: async () => response };
			},
		};

		const complete = await resolveHostCompleteFn(registry, model);
		assert.equal(await complete(model, context), response);
		assert.equal(registryCalls, 1);
	});

	it("dispatches a custom API through Pi's effective extension provider", async () => {
		const model = makeModel("claude-bridge", "claude-bridge");
		const response = makeResponse();
		const signal = new AbortController().signal;
		let streamCalls = 0;
		const registry: HostModelRegistry = {
			getProvider(providerId) {
				assert.equal(providerId, "claude-bridge");
				return {};
			},
			stream(requestModel, context, options) {
				streamCalls++;
				assert.equal(requestModel, model);
				assert.deepEqual(context, { messages: [] });
				assert.equal(options?.signal, signal);
				return { result: async () => response };
			},
		};

		const complete = await resolveHostCompleteFn(registry, model);
		assert.equal(await complete(model, { messages: [] }, { signal }), response);
		assert.equal(streamCalls, 1);
	});

	it("fails before generation when host provider is missing", async () => {
		const model = makeModel("missing", "missing-api");
		const registry: HostModelRegistry = {
			getProvider: () => undefined,
			stream: () => { throw new Error("should not dispatch"); },
		};

		await assert.rejects(
			resolveHostCompleteFn(registry, model),
			/No host provider available for: missing/,
		);
	});

	it("returns host error responses for the builder to report", async () => {
		const model = makeModel("cursor", "openai-responses");
		const response = { ...makeResponse(), stopReason: "error", errorMessage: "OAuth token expired" };
		const registry: HostModelRegistry = {
			getProvider: () => ({}),
			stream: () => ({ result: async () => response }),
		};

		const complete = await resolveHostCompleteFn(registry, model);
		assert.equal(await complete(model, { messages: [] }), response);
	});
});

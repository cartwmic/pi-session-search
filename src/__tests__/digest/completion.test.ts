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
	it("dispatches a custom API through Pi's effective extension provider", async () => {
		const model = makeModel("claude-bridge", "claude-bridge");
		const response = makeResponse();
		let capturedModel: any;
		let capturedOptions: any;
		let streamCalls = 0;

		const registry: HostModelRegistry = {
			getProvider(providerId) {
				assert.equal(providerId, "claude-bridge");
				return {
					stream(requestModel, _context, options) {
						streamCalls++;
						capturedModel = requestModel;
						capturedOptions = options;
						return { result: async () => response };
					},
				};
			},
			async getApiKeyAndHeaders() {
				return {
					ok: true,
					apiKey: "not-used",
					headers: { "X-Provider": "bridge" },
					env: { BRIDGE_ENV: "host" },
				};
			},
			async getProviderAuth() {
				return {
					auth: { baseUrl: "claude-bridge" },
					env: { AUTH_ENV: "resolved" },
				};
			},
		};

		const complete = await resolveHostCompleteFn(registry, model);
		const actual = await complete(
			model,
			{ messages: [] },
			{
				headers: { "X-Request": "digest" },
				env: { BRIDGE_ENV: "request" },
			},
		);

		assert.equal(actual, response);
		assert.equal(streamCalls, 1);
		assert.equal(capturedModel.baseUrl, "claude-bridge");
		assert.equal(capturedOptions.apiKey, "not-used");
		assert.deepEqual(capturedOptions.headers, {
			"X-Provider": "bridge",
			"X-Request": "digest",
		});
		assert.deepEqual(capturedOptions.env, {
			AUTH_ENV: "resolved",
			BRIDGE_ENV: "request",
		});
	});

	it("dispatches a built-in provider through the same host path", async () => {
		const model = makeModel("anthropic", "anthropic-messages");
		let called = false;
		const registry: HostModelRegistry = {
			getProvider() {
				return {
					stream() {
						called = true;
						return { result: async () => makeResponse() };
					},
				};
			},
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "sk-test" };
			},
		};

		const complete = await resolveHostCompleteFn(registry, model);
		await complete(model, { messages: [] });
		assert.equal(called, true);
	});

	it("fails before generation when host provider is missing", async () => {
		const model = makeModel("missing", "missing-api");
		const registry: HostModelRegistry = {
			getProvider: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true }),
		};

		await assert.rejects(
			resolveHostCompleteFn(registry, model),
			/No host provider available for: missing/,
		);
	});

	it("surfaces host auth resolution errors", async () => {
		const model = makeModel("cursor", "openai-responses");
		const registry: HostModelRegistry = {
			getProvider: () => ({
				stream: () => ({ result: async () => makeResponse() }),
			}),
			getApiKeyAndHeaders: async () => ({
				ok: false,
				error: "OAuth token expired",
			}),
		};

		await assert.rejects(
			resolveHostCompleteFn(registry, model),
			/OAuth token expired/,
		);
	});
});

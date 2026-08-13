import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { createMockCtx, createMockPi } from "../_helpers/mock-pi";

describe("digest config required", () => {
	const sessionSearchHome = join(
		tmpdir(),
		`pi-session-search-config-required-${process.pid}`,
	);

	before(() => {
		process.env.PI_SESSION_SEARCH_HOME = sessionSearchHome;
		rmSync(sessionSearchHome, { recursive: true, force: true });
		mkdirSync(sessionSearchHome, { recursive: true });
	});

	after(() => {
		rmSync(sessionSearchHome, { recursive: true, force: true });
	});

	it("shows an unindexed footer warning and never dispatches a digest", async () => {
		const statuses: Array<{ key: string; value: string }> = [];
		const notifications: Array<{ message: string; level?: string }> = [];
		let providerDispatches = 0;
		const pi = createMockPi();
		const ctx = createMockCtx({
			cwd: "/tmp/no-digest-config",
			modelRegistry: {
				getAvailable: () => [
					{
						provider: "openrouter",
						id: "openai/gpt-5.4-nano",
						cost: { input: 0, output: 0 },
					},
				],
				getProvider: () => {
					providerDispatches++;
					return undefined;
				},
			},
			ui: {
				notify(message: string, level?: string) {
					notifications.push({ message, level });
				},
				setStatus(key: string, value: string) {
					statuses.push({ key, value });
				},
				input: async () => "",
			},
		});

		const mod = await import("../../index");
		mod.default(pi as any);

		try {
			await pi.fireSessionStart(ctx);

			const footer = statuses.findLast(({ key }) => key === "session-digest");
			assert.ok(footer, "missing digest footer status");
			assert.match(footer.value, /disabled/i);
			assert.match(footer.value, /\/session:summarizer/);

			for (const handler of pi._eventHandlers.filter(
				({ event }) => event === "before_agent_start",
			)) {
				const result = await handler.handler({ systemPrompt: "base" }, ctx);
				assert.doesNotMatch(
					result?.systemPrompt ?? "",
					/Digest disabled/,
					"footer warning must not enter model context",
				);
			}

			const searchResult = await pi.invokeTool("session_search", { query: "anything" });
			assert.doesNotMatch(
				searchResult.content.map(({ text }: { text: string }) => text).join("\n"),
				/Digest disabled/,
				"footer warning must not enter search results",
			);

			for (const handler of pi._eventHandlers.filter(({ event }) => event === "agent_end")) {
				await handler.handler("event", ctx);
			}
			assert.equal(providerDispatches, 0, "digest must not dispatch without explicit config");

			for (const command of [
				"session:digest",
				"session:update",
				"session:rewrite",
				"session:backfill",
				"session:cost",
			]) {
				notifications.length = 0;
				await pi.invokeCommand(command, "", ctx);
				const notification = notifications.at(-1);
				assert.ok(notification, `${command} did not notify`);
				assert.match(notification.message, /disabled/i);
				assert.match(notification.message, /\/session:summarizer/);
				assert.match(notification.message, /FTS session search remains available/);
			}
		} finally {
			await pi.fireSessionShutdown(ctx);
		}
	});

	it("never dispatches when explicit model exists but digest-hybrid prerequisites fail", async () => {
		writeFileSync(
			join(sessionSearchHome, "digest.json"),
			JSON.stringify({ provider: "test-provider", model: "test-model", debounceSeconds: 0 }),
		);

		let providerDispatches = 0;
		const pi = createMockPi();
		const ctx = createMockCtx({
			cwd: "/tmp/digest-without-embedder",
			modelRegistry: {
				getAvailable: () => [
					{
						provider: "test-provider",
						id: "test-model",
						cost: { input: 0, output: 0 },
					},
				],
				getProvider: () => {
					providerDispatches++;
					return undefined;
				},
			},
			ui: {
				notify() {},
				setStatus() {},
				input: async () => "",
			},
		});

		const mod = await import("../../index");
		mod.default(pi as any);

		try {
			await pi.fireSessionStart(ctx);
			for (const handler of pi._eventHandlers.filter(({ event }) => event === "agent_end")) {
				await handler.handler("event", ctx);
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(
				providerDispatches,
				0,
				"digest must not dispatch outside digest-hybrid mode",
			);
		} finally {
			await pi.fireSessionShutdown(ctx);
		}
	});
});

/**
 * Initial session title: the first submitted prompt names the session before
 * the first digest lands.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { installDigestLifecycle, type LifecycleDeps } from "../../digest/lifecycle";
import { cleanTitle, generateTitle } from "../../digest/title";
import type { SessionDigest } from "../../digest/schema";
import type { Model, Api, AssistantMessage } from "@earendil-works/pi-ai";

const flush = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

const model = { id: "configured-model", provider: "configured-provider" } as unknown as Model<Api>;

function makeDigest(headline: string): SessionDigest {
	return {
		schemaVersion: 1,
		body: "body",
		headline,
		topics: ["t"],
		generatedAt: new Date().toISOString(),
		modelUsed: "configured-provider/configured-model",
		inputTokenCount: 10,
		cost: 0,
	} as SessionDigest;
}

function makePi(initialName?: string) {
	const handlers = new Map<string, Array<(e: any, c: any) => unknown>>();
	const pi = {
		name: initialName as string | undefined,
		names: [] as string[],
		on(ev: string, h: (e: any, c: any) => unknown) {
			handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
		},
		setSessionName(n: string) {
			pi.name = n;
			pi.names.push(n);
		},
		getSessionName: () => pi.name,
		async emit(ev: string, payload: unknown, ctx: unknown) {
			for (const h of handlers.get(ev) ?? []) await h(payload, ctx);
		},
	};
	return pi;
}

const ctx = {
	sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
	modelRegistry: { getAvailable: () => [model], getProvider: () => ({}), stream: () => { throw new Error("unused"); } },
	cwd: "/tmp",
	ui: { notify: () => {} },
};

function makeDeps(overrides: {
	saved?: SessionDigest | null;
	title?: (m: Model<Api>, p: string) => Promise<string | null>;
} = {}): LifecycleDeps & { titleCalls: Array<{ model: Model<Api>; prompt: string }> } {
	const titleCalls: Array<{ model: Model<Api>; prompt: string }> = [];
	const saved = new Map<string, SessionDigest>();
	if (overrides.saved) saved.set("s1", overrides.saved);
	return {
		titleCalls,
		storage: {
			loadDigest: (id) => saved.get(id) ?? null,
			saveDigest: (id, d) => { saved.set(id, d); },
			loadBuilderState: () => null,
			saveBuilderState: () => {},
		},
		builder: {
			generateDigest: async () => ({ digest: makeDigest("Digest headline"), anchor: 1 }),
			generateTitle: async (m, p) => {
				titleCalls.push({ model: m, prompt: p });
				return overrides.title ? overrides.title(m, p) : "Fix login redirect loop";
			},
		},
		costTracker: { record: () => {} },
		configLoader: () => ({ debounceSeconds: 0, resummarizeTokenThreshold: 10_000, maxTokens: 1500, showWidget: false, verbose: false }) as any,
		modelResolver: () => model,
		indexAddDigested: () => {},
	};
}

describe("initial session title", () => {
	it("names the session from the first prompt with the configured digest model", async () => {
		const pi = makePi();
		const deps = makeDeps();
		const h = installDigestLifecycle(pi as any, deps);
		await pi.emit("session_start", {}, ctx);
		await pi.emit("before_agent_start", { prompt: "the login page loops forever" }, ctx);
		await flush(5);
		assert.deepEqual(pi.names, ["Fix login redirect loop"]);
		assert.equal(deps.titleCalls.length, 1);
		assert.equal(deps.titleCalls[0].model, model);
		assert.equal(deps.titleCalls[0].prompt, "the login page loops forever");

		// Later prompts do not retitle; the digest headline replaces the title.
		await pi.emit("before_agent_start", { prompt: "second" }, ctx);
		await pi.emit("agent_end", {}, ctx);
		await flush(5);
		assert.equal(deps.titleCalls.length, 1);
		assert.deepEqual(pi.names, ["Fix login redirect loop", "Digest headline"]);
		h.dispose();
	});

	it("skips sessions that already have a digest or a name", async () => {
		for (const [name, saved] of [["Manual", null], [undefined, makeDigest("Old")]] as const) {
			const pi = makePi(name);
			const deps = makeDeps({ saved });
			const h = installDigestLifecycle(pi as any, deps);
			await pi.emit("session_start", {}, ctx);
			await pi.emit("before_agent_start", { prompt: "hi" }, ctx);
			await flush(5);
			assert.equal(deps.titleCalls.length, 0);
			assert.deepEqual(pi.names, []);
			h.dispose();
		}
	});

	it("does not overwrite a digest headline that lands first", async () => {
		let release!: (v: string) => void;
		const pi = makePi();
		const deps = makeDeps({ title: () => new Promise((r) => { release = r; }) });
		const h = installDigestLifecycle(pi as any, deps);
		await pi.emit("session_start", {}, ctx);
		await pi.emit("before_agent_start", { prompt: "slow" }, ctx);
		await pi.emit("agent_end", {}, ctx);
		await flush(5);
		release("Late title");
		await flush(5);
		assert.deepEqual(pi.names, ["Digest headline"]);
		h.dispose();
	});
});

describe("generateTitle", () => {
	it("sends the prompt to the given model without tools and cleans the reply", async () => {
		let seen: any;
		const completeFn = async (m: Model<Api>, c: any) => {
			seen = { m, c };
			return { content: [{ type: "text", text: '"Title: Add dark mode toggle."\nextra' }] } as unknown as AssistantMessage;
		};
		const t = await generateTitle(model, "add a dark mode toggle", completeFn);
		assert.equal(t, "Add dark mode toggle");
		assert.equal(seen.m, model);
		assert.equal(seen.c.tools, undefined);
		assert.match(seen.c.messages[0].content[0].text, /add a dark mode toggle/);
	});

	it("returns null on error responses and empty prompts", async () => {
		const err = async () => ({ content: [], stopReason: "error", errorMessage: "x" }) as unknown as AssistantMessage;
		assert.equal(await generateTitle(model, "x", err), null);
		assert.equal(await generateTitle(model, "   ", err), null);
	});

	it("caps titles at 80 characters", () => {
		const t = cleanTitle("a".repeat(200))!;
		assert.equal(t.length, 80);
	});
});

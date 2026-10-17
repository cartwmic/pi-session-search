/**
 * A session whose digest input the provider rejects as too large must not be retried at every agent_end / compaction.
 * Uses an injected clock; debounce is 0 so each agent_end fires immediately unless the backoff suppresses it.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installDigestLifecycle, contextBackoffMs, CONTEXT_BACKOFF_BASE_MS, CONTEXT_BACKOFF_MAX_MS, type LifecycleDeps } from "../../digest/lifecycle";
import type { GenerateDiagnostics } from "../../digest/builder";
import type { SessionDigest } from "../../digest/schema";
import type { Model, Api } from "@earendil-works/pi-ai";

const flush = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const MODEL = { id: "m", name: "m", api: "openai-completions" as Api, provider: "p", baseUrl: "https://x", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4_096 } as Model<Api>;
const digest = (): SessionDigest => ({ schemaVersion: 1, body: "A ".repeat(100).trim(), headline: "H", topics: ["t"], generatedAt: "2026-01-01T00:00:00Z", modelId: "p/m", inputTokenCount: 10, cost: 0 });
function fakePi() {
	const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
	return { on: (n: string, h: (e: unknown, c: unknown) => unknown) => { handlers.set(n, [...(handlers.get(n) ?? []), h]); }, setSessionName() {}, emit: async (n: string, ctx: unknown = {}) => { for (const h of handlers.get(n) ?? []) await h({}, ctx); } };
}
const ctx = () => ({ sessionManager: { getSessionId: () => "sid", getBranch: () => [] }, modelRegistry: { getAvailable: () => [MODEL], getProvider: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true }), getProviderAuth: async () => ({ auth: {} }) }, cwd: "/tmp", ui: { notify() {} } });
const HOME = join(tmpdir(), `ctx-backoff-test-${process.pid}`);
before(() => { mkdirSync(HOME, { recursive: true }); process.env.HOME = HOME; });
after(() => rmSync(HOME, { recursive: true, force: true }));

type Outcome = "context" | "other" | "ok";
function setup(script: Outcome[]) {
	const pi = fakePi(); let clock = 1_000_000; const seen: Array<{ scale: number | undefined }> = []; let i = 0;
	const deps: LifecycleDeps = {
		storage: { loadDigest: () => null, saveDigest() {}, loadBuilderState: () => null, saveBuilderState() {} },
		builder: { generateDigest: async (_m, _v, _s, opts) => {
			seen.push({ scale: opts?.budgetScale }); const o = script[Math.min(i++, script.length - 1)];
			const d = opts?.diagnostics as GenerateDiagnostics;
			if (o === "ok") { d.scaleUsed = opts?.budgetScale ?? 1; return { digest: digest(), anchor: 1 }; }
			d.scaleUsed = (opts?.budgetScale ?? 1) / 2; d.contextWindowExceeded = o === "context"; return null;
		} },
		costTracker: { record() {} }, configLoader: () => ({ debounceSeconds: 0, resummarizeTokenThreshold: 10_000, maxTokens: 1500, showWidget: false, verbose: false }),
		modelResolver: () => MODEL, indexAddDigested() {}, now: () => clock,
	};
	const handle = installDigestLifecycle(pi as any, deps);
	return { pi, handle, seen, advance: (ms: number) => { clock += ms; } };
}
const turn = async (t: ReturnType<typeof setup>, event = "agent_end") => { await t.pi.emit(event, ctx()); await flush(15); };

describe("context-window backoff in the digest lifecycle", () => {
	it("contextBackoffMs doubles per consecutive failure from 10 minutes and is capped at 6 hours", () => {
		assert.equal(contextBackoffMs(1), CONTEXT_BACKOFF_BASE_MS); assert.equal(contextBackoffMs(2), 2 * CONTEXT_BACKOFF_BASE_MS); assert.equal(contextBackoffMs(3), 4 * CONTEXT_BACKOFF_BASE_MS);
		assert.equal(contextBackoffMs(50), CONTEXT_BACKOFF_MAX_MS); assert.equal(contextBackoffMs(0), CONTEXT_BACKOFF_BASE_MS);
	});

	it("after a context failure, agent_end and session_compact send NO request until the backoff expires", async () => {
		const t = setup(["context", "ok"]); await t.pi.emit("session_start", ctx()); await flush();
		await turn(t); assert.equal(t.seen.length, 1);
		for (let k = 0; k < 5; k++) { await turn(t); await turn(t, "session_compact"); t.advance(60_000); }
		assert.equal(t.seen.length, 1, "5 minutes of turns and compactions, still 1 request");
		t.advance(CONTEXT_BACKOFF_BASE_MS); await turn(t);
		assert.equal(t.seen.length, 2, "after the 10 minute wait it tries again");
		t.handle.dispose();
	});

	it("the retry after backoff starts from a SMALLER budget (the builder already tried 1 and 0.5 and both were rejected, so the next start is 0.25), and success resets the backoff", async () => {
		const t = setup(["context", "ok", "ok"]); await t.pi.emit("session_start", ctx()); await flush();
		await turn(t); t.advance(CONTEXT_BACKOFF_BASE_MS + 1); await turn(t);
		assert.equal(t.seen[0].scale, 1); assert.equal(t.seen[1].scale, 0.25);
		await turn(t); assert.equal(t.seen.length, 3, "no backoff after a success");
		t.handle.dispose();
	});

	it("consecutive failures back off 10 then 20 minutes and keep halving the scale", async () => {
		const t = setup(["context"]); await t.pi.emit("session_start", ctx()); await flush();
		await turn(t); t.advance(CONTEXT_BACKOFF_BASE_MS + 1); await turn(t);
		assert.equal(t.seen.length, 2);
		t.advance(CONTEXT_BACKOFF_BASE_MS + 1); await turn(t); assert.equal(t.seen.length, 2, "second wait is 20 minutes, 10 is not enough");
		t.advance(CONTEXT_BACKOFF_BASE_MS); await turn(t); assert.equal(t.seen.length, 3);
		assert.deepEqual(t.seen.map((s) => s.scale), [1, 0.25, 0.0625]);
		t.handle.dispose();
	});

	it("a success resets the failure count: the next failure waits 10 minutes again, not 20", async () => {
		const t = setup(["context", "ok", "context", "ok"]); await t.pi.emit("session_start", ctx()); await flush();
		await turn(t);                                         // fail (1)
		t.advance(CONTEXT_BACKOFF_BASE_MS + 1); await turn(t); // ok  -> reset
		await turn(t);                                         // fail again: count is 1 again, wait 10 min
		assert.equal(t.seen.length, 3);
		t.advance(CONTEXT_BACKOFF_BASE_MS + 1); await turn(t);
		assert.equal(t.seen.length, 4, "10 minutes is enough after a reset (it would be 20 without one)");
		t.handle.dispose();
	});

	it("a failure that is NOT a context-window error does not back off", async () => {
		const t = setup(["other", "other", "ok"]); await t.pi.emit("session_start", ctx()); await flush();
		await turn(t); await turn(t); await turn(t);
		assert.equal(t.seen.length, 3);
		t.handle.dispose();
	});

	it("a new session_start clears the backoff and the learned scale", async () => {
		const t = setup(["context", "ok"]); await t.pi.emit("session_start", ctx()); await flush();
		await turn(t); await turn(t); assert.equal(t.seen.length, 1);
		await t.pi.emit("session_start", ctx()); await flush(); await turn(t);
		assert.equal(t.seen.length, 2); assert.equal(t.seen[1].scale, 1);
		t.handle.dispose();
	});

	it("no follow-up loop: a turn that arrives while a failing call is in flight does not re-fire it during the backoff", async () => {
		const t = setup(["context"]); await t.pi.emit("session_start", ctx()); await flush();
		await t.pi.emit("agent_end", ctx()); await t.pi.emit("agent_end", ctx()); await t.pi.emit("agent_end", ctx()); // coalesced into the in-flight call + one dirty follow-up
		await flush(400);
		assert.ok(t.seen.length <= 2, "at most the in-flight call and one coalesced follow-up, got " + t.seen.length);
		const n = t.seen.length; await flush(400); assert.equal(t.seen.length, n, "nothing more arrives by itself");
		t.handle.dispose();
	});
});

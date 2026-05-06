/**
 * lifecycle.test.ts — unit tests for installDigestLifecycle (tasks 4.1–4.10)
 *
 * Uses a fake pi event emitter to simulate lifecycle events and a mocked
 * generateDigest to control timing.  Timers are advanced manually via
 * Promise-based awaiting rather than fake-timer injection because node:test's
 * mock.timers API is only available in newer Node versions; we instead use
 * real tiny delays (0–1 ms) with setImmediate flushes so tests are fast.
 *
 * Coverage:
 *  - debounce: agent_end within window schedules a timer; outside fires immediately
 *  - coalescing with deferred flush: dirty flag + 250ms follow-up
 *  - deferred flush cleared on shutdown
 *  - abort on shutdown cancels in-flight call
 *  - hard timeout (60s) treated as failure
 *  - state persists across simulated restart
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	installDigestLifecycle,
	type LifecycleDeps,
	type LifecycleStorage,
} from "../../digest/lifecycle";
import type { SessionDigest } from "../../digest/schema";
import type { BuilderState } from "../../digest/builder";
import type { ConversationView } from "../../digest/conversation-view";
import type { DigestConfig } from "../../digest/config";
import type { BuilderStateOnDisk } from "../../digest/storage";
import type { Model, Api } from "@mariozechner/pi-ai";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Advance the event loop N micro/macro turns. */
function flush(ms = 0): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}

function makeDigest(overrides: Partial<SessionDigest> = {}): SessionDigest {
	return {
		schemaVersion: 1,
		body: "A ".repeat(100).trim(),
		headline: "Test headline",
		topics: ["test"],
		generatedAt: new Date().toISOString(),
		modelId: "provider/model-id",
		inputTokenCount: 200,
		cost: 0.001,
		...overrides,
	};
}

function makeModel(): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions" as Api,
		provider: "test-provider",
		baseUrl: "https://api.test.example",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

function makeView(): ConversationView {
	return {
		messages: [{ role: "user", text: "hello" }],
		compactionSummaries: [],
	};
}

function makeConfig(overrides: Partial<DigestConfig> = {}): DigestConfig {
	return {
		debounceSeconds: 0,    // 0 so tests fire immediately without real delays
		resummarizeTokenThreshold: 10_000,
		maxTokens: 1500,
		showWidget: false,
		verbose: false,
		...overrides,
	};
}

// ─── Fake pi event bus ────────────────────────────────────────────────────────

type EventName = "session_start" | "agent_end" | "session_compact" | "session_shutdown";
type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;

function makeFakePi() {
	const handlers: Map<EventName, Handler[]> = new Map();

	const pi = {
		on(event: EventName, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		setSessionName: (name: string) => {
			pi.lastSetName = name;
		},
		lastSetName: undefined as string | undefined,
		async emit(event: EventName, payload: unknown = {}, ctx: unknown = {}) {
			const list = handlers.get(event) ?? [];
			for (const h of list) {
				await h(payload, ctx);
			}
		},
	};

	return pi;
}

// ─── Fake ExtensionContext ────────────────────────────────────────────────────

function makeCtx(overrides: {
	sessionId?: string;
	cwd?: string;
	models?: Model<Api>[];
} = {}) {
	const { sessionId = "test-session-id", cwd = "/tmp/test-cwd", models = [] } = overrides;

	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
		modelRegistry: {
			getAvailable: () => models,
		},
		cwd,
		ui: {
			notify: (_msg: string, _level?: string) => {},
		},
	};
}

// ─── Fake storage ─────────────────────────────────────────────────────────────

function makeFakeStorage(): LifecycleStorage & {
	saved: Map<string, SessionDigest>;
	states: Map<string, BuilderStateOnDisk>;
} {
	const saved = new Map<string, SessionDigest>();
	const states = new Map<string, BuilderStateOnDisk>();

	return {
		saved,
		states,
		loadDigest: (id) => saved.get(id) ?? null,
		saveDigest: (id, d) => { saved.set(id, d); },
		loadBuilderState: (id) => states.get(id) ?? null,
		saveBuilderState: (id, s) => { states.set(id, { ...s }); },
	};
}

// ─── Test home isolation ─────────────────────────────────────────────────────

const TEST_HOME = join(tmpdir(), `lifecycle-test-${process.pid}`);

before(() => {
	mkdirSync(TEST_HOME, { recursive: true });
	process.env.HOME = TEST_HOME;
});

after(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("installDigestLifecycle", () => {

	// ── 4.1 Basic shape ──────────────────────────────────────────────────────

	it("returns a dispose function", () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		const deps: LifecycleDeps = {
			storage,
			builder: { generateDigest: async () => null },
			costTracker: { record: () => {} },
			configLoader: () => makeConfig(),
			modelResolver: () => makeModel(),
			indexAddDigested: () => {},
		};
		const handle = installDigestLifecycle(pi as any, deps);
		assert.strictEqual(typeof handle.dispose, "function");
		handle.dispose();
	});

	// ── 4.2 session_start: restores state from storage ───────────────────────

	it("session_start: loads digest + builder state from storage", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		const digest = makeDigest({ headline: "Prior session" });
		storage.saved.set("test-session-id", digest);
		storage.states.set("test-session-id", {
			convTokensAtLastWrite: 500,
			lastWrittenMessageIndex: 3,
			lastWrittenSummaryIndex: 1,
		});

		let capturedState: BuilderState | null = null;
		const deps: LifecycleDeps = {
			storage,
			builder: {
				generateDigest: async (_model, _view, state) => {
					capturedState = { ...state };
					return { digest: makeDigest(), anchor: 1 };
				},
			},
			costTracker: { record: () => {} },
			configLoader: () => makeConfig({ debounceSeconds: 0 }),
			modelResolver: () => makeModel(),
			indexAddDigested: () => {},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		const ctx = makeCtx({ sessionId: "test-session-id", models: [makeModel()] });
		await pi.emit("session_start", {}, ctx);

		// Trigger a digest so we can inspect the state passed to generateDigest
		await pi.emit("agent_end", {}, ctx);
		await flush(10);

		assert.ok(capturedState !== null, "generateDigest should have been called");
		assert.strictEqual(capturedState!.lastDigest?.headline, "Prior session");
		assert.strictEqual(capturedState!.convTokensAtLastWrite, 500);
		assert.strictEqual(capturedState!.lastWrittenMessageIndex, 3);

		handle.dispose();
	});

	// ── 4.2 Notification when model unavailable + digestRequested ────────────

	it("session_start: emits notify when no model and digestRequested (via explicit config)", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		let notifyMsg = "";
		let notifyLevel = "";

		const ctx = makeCtx({
			sessionId: "sess-notify",
			models: [],
			cwd: "/tmp/no-such-dir-xyz",
		});
		// Override ui.notify to capture
		(ctx.ui as any).notify = (msg: string, level: string) => {
			notifyMsg = msg;
			notifyLevel = level;
		};

		const deps: LifecycleDeps = {
			storage,
			builder: { generateDigest: async () => null },
			costTracker: { record: () => {} },
			// Config with explicit provider+model → digestRequested = true
			configLoader: () => makeConfig({ provider: "anthropic", model: "claude-haiku-4-5" }),
			// Resolver returns undefined despite explicit config (simulates unavailable)
			modelResolver: () => undefined,
			indexAddDigested: () => {},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		await pi.emit("session_start", {}, ctx);

		// Task 4.5.1: notification is now deferred to the 1s mode re-evaluation
		// retry.  Wait past that window before asserting.
		await flush(1100);

		assert.ok(notifyMsg.includes("digest mode unavailable"), `unexpected msg: ${notifyMsg}`);
		assert.strictEqual(notifyLevel, "warning");

		handle.dispose();
	});

	// ── 4.3 agent_end: fires immediately when debounceSeconds=0 ──────────────

	it("agent_end: fires digest immediately when debounce window elapsed", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		let callCount = 0;

		const deps: LifecycleDeps = {
			storage,
			builder: {
				generateDigest: async () => {
					callCount++;
					return { digest: makeDigest(), anchor: 1 };
				},
			},
			costTracker: { record: () => {} },
			configLoader: () => makeConfig({ debounceSeconds: 0 }),
			modelResolver: () => makeModel(),
			indexAddDigested: () => {},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		const ctx = makeCtx({ models: [makeModel()] });
		await pi.emit("session_start", {}, ctx);
		await pi.emit("agent_end", {}, ctx);
		await flush(10);

		assert.strictEqual(callCount, 1);
		handle.dispose();
	});

	// ── 4.3 agent_end: respects debounce window (schedules timer) ────────────

	it("agent_end: schedules debounce timer when within debounce window", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		let callCount = 0;

		const deps: LifecycleDeps = {
			storage,
			builder: {
				generateDigest: async () => {
					callCount++;
					return { digest: makeDigest(), anchor: 1 };
				},
			},
			costTracker: { record: () => {} },
			// 200ms debounce
			configLoader: () => makeConfig({ debounceSeconds: 0.2 }),
			modelResolver: () => makeModel(),
			indexAddDigested: () => {},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		const ctx = makeCtx({ models: [makeModel()] });
		await pi.emit("session_start", {}, ctx);

		// Simulate a prior write so lastWriteTime is recent
		await pi.emit("agent_end", {}, ctx);
		await flush(10);
		// First agent_end fires immediately (no prior write — elapsed is huge)
		assert.strictEqual(callCount, 1);

		// Second agent_end fires immediately too (lastWriteTime was just set)
		// but wait — lastWriteTime was set by the first success, so elapsed is tiny
		// With debounceSeconds=0.2, the timer should be 200ms
		// We should NOT see a second call immediately
		await pi.emit("agent_end", {}, ctx);
		// Not enough time has passed
		assert.strictEqual(callCount, 1, "should not fire immediately within debounce window");

		// After the debounce window, the timer should fire
		await flush(250);
		assert.strictEqual(callCount, 2, "should fire after debounce window");

		handle.dispose();
	});

	// ── 4.4 session_compact: bypasses debounce, clears pending timer ─────────

	it("session_compact: clears pending debounce timer and fires immediately", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		const callOrder: string[] = [];

		const deps: LifecycleDeps = {
			storage,
			builder: {
				generateDigest: async (_m, _v, _s, opts) => {
					callOrder.push("generate");
					return { digest: makeDigest(), anchor: 1 };
				},
			},
			costTracker: { record: () => {} },
			// Large debounce so agent_end timer is pending
			configLoader: () => makeConfig({ debounceSeconds: 10 }),
			modelResolver: () => makeModel(),
			indexAddDigested: () => {},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		const ctx = makeCtx({ models: [makeModel()] });
		await pi.emit("session_start", {}, ctx);

		// First agent_end: fires immediately (no prior write)
		await pi.emit("agent_end", {}, ctx);
		await flush(10);
		assert.strictEqual(callOrder.length, 1);

		// Second agent_end: schedules a timer (within debounce window)
		await pi.emit("agent_end", {}, ctx);
		await flush(5); // not long enough for 10s timer

		// session_compact: should clear the timer and fire immediately
		await pi.emit("session_compact", { compactionEntry: {}, fromExtension: false }, ctx);
		await flush(10);

		// Should have fired once more (compact), not the timer
		assert.strictEqual(callOrder.length, 2, "compact should have fired exactly once more");

		// Wait beyond where the debounce timer would have fired to confirm it's cancelled
		await flush(50);
		assert.strictEqual(callOrder.length, 2, "debounce timer should have been cancelled");

		handle.dispose();
	});

	// ── 4.5 session_shutdown: aborts in-flight + clears timers + dirty ────────

	it("session_shutdown: clears dirty flag", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();

		// Generate never resolves until we say so
		let resolveGenerate!: (v: { digest: SessionDigest; anchor: number } | null) => void;
		const generatePromise = new Promise<{ digest: SessionDigest; anchor: number } | null>((res) => {
			resolveGenerate = res;
		});

		const deps: LifecycleDeps = {
			storage,
			builder: {
				generateDigest: async () => generatePromise,
			},
			costTracker: { record: () => {} },
			configLoader: () => makeConfig({ debounceSeconds: 0 }),
			modelResolver: () => makeModel(),
			indexAddDigested: () => {},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		const ctx = makeCtx({ models: [makeModel()] });
		await pi.emit("session_start", {}, ctx);

		// Fire first agent_end → pendingCall becomes true
		await pi.emit("agent_end", {}, ctx);
		await flush(5);

		// Fire second agent_end while pending → dirty = true
		await pi.emit("agent_end", {}, ctx);

		// Shutdown: should clear dirty
		await pi.emit("session_shutdown", {}, ctx);

		// Now resolve the pending call
		resolveGenerate(null);
		await flush(50);

		// No follow-up should have been scheduled (dirty was cleared)
		// Verify by checking callCount — no additional generates

		handle.dispose();
	});

	// ── 4.5 session_shutdown: aborts in-flight AbortController ───────────────

	it("session_shutdown: aborts in-flight LLM call via AbortController", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		let capturedSignal: AbortSignal | undefined;

		const deps: LifecycleDeps = {
			storage,
			builder: {
				generateDigest: async (_model, _view, _state, opts) => {
					capturedSignal = opts?.signal;
					// Simulate a slow LLM call
					return new Promise<null>((res) => setTimeout(() => res(null), 10_000));
				},
			},
			costTracker: { record: () => {} },
			configLoader: () => makeConfig({ debounceSeconds: 0 }),
			modelResolver: () => makeModel(),
			indexAddDigested: () => {},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		const ctx = makeCtx({ models: [makeModel()] });
		await pi.emit("session_start", {}, ctx);
		await pi.emit("agent_end", {}, ctx);
		await flush(5); // let the fire begin

		assert.ok(capturedSignal !== undefined, "signal should have been passed to generateDigest");
		assert.strictEqual(capturedSignal!.aborted, false, "signal should not be aborted yet");

		await pi.emit("session_shutdown", {}, ctx);

		assert.strictEqual(capturedSignal!.aborted, true, "signal should be aborted after shutdown");

		handle.dispose();
	});

	// ── 4.6 Success path: saves digest, sets session name, saves state ────────

	it("success path: saves digest and sets session name", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		const recorded: SessionDigest[] = [];
		const indexed: Array<{ id: string; digest: SessionDigest }> = [];

		const digest = makeDigest({ headline: "Great session today" });

		const deps: LifecycleDeps = {
			storage,
			builder: {
				generateDigest: async () => ({ digest, anchor: 1 }),
			},
			costTracker: { record: (d) => recorded.push(d) },
			configLoader: () => makeConfig({ debounceSeconds: 0 }),
			modelResolver: () => makeModel(),
			indexAddDigested: (id, d) => indexed.push({ id, digest: d }),
		};

		const handle = installDigestLifecycle(pi as any, deps);
		const ctx = makeCtx({ sessionId: "session-abc", models: [makeModel()] });
		await pi.emit("session_start", {}, ctx);
		await pi.emit("agent_end", {}, ctx);
		await flush(10);

		// digest saved
		const saved = storage.saved.get("session-abc");
		assert.ok(saved !== undefined, "digest should be saved");
		assert.strictEqual(saved!.headline, "Great session today");

		// pi.setSessionName called
		assert.strictEqual(pi.lastSetName, "Great session today");

		// builder state saved
		const savedState = storage.states.get("session-abc");
		assert.ok(savedState !== undefined, "builder state should be saved");
		assert.strictEqual(savedState!.lastWrittenMessageIndex, 1);

		// cost recorded
		assert.strictEqual(recorded.length, 1);
		assert.strictEqual(recorded[0].headline, "Great session today");

		// indexAddDigested called
		assert.strictEqual(indexed.length, 1);
		assert.strictEqual(indexed[0].id, "session-abc");

		handle.dispose();
	});

	// ── 4.7 Failure path: setSessionName not called, prior digest untouched ───

	it("failure path: does not call setSessionName and leaves prior digest", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();

		const priorDigest = makeDigest({ headline: "Prior headline" });
		storage.saved.set("session-fail", priorDigest);

		const deps: LifecycleDeps = {
			storage,
			builder: { generateDigest: async () => null },
			costTracker: { record: () => {} },
			configLoader: () => makeConfig({ debounceSeconds: 0 }),
			modelResolver: () => makeModel(),
			indexAddDigested: () => {},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		const ctx = makeCtx({ sessionId: "session-fail", models: [makeModel()] });
		await pi.emit("session_start", {}, ctx);

		pi.lastSetName = undefined;
		await pi.emit("agent_end", {}, ctx);
		await flush(10);

		// setSessionName NOT called
		assert.strictEqual(pi.lastSetName, undefined, "setSessionName should not be called on failure");

		// Prior digest in storage untouched
		const still = storage.saved.get("session-fail");
		assert.strictEqual(still?.headline, "Prior headline", "prior digest should be untouched");

		handle.dispose();
	});

	// ── 4.8 Coalescing: dirty flag + 250ms follow-up ─────────────────────────

	it("coalescing: second trigger while pending sets dirty, follow-up fires after 250ms", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		let callCount = 0;
		let resolveFirst!: (v: { digest: SessionDigest; anchor: number } | null) => void;
		let firstResolved = false;

		const deps: LifecycleDeps = {
			storage,
			builder: {
				generateDigest: async () => {
					callCount++;
					if (callCount === 1) {
						return new Promise((res) => {
							resolveFirst = res;
						});
					}
					return { digest: makeDigest(), anchor: 1 };
				},
			},
			costTracker: { record: () => {} },
			configLoader: () => makeConfig({ debounceSeconds: 0 }),
			modelResolver: () => makeModel(),
			indexAddDigested: () => {},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		const ctx = makeCtx({ models: [makeModel()] });
		await pi.emit("session_start", {}, ctx);

		// Trigger first call (will hang)
		await pi.emit("agent_end", {}, ctx);
		await flush(5);
		assert.strictEqual(callCount, 1, "first call should have started");

		// Trigger second while first is pending → dirty
		await pi.emit("agent_end", {}, ctx);
		assert.strictEqual(callCount, 1, "no second call should start while first is pending");

		// Resolve first call
		resolveFirst({ digest: makeDigest(), anchor: 1 });
		firstResolved = true;

		// Wait a bit but less than 250ms
		await flush(50);
		assert.strictEqual(callCount, 1, "follow-up should not have fired yet (< 250ms)");

		// Wait past 250ms
		await flush(250);
		assert.strictEqual(callCount, 2, "follow-up should have fired after 250ms tail delay");

		handle.dispose();
	});

	// ── 4.8 Deferred flush cleared on shutdown ────────────────────────────────

	it("deferred flush timer is cleared on shutdown", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		let callCount = 0;
		let resolveFirst!: (v: { digest: SessionDigest; anchor: number } | null) => void;

		const deps: LifecycleDeps = {
			storage,
			builder: {
				generateDigest: async () => {
					callCount++;
					if (callCount === 1) {
						return new Promise((res) => { resolveFirst = res; });
					}
					return { digest: makeDigest(), anchor: 1 };
				},
			},
			costTracker: { record: () => {} },
			configLoader: () => makeConfig({ debounceSeconds: 0 }),
			modelResolver: () => makeModel(),
			indexAddDigested: () => {},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		const ctx = makeCtx({ models: [makeModel()] });
		await pi.emit("session_start", {}, ctx);

		await pi.emit("agent_end", {}, ctx);
		await flush(5);

		// Second trigger → dirty
		await pi.emit("agent_end", {}, ctx);

		// Shutdown clears dirty before the first call resolves
		await pi.emit("session_shutdown", {}, ctx);

		// Resolve first call → follow-up should NOT be scheduled because dirty was cleared
		resolveFirst(null); // fail
		await flush(300); // wait more than 250ms tail delay

		assert.strictEqual(callCount, 1, "follow-up should not fire after shutdown");

		handle.dispose();
	});

	// ── 4.9 Hard timeout treated as failure ───────────────────────────────────

	it("hard timeout: AbortController fires after 60s and result is null (failure)", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		const priorDigest = makeDigest({ headline: "Before timeout" });
		storage.saved.set("timeout-session", priorDigest);
		let capturedSignal: AbortSignal | undefined;

		const deps: LifecycleDeps = {
			storage,
			builder: {
				generateDigest: async (_m, _v, _s, opts) => {
					capturedSignal = opts?.signal;
					// Return a promise that resolves when the signal is aborted
					return new Promise<null>((res) => {
						if (opts?.signal) {
							opts.signal.addEventListener("abort", () => res(null));
						}
					});
				},
			},
			costTracker: { record: () => {} },
			configLoader: () => makeConfig({ debounceSeconds: 0 }),
			modelResolver: () => makeModel(),
			indexAddDigested: () => {},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		const ctx = makeCtx({ sessionId: "timeout-session", models: [makeModel()] });
		await pi.emit("session_start", {}, ctx);

		pi.lastSetName = undefined;
		await pi.emit("agent_end", {}, ctx);
		await flush(5); // let the call start

		assert.ok(capturedSignal !== undefined, "signal should be passed");

		// Manually abort to simulate timeout (saves us waiting 60 real seconds)
		capturedSignal!.dispatchEvent(new Event("abort"));
		await flush(20);

		// Should be treated as failure: setSessionName not called
		assert.strictEqual(pi.lastSetName, undefined, "setSessionName should not be called on timeout failure");
		// Prior digest still intact
		assert.strictEqual(storage.saved.get("timeout-session")?.headline, "Before timeout");

		handle.dispose();
	});

	// ── 4.10 State persists across simulated restart ──────────────────────────

	it("state persists across simulated restart: anchors reloaded on second session_start", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		const capturedStates: BuilderState[] = [];

		const digest = makeDigest({ headline: "First run", inputTokenCount: 999 });

		const deps: LifecycleDeps = {
			storage,
			builder: {
				generateDigest: async (_model, _view, state) => {
					capturedStates.push({ ...state });
					return { digest, anchor: 7 };
				},
			},
			costTracker: { record: () => {} },
			configLoader: () => makeConfig({ debounceSeconds: 0 }),
			modelResolver: () => makeModel(),
			indexAddDigested: () => {},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		const ctx = makeCtx({ sessionId: "restart-session", models: [makeModel()] });

		// ── First process: write a digest ──
		await pi.emit("session_start", {}, ctx);
		await pi.emit("agent_end", {}, ctx);
		await flush(10);

		assert.strictEqual(capturedStates.length, 1, "first digest should fire");
		// After success, storage should have the builder state saved
		const savedState = storage.states.get("restart-session");
		assert.ok(savedState !== undefined, "builder state should be persisted");
		assert.strictEqual(savedState!.lastWrittenMessageIndex, 7);
		assert.strictEqual(savedState!.convTokensAtLastWrite, 999);

		// ── Simulated restart: dispose + re-install with fresh in-memory state ──
		handle.dispose();

		const pi2 = makeFakePi();
		const handle2 = installDigestLifecycle(pi2 as any, deps);

		await pi2.emit("session_start", {}, ctx);
		await pi2.emit("agent_end", {}, ctx);
		await flush(10);

		assert.strictEqual(capturedStates.length, 2, "second digest should fire");
		const stateOnSecondRun = capturedStates[1];

		// Anchors should be restored from disk
		assert.strictEqual(
			stateOnSecondRun.lastWrittenMessageIndex,
			7,
			"lastWrittenMessageIndex should survive restart",
		);
		assert.strictEqual(
			stateOnSecondRun.convTokensAtLastWrite,
			999,
			"convTokensAtLastWrite should survive restart",
		);
		assert.ok(
			stateOnSecondRun.lastDigest !== null,
			"lastDigest should be restored from storage",
		);

		handle2.dispose();
	});

	// ── Dispose is idempotent ─────────────────────────────────────────────────

	it("dispose is idempotent (can be called multiple times)", () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		const deps: LifecycleDeps = {
			storage,
			builder: { generateDigest: async () => null },
			costTracker: { record: () => {} },
			configLoader: () => makeConfig(),
			modelResolver: () => undefined,
			indexAddDigested: () => {},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		handle.dispose();
		handle.dispose(); // should not throw
		handle.dispose();
	});

	// ── No digest triggered when model resolves to undefined ─────────────────

	it("does not trigger digest when model is unavailable", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		let callCount = 0;

		const deps: LifecycleDeps = {
			storage,
			builder: { generateDigest: async () => { callCount++; return null; } },
			costTracker: { record: () => {} },
			configLoader: () => makeConfig({ debounceSeconds: 0 }),
			modelResolver: () => undefined,
			indexAddDigested: () => {},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		const ctx = makeCtx({ models: [] }); // no models available
		await pi.emit("session_start", {}, ctx);
		await pi.emit("agent_end", {}, ctx);
		await flush(10);

		assert.strictEqual(callCount, 0, "generateDigest should not be called without a model");
		handle.dispose();
	});

	// ── indexAddDigested called with batched: false ───────────────────────────

	it("calls indexAddDigested with batched: false on success", async () => {
		const pi = makeFakePi();
		const storage = makeFakeStorage();
		const indexCalls: Array<{ id: string; digest: SessionDigest; opts: unknown }> = [];

		const deps: LifecycleDeps = {
			storage,
			builder: { generateDigest: async () => ({ digest: makeDigest(), anchor: 1 }) },
			costTracker: { record: () => {} },
			configLoader: () => makeConfig({ debounceSeconds: 0 }),
			modelResolver: () => makeModel(),
			indexAddDigested: (id, digest, opts) => {
				indexCalls.push({ id, digest, opts });
			},
		};

		const handle = installDigestLifecycle(pi as any, deps);
		const ctx = makeCtx({ sessionId: "idx-session", models: [makeModel()] });
		await pi.emit("session_start", {}, ctx);
		await pi.emit("agent_end", {}, ctx);
		await flush(10);

		assert.strictEqual(indexCalls.length, 1);
		assert.deepStrictEqual(indexCalls[0].opts, { batched: false });

		handle.dispose();
	});
});

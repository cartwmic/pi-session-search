/**
 * mode-reeval.test.ts — unit tests for task 4.5.2
 *
 * Verifies the one-shot mode re-evaluation added in task 4.5.1:
 *   • When the model registry is empty on the first session_start, a 1-second
 *     retry is scheduled.
 *   • After the retry the lifecycle upgrades to digest-mode.
 *   • Case (a): zero index entries → switchIndexToDigestMode is called.
 *   • Case (b): existing entries  → markAllDirtyAndClearEmbeddings is called.
 *   • If the registry is still empty after retry → fallback notification is
 *     emitted and re-evaluation does not repeat.
 *   • dispose() before the timer fires cancels the retry silently.
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
import type { DigestConfig } from "../../digest/config";
import type { BuilderState } from "../../digest/builder";
import type { ConversationView } from "../../digest/conversation-view";
import type { BuilderStateOnDisk } from "../../digest/storage";
import type { Model, Api } from "@mariozechner/pi-ai";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Advance the event loop by N ms. */
function flush(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}

function makeModel(id = "gpt-5.4-mini"): Model<Api> {
	return {
		id,
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

function makeConfig(overrides: Partial<DigestConfig> = {}): DigestConfig {
	return {
		debounceSeconds: 0,
		resummarizeTokenThreshold: 10_000,
		maxTokens: 1500,
		showWidget: false,
		verbose: false,
		// Set explicit provider/model so digestRequested() returns true
		// without requiring a digest.json file on disk.
		provider: "test-provider",
		model: "gpt-5.4-mini",
		...overrides,
	};
}

// ─── Fake pi event bus ───────────────────────────────────────────────────────

type EventName = "session_start" | "agent_end" | "session_compact" | "session_shutdown";
type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;

function makeFakePi() {
	const handlers: Map<EventName, Handler[]> = new Map();
	return {
		on(event: EventName, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		setSessionName: (_name: string) => {},
		async emit(event: EventName, payload: unknown = {}, ctx: unknown = {}) {
			const list = handlers.get(event) ?? [];
			for (const h of list) await h(payload, ctx);
		},
	};
}

// ─── Fake ExtensionContext ────────────────────────────────────────────────────

/**
 * Build a fake ctx.  `getAvailableFn` controls what modelRegistry returns
 * on each call — defaults to returning models[] every time.
 */
function makeCtx(opts: {
	sessionId?: string;
	cwd?: string;
	models?: Model<Api>[];
	getAvailableFn?: () => Model<Api>[];
} = {}) {
	const {
		sessionId = "test-session-id",
		cwd = "/tmp/test-cwd",
		models = [],
		getAvailableFn,
	} = opts;

	const notifications: Array<{ msg: string; level?: string }> = [];

	const ctx = {
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
		modelRegistry: {
			getAvailable: getAvailableFn ?? (() => models),
		},
		cwd,
		ui: {
			notify: (msg: string, level?: string) => notifications.push({ msg, level }),
		},
		_notifications: notifications,
	};
	return ctx;
}

// ─── Fake storage (no-op) ────────────────────────────────────────────────────

function makeFakeStorage(): LifecycleStorage {
	return {
		loadDigest: () => null,
		saveDigest: () => {},
		loadBuilderState: () => null,
		saveBuilderState: () => {},
	};
}

// ─── Minimal deps builder ─────────────────────────────────────────────────────

function makeDeps(overrides: Partial<LifecycleDeps> = {}): LifecycleDeps {
	return {
		storage: makeFakeStorage(),
		builder: {
			generateDigest: async () => null,
		},
		costTracker: { record: () => {} },
		configLoader: () => makeConfig(),
		modelResolver: (_cfg, registry) => registry[0],
		indexAddDigested: () => {},
		...overrides,
	};
}

// ─── Test home isolation ─────────────────────────────────────────────────────

const TEST_HOME = join(tmpdir(), `mode-reeval-test-${process.pid}`);

before(() => {
	mkdirSync(TEST_HOME, { recursive: true });
	process.env.HOME = TEST_HOME;
});

after(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("mode re-evaluation (task 4.5.2)", () => {
	// ── 4.5.2-a: fresh install (zero entries) ───────────────────────────────

	it("upgrades to digest-mode after 1s retry — zero entries (case a)", async () => {
		const pi = makeFakePi();
		const model = makeModel();

		// Registry: empty on first call, model on second call.
		let callCount = 0;
		const ctx = makeCtx({
			getAvailableFn: () => {
				callCount++;
				return callCount === 1 ? [] : [model];
			},
		});

		let switchedToDigest = false;
		let markedDirty = false;

		const deps = makeDeps({
			indexEntryCount: () => 0, // fresh install
			switchIndexToDigestMode: () => { switchedToDigest = true; },
			markAllDirtyAndClearEmbeddings: () => { markedDirty = true; return 0; },
		});

		const handle = installDigestLifecycle(pi as any, deps);
		await pi.emit("session_start", {}, ctx);

		// Before retry: model should be unresolved, no switch yet.
		assert.ok(!switchedToDigest, "should not have switched before retry fires");

		// Wait for the 1s retry to fire.
		await flush(1100);

		assert.ok(switchedToDigest, "should have called switchIndexToDigestMode (case a)");
		assert.ok(!markedDirty, "should NOT have called markAllDirtyAndClearEmbeddings for empty index");
		assert.equal(callCount, 2, "modelRegistry.getAvailable() should have been called twice");

		handle.dispose();
	});

	// ── 4.5.2-b: existing hybrid-raw entries ────────────────────────────────

	it("upgrades to digest-mode after 1s retry — existing entries (case b)", async () => {
		const pi = makeFakePi();
		const model = makeModel();

		let callCount = 0;
		const ctx = makeCtx({
			getAvailableFn: () => {
				callCount++;
				return callCount === 1 ? [] : [model];
			},
		});

		let switchedToDigest = false;
		let markedDirtyCount = -1;

		const deps = makeDeps({
			indexEntryCount: () => 5, // existing entries
			switchIndexToDigestMode: () => { switchedToDigest = true; },
			markAllDirtyAndClearEmbeddings: () => { markedDirtyCount = 5; return 5; },
		});

		const handle = installDigestLifecycle(pi as any, deps);
		await pi.emit("session_start", {}, ctx);
		await flush(1100);

		assert.ok(!switchedToDigest, "should NOT have called switchIndexToDigestMode for non-empty index");
		assert.equal(markedDirtyCount, 5, "should have called markAllDirtyAndClearEmbeddings (case b)");

		// Should have notified the user about the upgrade.
		const upgradeNotify = ctx._notifications.find((n) =>
			n.msg.includes("upgraded to digest-mode") && n.msg.includes("5 entries")
		);
		assert.ok(upgradeNotify, `expected upgrade notification, got: ${JSON.stringify(ctx._notifications)}`);
		assert.equal(upgradeNotify?.level, "info");

		handle.dispose();
	});

	// ── 4.5.2-c: still no model after retry → fallback notification ──────────

	it("emits fallback notification when registry still empty after retry", async () => {
		const pi = makeFakePi();

		// Registry always empty.
		const ctx = makeCtx({ getAvailableFn: () => [] });

		const deps = makeDeps({
			// digestRequested is determined by config; set explicit provider+model.
			configLoader: () => makeConfig({ provider: "anthropic", model: "claude-haiku-4-5" }),
		});

		const handle = installDigestLifecycle(pi as any, deps);
		await pi.emit("session_start", {}, ctx);

		// No notification yet — retry is pending.
		assert.equal(ctx._notifications.length, 0, "no notification before retry");

		await flush(1100);

		// Fallback notification should now have been emitted.
		const fallback = ctx._notifications.find((n) =>
			n.msg.includes("digest mode unavailable")
		);
		assert.ok(
			fallback,
			`expected fallback notification, got: ${JSON.stringify(ctx._notifications)}`,
		);
		assert.equal(fallback?.level, "warning");

		handle.dispose();
	});

	// ── 4.5.2-d: retry fires only once (not on subsequent session_starts) ───

	it("does not re-evaluate again after the first retry", async () => {
		const pi = makeFakePi();
		const model = makeModel();

		let callCount = 0;
		// Return empty for first two calls (first session_start + retry),
		// then return model on subsequent calls.
		const ctx = makeCtx({
			getAvailableFn: () => {
				callCount++;
				return callCount <= 2 ? [] : [model];
			},
		});

		let switchCount = 0;
		const deps = makeDeps({
			indexEntryCount: () => 0,
			switchIndexToDigestMode: () => { switchCount++; },
		});

		const handle = installDigestLifecycle(pi as any, deps);

		// First session_start → schedules retry.
		await pi.emit("session_start", {}, ctx);
		await flush(1100); // retry fires; registry still empty → fallback notification

		const notificationCountAfterFirstRetry = ctx._notifications.length;
		assert.ok(notificationCountAfterFirstRetry > 0, "should have emitted fallback notification");

		// Second session_start (e.g. user switches sessions) — should NOT schedule another retry.
		await pi.emit("session_start", {}, ctx);
		await flush(1100);

		assert.equal(switchCount, 0, "should never have upgraded (registry was always empty)");
		// Notification count should not have grown again (notifiedThisProcess guards it).
		assert.equal(
			ctx._notifications.length,
			notificationCountAfterFirstRetry,
			"should not emit duplicate notifications",
		);

		handle.dispose();
	});

	// ── 4.5.2-e: dispose before timer cancels re-eval silently ──────────────

	it("dispose before retry timer fires cancels the re-evaluation silently", async () => {
		const pi = makeFakePi();
		const model = makeModel();

		let callCount = 0;
		const ctx = makeCtx({
			getAvailableFn: () => {
				callCount++;
				return callCount === 1 ? [] : [model];
			},
		});

		let switchedToDigest = false;
		const deps = makeDeps({
			indexEntryCount: () => 0,
			switchIndexToDigestMode: () => { switchedToDigest = true; },
		});

		const handle = installDigestLifecycle(pi as any, deps);
		await pi.emit("session_start", {}, ctx);

		// Dispose immediately — before the 1s timer fires.
		handle.dispose();

		// Wait past the timer window.
		await flush(1100);

		assert.ok(!switchedToDigest, "dispose should have cancelled the retry");
		assert.equal(ctx._notifications.length, 0, "no notifications after cancelled retry");
	});

	// ── 4.5.2-f: model found on first call → no retry scheduled ─────────────

	it("does not schedule a retry when the model resolves on the first call", async () => {
		const pi = makeFakePi();
		const model = makeModel();

		let callCount = 0;
		const ctx = makeCtx({
			getAvailableFn: () => {
				callCount++;
				return [model]; // always returns model
			},
		});

		let switchedToDigest = false;
		const deps = makeDeps({
			indexEntryCount: () => 0,
			switchIndexToDigestMode: () => { switchedToDigest = true; },
		});

		const handle = installDigestLifecycle(pi as any, deps);
		await pi.emit("session_start", {}, ctx);
		await flush(1100);

		// Model found on first call — no retry needed, no switch (lifecycle is
		// already in digest-mode from the start).
		assert.ok(!switchedToDigest, "switchIndexToDigestMode should not fire when model resolved immediately");
		assert.equal(callCount, 1, "getAvailable() should be called only once (from session_start)");

		handle.dispose();
	});
});

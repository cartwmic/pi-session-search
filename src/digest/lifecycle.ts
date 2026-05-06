/**
 * Digest lifecycle wiring.
 *
 * Installs four event handlers on ExtensionAPI:
 *   session_start    → reload config + restore in-memory state from disk
 *   agent_end        → debounced digest trigger
 *   session_compact  → immediate digest trigger (bypass debounce)
 *   session_shutdown → abort in-flight call + cleanup
 *
 * Coalescing rule (4.8): if a trigger fires while pendingCall===true, set
 * dirty=true instead of queueing. When the in-flight call completes (either
 * way), if dirty, schedule ONE follow-up after 250ms tail delay and clear dirty.
 *
 * Hard timeout (4.9): a 60-second AbortController wraps every LLM call; on
 * timeout the call is treated as a failure (4.7).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { sessionSearchHome } from "../utils";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";

import type { SessionDigest } from "./schema";
import type { DigestConfig } from "./config";
import type { BuilderState } from "./builder";
import { emptyBuilderState } from "./builder";
import type { BuilderStateOnDisk } from "./storage";
import type { ConversationView } from "./conversation-view";
import { liveConversationView } from "./conversation-view";
import { AUTO_DETECT_MODELS } from "./model-resolver";

// ─── Module-scoped notification flag ────────────────────────────────────────
//
// Prevents repeated "digest mode unavailable" notifications across session
// switches within the same process load.  Resets when the module is re-loaded
// (extension reload).

// ─── Deps interface ──────────────────────────────────────────────────────────

export interface LifecycleStorage {
	loadDigest: (sessionId: string) => SessionDigest | null;
	saveDigest: (sessionId: string, digest: SessionDigest) => void;
	loadBuilderState: (sessionId: string) => BuilderStateOnDisk | null;
	saveBuilderState: (sessionId: string, state: BuilderStateOnDisk) => void;
}

export interface LifecycleBuilder {
	/** Generate a digest. Returns null on failure (after retry). */
	generateDigest: (
		model: Model<Api>,
		view: ConversationView,
		state: BuilderState,
		opts?: { signal?: AbortSignal; resummarizeTokenThreshold?: number },
	) => Promise<{ digest: SessionDigest; anchor: number } | null>;
}

export interface LifecycleCostTracker {
	/**
	 * Called on every successful digest so callers can accumulate cost.
	 * Receives the digest (which carries `cost` and `inputTokenCount`).
	 */
	record: (digest: SessionDigest) => void;
}

export interface LifecycleDeps {
	storage: LifecycleStorage;
	builder: LifecycleBuilder;
	costTracker: LifecycleCostTracker;
	/** Return the current (possibly reloaded) digest config. */
	configLoader: () => DigestConfig;
	/**
	 * Resolve the digest model from config + registry.
	 * Accepts the same signature as model-resolver.resolveModel so callers can
	 * pass it directly.
	 */
	modelResolver: (config: DigestConfig, registry: Model<Api>[]) => Model<Api> | undefined;
	/**
	 * Called after a successful digest write.  `batched: false` means flush to
	 * disk immediately (live update path).
	 */
	indexAddDigested: (
		sessionId: string,
		digest: SessionDigest,
		opts?: { batched: boolean },
	) => void;

	// ── Task 4.5.1 — mode re-evaluation deps (all optional) ─────────────────

	/**
	 * Returns the number of entries currently held by the active index.
	 * Used by re-evaluation to distinguish a fresh install (zero entries)
	 * from an existing hybrid-raw corpus (non-zero entries).
	 */
	indexEntryCount?: () => number;

	/**
	 * Mark all index entries dirty and clear their embedding fields so that
	 * the search-filter invariant from task 6.11 holds during the transitional
	 * window when upgrading hybrid-raw → digest-mode.  Returns the count of
	 * affected entries.
	 */
	markAllDirtyAndClearEmbeddings?: () => number;

	/**
	 * Switch the active index to digest-mode.  Called only when entry count
	 * is zero (fresh install path) so no embedding clearing is needed.
	 */
	switchIndexToDigestMode?: () => void;
}

// ─── digestRequested predicate ───────────────────────────────────────────────
//
// True iff the user has expressed intent for digest mode:
//   • a digest.json config file exists (global or project-scoped), OR
//   • the loaded config has explicit provider+model fields set.

function digestRequested(config: DigestConfig, cwd: string): boolean {
	const globalFile = join(sessionSearchHome(), "digest.json");
	const projectFile = join(cwd, ".pi", "session-search", "digest.json");

	if (existsSync(globalFile) || existsSync(projectFile)) return true;
	if (config.provider !== undefined && config.model !== undefined) return true;
	return false;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface LifecycleHandle {
	dispose: () => void;
	/**
	 * Force-trigger a digest now via the lifecycle's coalescing path.
	 * Returns a promise that resolves with the digest (or null on failure)
	 * once the in-flight + this trigger have settled.
	 *
	 * Use this from /digest:update and /digest:rewrite to avoid the slash
	 * command racing the auto-digest fired from `agent_end`. Both code paths
	 * share the same `pendingCall` mutex — the second arrival waits for the
	 * first to complete instead of issuing a parallel `complete()` call that
	 * the LLM provider would silently abort.
	 *
	 * `forceFull: true` (used by /digest:rewrite) bumps the
	 * `convTokensAtLastWrite` anchor down so `buildPrompt` selects full
	 * mode regardless of accumulated delta.
	 */
	triggerNow: (opts?: { forceFull?: boolean }) => Promise<SessionDigest | null>;
}

/**
 * Install the digest lifecycle on an ExtensionAPI instance.
 *
 * Returns a handle with `dispose()` to abort in-flight work and stop the
 * lifecycle from doing any further work.  Because ExtensionAPI has no `off()`
 * method the registered handlers remain attached, but they become no-ops once
 * disposed.
 */
export function installDigestLifecycle(
	pi: ExtensionAPI,
	deps: LifecycleDeps,
): LifecycleHandle {
	// ── Per-lifecycle mutable state ──────────────────────────────────────────

	let disposed = false;

	/** Current session id (refreshed on session_start). */
	let sessionId: string | null = null;

	/** Resolved digest model (refreshed on session_start). */
	let currentModel: Model<Api> | undefined = undefined;

	/** In-memory builder state for the current session. */
	let state: BuilderState = emptyBuilderState();

	/** Last error message from a failed digest attempt. */
	let lastError: string | null = null;

	/** Pending debounce timer (from agent_end when debounce window not elapsed). */
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	/** AbortController for the currently in-flight LLM call. */
	let currentAbort: AbortController | null = null;

	/** Hard-timeout timer companion to `currentAbort`. */
	let hardTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

	/** Follow-up timer for the 250ms coalescing tail delay (4.8). */
	let followUpTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Latest ExtensionContext — captured from event handlers so fire-and-forget
	 * async continuations can call ui.notify / sessionManager / etc.
	 */
	let currentCtx: ExtensionContext | null = null;

	/** Current merged config (refreshed on session_start). */
	let config: DigestConfig = deps.configLoader();

	// One-time flag: prevents repeated “digest mode unavailable” notifications
	// within the same lifecycle instance.  Per-lifecycle (not module-scoped) so
	// tests can create independent instances without shared state.
	let notifiedThisProcess = false;

	// ── Task 4.5.1 — mode re-evaluation state ──────────────────────────────

	/**
	 * Timer handle for the one-shot 1-second re-evaluation.
	 * Set when the first session_start finds no model but digestRequested.
	 * Cleared by clearReEvalTimer() or when the timer fires.
	 */
	let reEvalTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * True once the re-evaluation attempt has been made (regardless of outcome).
	 * Prevents scheduling a second retry on subsequent session_start events.
	 */
	let reEvalDone = false;

	// ── Helpers ──────────────────────────────────────────────────────────────

	function clearDebounceTimer(): void {
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	}

	function clearReEvalTimer(): void {
		if (reEvalTimer !== null) {
			clearTimeout(reEvalTimer);
			reEvalTimer = null;
		}
	}

	function clearFollowUpTimer(): void {
		if (followUpTimer !== null) {
			clearTimeout(followUpTimer);
			followUpTimer = null;
		}
	}

	function clearHardTimeout(): void {
		if (hardTimeoutHandle !== null) {
			clearTimeout(hardTimeoutHandle);
			hardTimeoutHandle = null;
		}
	}

	/**
	 * Core fire-and-forget digest invocation.
	 *
	 * Guards:
	 *  - skips if disposed, no model, no sessionId, or pendingCall already set
	 *  - sets pendingCall + clears dirty before any async work
	 *  - on completion (success or failure) checks dirty for a 250ms follow-up
	 */
	async function fireDigest(): Promise<void> {
		if (disposed) return;
		if (!currentModel || !sessionId || !currentCtx) return;
		if (state.pendingCall) {
			state.dirty = true;
			return;
		}

		state.pendingCall = true;
		state.dirty = false;

		// Build the abort controller + hard timeout.
		const ac = new AbortController();
		const timeout = setTimeout(() => ac.abort(), 60_000);
		currentAbort = ac;
		hardTimeoutHandle = timeout;

		// Snapshot ctx so the async continuation doesn't race with session switch.
		const ctx = currentCtx;
		const id = sessionId;
		const model = currentModel;

		const view = liveConversationView(ctx.sessionManager);

		let result: { digest: SessionDigest; anchor: number } | null = null;
		try {
			result = await deps.builder.generateDigest(model, view, state, {
				signal: ac.signal,
				resummarizeTokenThreshold: config.resummarizeTokenThreshold,
			});
		} catch {
			result = null;
		} finally {
			clearHardTimeout();
			if (currentAbort === ac) currentAbort = null;
		}

		state.pendingCall = false;

		if (result !== null) {
			// ── 4.6 Success path ──────────────────────────────────────────────
			const { digest, anchor } = result;

			deps.storage.saveDigest(id, digest);
			pi.setSessionName(digest.headline);

			state.lastDigest = digest;
			state.lastWriteTime = Date.now();
			state.convTokensAtLastWrite = digest.inputTokenCount;
			state.lastWrittenMessageIndex = anchor;
			state.lastWrittenSummaryIndex = view.compactionSummaries.length;
			lastError = null;

			deps.storage.saveBuilderState(id, {
				convTokensAtLastWrite: state.convTokensAtLastWrite,
				lastWrittenMessageIndex: state.lastWrittenMessageIndex,
				lastWrittenSummaryIndex: state.lastWrittenSummaryIndex,
			});

			deps.costTracker.record(digest);
			deps.indexAddDigested(id, digest, { batched: false });
		} else {
			// ── 4.7 Failure path ──────────────────────────────────────────────
			lastError = "digest generation failed (no tool call or validation error after retry)";
			// Prior digest left untouched; do NOT call setSessionName.
		}

		// ── 4.8 Coalescing: if dirty, schedule ONE follow-up ─────────────────
		if (!disposed && state.dirty) {
			state.dirty = false;
			clearFollowUpTimer();
			followUpTimer = setTimeout(() => {
				followUpTimer = null;
				void fireDigest();
			}, 250);
		}
	}

	/**
	 * Trigger a digest, respecting the debounce window.
	 * Called from agent_end.
	 */
	function triggerDebounced(): void {
		if (disposed || !currentModel) return;

		if (state.pendingCall) {
			state.dirty = true;
			return;
		}

		const debounceMs = config.debounceSeconds * 1000;
		const now = Date.now();
		const lastWrite = state.lastWriteTime ?? 0;
		const elapsed = now - lastWrite;

		if (elapsed >= debounceMs) {
			// Enough time since last write — fire immediately.
			void fireDigest();
		} else {
			// Schedule for the remaining debounce window; replace any existing timer.
			clearDebounceTimer();
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				void fireDigest();
			}, debounceMs - elapsed);
		}
	}

	/**
	 * Trigger a digest immediately, bypassing the debounce window.
	 * Called from session_compact.
	 */
	function triggerImmediate(): void {
		if (disposed || !currentModel) return;

		clearDebounceTimer();

		if (state.pendingCall) {
			state.dirty = true;
			return;
		}

		void fireDigest();
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		if (disposed) return;

		currentCtx = ctx;
		config = deps.configLoader();

		sessionId = ctx.sessionManager.getSessionId();

		// Restore in-memory state from disk so incremental anchors survive restart.
		const savedDigest = deps.storage.loadDigest(sessionId);
		const savedBuilderState = deps.storage.loadBuilderState(sessionId);

		state = emptyBuilderState();
		state.lastDigest = savedDigest;

		if (savedBuilderState) {
			state.convTokensAtLastWrite = savedBuilderState.convTokensAtLastWrite;
			state.lastWrittenMessageIndex = savedBuilderState.lastWrittenMessageIndex;
			state.lastWrittenSummaryIndex = savedBuilderState.lastWrittenSummaryIndex;
		}

		// Resolve the digest model for this session.
		currentModel = deps.modelResolver(config, ctx.modelRegistry.getAvailable());

		// ── Task 4.5.1: schedule one-shot mode re-evaluation ─────────────────
		//
		// ctx.modelRegistry.getAvailable() may be empty or incomplete during
		// the first extension-load session_start (the registry populates
		// asynchronously).  If the user opted in but no model resolved, wait
		// 1 s then try again.  Only schedule the retry once per lifecycle; the
		// reEvalDone flag prevents a second attempt on subsequent session_starts.
		if (currentModel === undefined && digestRequested(config, ctx.cwd)) {
			if (!reEvalDone && reEvalTimer === null) {
				// First detection failed — defer notification to reEvaluate().
				const capturedCtx = ctx;
				reEvalTimer = setTimeout(() => {
					reEvalTimer = null;
					reEvalDone = true;
					if (!disposed) reEvaluate(capturedCtx);
				}, 1000);
				return; // notification deferred to reEvaluate()
			}
			// reEvalDone === true: the retry already ran and still found no model;
			// fall through to the one-time notification block below.
		}

		// One-time "unavailable" notification when user opted in but no model found
		// (task 4.2).  Skipped when retry is still pending (handled above).
		if (currentModel === undefined && !notifiedThisProcess) {
			if (digestRequested(config, ctx.cwd)) {
				const cheapModels = ctx.modelRegistry
					.getAvailable()
					.filter((m) => typeof m.cost?.input === "number" && m.cost.input < 0.5)
					.map((m) => m.id)
					.slice(0, 8)
					.join(", ");
				ctx.ui.notify(
					`session-search: digest mode unavailable — none of [${AUTO_DETECT_MODELS.join(", ")}] are configured` +
						(cheapModels ? ` (available cheap models: ${cheapModels})` : "") +
						`. Running in hybrid-raw mode.`,
					"warning",
				);
				notifiedThisProcess = true;
			}
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		if (disposed) return;
		currentCtx = ctx;
		triggerDebounced();
	});

	pi.on("session_compact", (_event, ctx) => {
		if (disposed) return;
		currentCtx = ctx;
		triggerImmediate();
	});

	// ── Task 4.5.1 — mode re-evaluation ─────────────────────────────────────

	/**
	 * Re-evaluate whether digest-mode is available.
	 *
	 * Fires once, ~1 s after the first session_start that found no model.
	 * By then ctx.modelRegistry.getAvailable() should be fully populated.
	 *
	 * Outcomes:
	 *   model found + zero index entries  → switch index to digest-mode (case a)
	 *   model found + existing entries    → mark all dirty + clear embeddings (case b)
	 *   model still not found             → emit fallback notification, stay in current mode
	 */
	function reEvaluate(capturedCtx: ExtensionContext): void {
		if (disposed) return;

		const latestConfig = deps.configLoader();
		const retryModel = deps.modelResolver(
			latestConfig,
			capturedCtx.modelRegistry.getAvailable(),
		);

		if (retryModel !== undefined) {
			// Registry has populated — upgrade to digest-mode.
			currentModel = retryModel;
			config = latestConfig;

			const entryCount = deps.indexEntryCount?.() ?? 0;
			if (entryCount === 0) {
				// (a) Fresh install: no existing raw-content embeddings to clear.
				// Just switch the index mode so future addDigested calls use
				// digest.body as the embedding text.
				deps.switchIndexToDigestMode?.();
			} else {
				// (b) Existing hybrid-raw entries: clear embeddings so that the
				// task-6.11 filter excludes them from cosine scoring until digests
				// are available.  Never mix raw-content and digest-content vectors.
				const marked = deps.markAllDirtyAndClearEmbeddings?.() ?? 0;
				if (marked > 0) {
					capturedCtx.ui.notify(
						`session-search: upgraded to digest-mode; ${marked} entries cleared ` +
							`for re-embed (run /digest:backfill to re-populate).`,
						"info",
					);
				}
			}
		} else {
			// Registry still doesn’t have a matching model — emit the task-4.2
			// fallback notification and stay in the current mode.  Do not
			// re-evaluate again this process.
			if (!notifiedThisProcess) {
				const cheapModels = capturedCtx.modelRegistry
					.getAvailable()
					.filter((m) => typeof m.cost?.input === "number" && m.cost.input < 0.5)
					.map((m) => m.id)
					.slice(0, 8)
					.join(", ");
				capturedCtx.ui.notify(
					`session-search: digest mode unavailable — none of [${AUTO_DETECT_MODELS.join(", ")}] are configured` +
						(cheapModels ? ` (available cheap models: ${cheapModels})` : "") +
						`. Running in hybrid-raw mode.`,
					"warning",
				);
				notifiedThisProcess = true;
			}
		}
	}

	pi.on("session_shutdown", (_event, _ctx) => {
		if (disposed) return;

		// Abort any in-flight LLM call.
		if (currentAbort) {
			currentAbort.abort();
			currentAbort = null;
		}

		// Clear all timers (including the mode re-eval timer).
		clearHardTimeout();
		clearDebounceTimer();
		clearFollowUpTimer();
		clearReEvalTimer();

		// Clear dirty — no further work should be attempted.
		state.dirty = false;
		state.pendingCall = false;
	});

	// ── Dispose ───────────────────────────────────────────────────────────────

	function dispose(): void {
		if (disposed) return;
		disposed = true;

		if (currentAbort) {
			currentAbort.abort();
			currentAbort = null;
		}

		clearHardTimeout();
		clearDebounceTimer();
		clearFollowUpTimer();
		clearReEvalTimer();

		state.dirty = false;
	}

	// Expose lastError for debugging (optional — not in the primary contract)
	/**
	 * Public entry point for slash commands. Awaits any in-flight digest
	 * completion before issuing the new trigger; returns the resulting digest
	 * (or null on failure). The wait avoids /digest:update racing with the
	 * agent_end auto-trigger — simultaneous `complete()` calls cause the LLM
	 * provider to abort one mid-stream, returning a thinking-only response
	 * that fails JSON extraction.
	 */
	async function triggerNow(opts?: { forceFull?: boolean }): Promise<SessionDigest | null> {
		if (disposed) return null;

		// Wait for any in-flight call to complete (poll-based; pendingCall is
		// private to this module). Cap the wait at 90 s to avoid hanging the
		// slash command if something pathological is happening.
		const deadline = Date.now() + 90_000;
		while (state.pendingCall && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 200));
		}
		if (state.pendingCall) return null; // gave up waiting

		// For /digest:rewrite: zero out the anchor so buildPrompt picks full mode
		// regardless of accumulated delta. The threshold check is
		// `tokensSinceLastWrite >= threshold` which is true when convTokensAtLastWrite=0.
		if (opts?.forceFull) {
			state.convTokensAtLastWrite = 0;
			state.lastDigest = null;
		}

		// Snapshot the digest file path so we can read what was written.
		await fireDigest();

		// Re-read from disk so callers see the canonical persisted result.
		return sessionId ? deps.storage.loadDigest(sessionId) : null;
	}

	return {
		dispose,
		triggerNow,
		// Expose for testing
		get _lastError() {
			return lastError;
		},
	} as LifecycleHandle & { _lastError: string | null };
}

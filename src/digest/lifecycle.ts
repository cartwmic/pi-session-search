/**
 * Digest lifecycle wiring.
 *
 * Installs four event handlers on ExtensionAPI:
 *   session_start    → reload config + restore in-memory state from disk
 *   agent_end        → debounced digest trigger
 *   session_compact  → immediate digest trigger (bypass debounce)
 *   session_shutdown → abort in-flight call + cleanup
 *
 * Coalescing rule (4.8): if an AUTOMATIC trigger (agent_end / session_compact)
 * fires while pendingCall===true, set dirty=true instead of queueing. When the
 * in-flight call completes (either way), if dirty, schedule ONE follow-up after
 * 250ms tail delay and clear dirty.
 *
 * No liveness/wedge timeouts (constitution principle I): there is NO wall-clock
 * timer that aborts or gives up on a possibly-wedged in-flight call. Recovery is
 * caller-driven: a SLASH-COMMAND trigger (triggerNow) SUPERSEDES an in-flight
 * call by aborting it (currentAbort.abort() -> ac.signal -> SIGKILL) and firing
 * a fresh digest; lifecycle reapers (session_shutdown / deactivate / dispose)
 * abort on teardown. The AbortController + ac.signal threading are retained for
 * exactly these caller/reaper aborts. An aborted call is treated as a failure
 * (4.7): prior digest untouched, no setSessionName.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";

import type { SessionDigest } from "./schema";
import type { DigestConfig } from "./config";
import type { BuilderState } from "./builder";
import { emptyBuilderState } from "./builder";
import type { BuilderStateOnDisk } from "./storage";
import type { ConversationView } from "./conversation-view";
import { liveConversationView } from "./conversation-view";
import { log } from "../log";

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

	/**
	 * Returns true if the current generation is still active.
	 * Used to short-circuit async tails (debounce timer, post-LLM saveDigest,
	 * setSessionName, indexAddDigested) after a verdict transition or
	 * deactivation.
	 */
	/**
	 * Generation-token guard (task 6.7). When provided, post-LLM disk/UI
	 * mutations short-circuit if this returns false (a newer session_start
	 * has overtaken the deferred work). Optional for tests; the warm path
	 * always supplies one.
	 */
	isCurrentGeneration?: () => boolean;

	/**
	 * Called at the top of the lifecycle's session_start handler to capture
	 * the current bootGeneration.  The extension wires this to increment its
	 * own lifecycleGen counter so isCurrentGeneration can compare both values.
	 */
	onSessionStartCaptureGeneration?: () => void;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface LifecycleHandle {
	/**
	 * Warm-path teardown. Clears currentModel, debounce timers, pendingCall,
	 * and aborts any in-flight LLM call. Does NOT mark the handle permanently
	 * dead - the lifecycle's session_start handler can re-arm on the next
	 * event.  Used by verdict transitions (valid → misconfigured, valid →
	 * valid with different config).
	 */
	deactivate: () => void;

	/**
	 * Permanent teardown. Marks the handle as disposed so no future event
	 * handler runs. Called ONLY from session_shutdown.
	 */
	dispose: () => void;

	/**
	 * Force-trigger a digest now via the lifecycle's coalescing path.
	 * Returns a promise that resolves with the digest (or null on failure)
	 * once the in-flight + this trigger have settled.
	 *
	 * Use this from /digest:update and /digest:rewrite to avoid the slash
	 * command racing the auto-digest fired from `agent_end`. Both code paths
	 * share the same `pendingCall` mutex - the second arrival waits for the
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

	/** Follow-up timer for the 250ms coalescing tail delay (4.8). */
	let followUpTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Latest ExtensionContext - captured from event handlers so fire-and-forget
	 * async continuations can call ui.notify / sessionManager / etc.
	 */
	let currentCtx: ExtensionContext | null = null;

	/** Current merged config (refreshed on session_start). */
	let config: DigestConfig = deps.configLoader();

	// ── Helpers ──────────────────────────────────────────────────────────────

	function clearDebounceTimer(): void {
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	}

	function clearFollowUpTimer(): void {
		if (followUpTimer !== null) {
			clearTimeout(followUpTimer);
			followUpTimer = null;
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

		// Build the abort controller. The signal is threaded into generateDigest
		// so caller-driven supersession and lifecycle reapers can kill the call
		// (currentAbort.abort() -> ac.signal -> claude-bridge -> SIGKILL). There is
		// deliberately NO liveness/wedge timeout here (constitution principle I).
		const ac = new AbortController();
		currentAbort = ac;

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
			if (currentAbort === ac) currentAbort = null;
		}

		state.pendingCall = false;

		if (result !== null) {
			// ── 4.6 Success path ──────────────────────────────────────────────
			const { digest, anchor } = result;

			// Task 6.7: generation guard — short-circuit if stale
			if (deps.isCurrentGeneration && !deps.isCurrentGeneration()) {
				// Stale generation; do NOT save digest, setSessionName, or add to index.
				// The digest content is from an outdated session context.
				return;
			}

			deps.storage.saveDigest(id, digest);
			pi.setSessionName(digest.headline);

			// Headline-drift observability (opt-in). Records the previous and new
			// headline on every successful write so users can audit whether the
			// stickiness directive is holding without manual inspection.
			if (process.env.PI_SESSION_SEARCH_DEBUG_DIGEST) {
				const prevHeadline = state.lastDigest?.headline ?? null;
				if (prevHeadline !== null) {
					log.debug(
						{
							comp: "digest",
							sessionId: id,
							prevHeadline,
							newHeadline: digest.headline,
							changed: prevHeadline !== digest.headline,
						},
						"headline diff on incremental write",
					);
				}
			}

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
		if (!disposed && state.dirty && (!deps.isCurrentGeneration || deps.isCurrentGeneration())) {
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
			// Enough time since last write - fire immediately.
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

		deps.onSessionStartCaptureGeneration?.();

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

	pi.on("session_shutdown", (_event, _ctx) => {
		if (disposed) return;

		// Abort any in-flight LLM call.
		if (currentAbort) {
			currentAbort.abort();
			currentAbort = null;
		}

		// Clear scheduling timers.
		clearDebounceTimer();
		clearFollowUpTimer();

		// Clear dirty - no further work should be attempted.
		state.dirty = false;
		state.pendingCall = false;
	});

	// ── Warm-path deactivate ────────────────────────────────────────────────
	//
	// Clears the model, timers, and pendingCall so the lifecycle stops doing
	// work. Does NOT set disposed=true — a subsequent session_start can re-arm.
	// Called from the extension on verdict transitions.

	function deactivate(): void {
		// Abort any in-flight LLM call.
		if (currentAbort) {
			currentAbort.abort();
			currentAbort = null;
		}

		clearDebounceTimer();
		clearFollowUpTimer();

		// Clear model so event handlers no-op.
		currentModel = undefined;

		// Clear pending work.
		state.pendingCall = false;
		state.dirty = false;
	}

	// ── Permanent dispose ───────────────────────────────────────────────────
	//
	// Marks the handle permanently dead.  Called ONLY from session_shutdown.
	// Warm-path transitions use deactivate() instead.

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		deactivate();
	}

	// Expose lastError for debugging (optional - not in the primary contract)
	/**
	 * Public entry point for slash commands. SUPERSEDES any in-flight digest
	 * call instead of waiting on it: if a call is pending it is aborted
	 * (currentAbort.abort() -> ac.signal -> SIGKILL of the claude-p process
	 * group), the mutex is released, and a fresh digest is fired immediately.
	 * Returns the resulting digest (or null on failure).
	 *
	 * There is deliberately NO wall-clock wait/deadline here (constitution
	 * principle I): a stale or wedged in-flight call is KILLED, not awaited. The
	 * single-in-flight invariant is preserved because supersession clears
	 * `pendingCall` before fireDigest runs, so fireDigest's pendingCall guard
	 * does not coalesce this superseding call.
	 */
	async function triggerNow(opts?: { forceFull?: boolean }): Promise<SessionDigest | null> {
		if (disposed) return null;

		// Caller-driven supersession: kill any in-flight call and take the mutex.
		if (state.pendingCall) {
			currentAbort?.abort();
			currentAbort = null;
			state.pendingCall = false;
		}

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
		deactivate,
		dispose,
		triggerNow,
		// Expose for testing
		get _lastError() {
			return lastError;
		},
	} as LifecycleHandle & { _lastError: string | null };
}

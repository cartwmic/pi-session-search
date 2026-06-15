# pi-session-search Domain

<!--
Implicit invariants the agent does not know. These bound reachability for the
clarify artifact's inconsistency + completeness passes.
-->

**Version:** 1.0.0
**Last updated:** 2026-06-14

## Entities

- **SessionDigest** — the persisted summary of a pi session (headline, body,
  topics, cost, token count) produced by an LLM call.
- **Digest lifecycle** — the per-session state machine installed on the pi
  ExtensionAPI; reacts to `session_start`, `agent_end`, `session_compact`,
  `session_shutdown`.
- **In-flight call** — a single active `generateDigest`/`complete()` invocation,
  tracked by `state.pendingCall` and cancellable via `currentAbort`.
- **AbortController (`currentAbort`)** — the controller whose `signal` is threaded
  into the in-flight call; aborting it kills the underlying claude-p process group.
- **Reaper** — a lifecycle hook (`session_shutdown`, `deactivate`, `dispose`)
  that aborts the in-flight call during teardown/transition.
- **Supersession** — a newer digest trigger (e.g. `/digest:update`) aborting and
  replacing an in-flight call instead of waiting on it.
- **Coalescing/debounce** — functional scheduling: the 250ms follow-up tail and
  the configurable debounce window that batch rapid triggers.

## Invariants

1. At most one digest call is in flight per lifecycle at any instant
   (`state.pendingCall` is the mutex).
2. Aborting `currentAbort` propagates to the in-flight call via `ac.signal` and
   results in that call being treated as a failure (returns null).
3. A failed or aborted digest leaves the previously persisted digest unchanged
   and does not call `setSessionName`.
4. Liveness/wedge recovery comes only from caller-driven abort, supersession, or
   a lifecycle reaper — never from a wall-clock deadline.
5. Debounce and coalescing tail timers are scheduling-only; they never abort or
   give up on an in-flight call.
6. After abort, `currentAbort` is cleared and `state.pendingCall` returns to false.

## Units and conventions

- **Time**: timers in milliseconds; debounce config in seconds (converted ×1000).
- **IDs**: session ids are opaque strings from `sessionManager.getSessionId()`.
- **Naming**: camelCase in TS; kebab-case for capability folders and slash commands.
- **Failure signaling**: digest failure is represented as `null`, never a throw.

## Out-of-scope domains

- The claude-bridge / claude-p process management — this project is a consumer of
  the abort signal, not the implementer of SIGKILL.
- LLM tool-call formatting correctness — handled by builder.ts's single
  retry-with-stricter-prompt, out of scope for cancellation behavior.

## See also

- Constitution: `openspec/constitution.md`
- Schema docs: `~/.local/share/openspec/schemas/opsx-superpowers/README.md`

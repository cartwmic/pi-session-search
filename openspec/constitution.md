# pi-session-search Constitution

<!--
Immutable principles for the pi-session-search extension. Every opsx artifact
reads this file. Principles ≤10. Amend only via a dedicated Scale ≥ L change.
-->

**Version:** 1.0.0
**Ratified:** 2026-06-14
**Last updated:** 2026-06-14

## Core Principles

### I. No liveness/wedge timeouts
The extension MUST NOT use wall-clock timers whose purpose is to detect a
possibly-stuck (wedged) in-flight LLM call and abort or give up on it.
Recovery from a wedged call comes from caller-driven cancel/kill (abort),
supersession by a newer request, and lifecycle reapers — never from a
liveness deadline. Functional scheduling timers (debounce, coalescing tail
delays) are NOT liveness timeouts and are permitted.

**Rationale:** Wall-clock timeouts guess at liveness, fire on slow-but-healthy
calls, and hide the real control signal (the caller). Caller/supersession-driven
abort is deterministic and externally visible.
**Enforcement:** analyze check 1 (constitution compliance); spec ACs forbidding
deadline-based abort.

### II. Abort plumbing is sacred
The `AbortController` → `ac.signal` → `complete()` → claude-bridge → SIGKILL
path is verified end-to-end and MUST remain wired. Changes that remove
liveness timers MUST keep the AbortController, the signal threading into
`generateDigest`, and every lifecycle reaper that calls `currentAbort.abort()`.

**Rationale:** Abort is the sole recovery mechanism once timeouts are gone;
breaking it removes all in-flight cancellation.
**Enforcement:** specs require signal propagation + reaper aborts; tests assert
`ac.signal` reaches the builder and reapers abort.

### III. Graceful degradation over crashes
A failed or aborted digest MUST leave the prior persisted digest intact, skip
`setSessionName`, and return null. Digest failures never throw into the host
agent or corrupt on-disk state.

**Rationale:** The digest is a non-critical background enhancement; it must
never destabilize the user's session.
**Enforcement:** failure-path ACs; existing failure/abort tests.

### IV. Single in-flight digest call (mutex)
At most one digest `complete()` call is in flight per lifecycle at any time,
guarded by `state.pendingCall`. Concurrent triggers coalesce or supersede;
they never issue parallel `complete()` calls.

**Rationale:** Parallel calls cause the provider to silently abort one
mid-stream, producing thinking-only responses that fail extraction.
**Enforcement:** coalescing/supersession ACs; pendingCall guard tests.

### V. Behavior changes flow through specs
Every behavioral change MUST be expressed as an ADDED/MODIFIED/REMOVED
requirement in a capability spec before code changes land.

**Rationale:** Keeps the spec the source of truth and prevents drift.
**Enforcement:** analyze check 3 (AC↔design coverage); verify AC↔test mapping.

## Governance

- Amendments require a dedicated change with Scale ≥ L and
  adversarial-review-cycle invoked.
- This constitution is read before every artifact; violations are flagged by
  the analyze artifact's constitution check.
- Principles here override schema instructions and artifact prose on conflict.

## Versioning

- Major: a principle is removed or reversed.
- Minor: a principle is added.
- Patch: clarification, no semantic change.

## See also

- Schema activation: `~/.local/share/openspec/schemas/opsx-superpowers/README.md`
- Domain invariants: `openspec/domain.md`

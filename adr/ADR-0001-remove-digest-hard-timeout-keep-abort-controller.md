# ADR-0001: Remove digest hard timeout, keep AbortController

**Status:** Accepted
<!-- Status values: Proposed | Accepted | Deprecated | Superseded -->
**Date:** 2026-06-16
**Source change:** `openspec/changes/digest-caller-driven-cancel/`
**Supersedes:** N/A
**Superseded by:** N/A

## Context

`src/digest/lifecycle.ts` previously guarded each in-flight digest LLM call with a 60-second hard timeout that called `AbortController.abort()`. The same `AbortController` also carries legitimate caller and lifecycle-reaper cancellation: `/digest:update` or `/digest:rewrite` supersession, `session_shutdown`, `deactivate()`, and `dispose()`.

The OpenSpec constitution principle I forbids wall-clock liveness guesses for wedged digest calls. Domain invariant 2 requires the abort signal to propagate into `complete()` so the underlying process group can be killed when a real caller or reaper cancels work.

## Decision Drivers

- Avoid wall-clock liveness timers for possibly-wedged digest calls.
- Preserve deterministic caller/reaper cancellation through `AbortController`.
- Keep one digest LLM call in flight per session while retaining explicit recovery paths.
- Minimize lifecycle surface change; public `LifecycleHandle` behavior stays compatible.

## Considered Options

### Option A: Remove hard timeout, keep AbortController

Delete `hardTimeoutHandle`, `clearHardTimeout()`, and the `setTimeout(() => ac.abort(), 60_000)` call. Keep `currentAbort`, pass `ac.signal` into digest generation, and clear `currentAbort` in `finally` when it still points at the current controller.

**Pros:**
- Satisfies the no-liveness-timer constraint.
- Preserves caller-driven and reaper-driven cancellation.
- Removes only the wall-clock guess, not the control surface.

**Cons:**
- An automatic-triggered wedged digest will not self-heal until a caller supersedes it or a lifecycle reaper runs.

### Option B: Raise the timeout to a large value

Keep the hard timeout but make it less likely to fire during normal slow calls.

**Pros:**
- Retains an automatic self-heal path.

**Cons:**
- Still uses a liveness timer and violates constitution principle I.
- Any chosen duration remains guesswork.

### Option C: Remove AbortController entirely

Delete the hard timeout and all abort plumbing.

**Pros:**
- Removes the liveness timer.

**Cons:**
- Breaks shutdown/deactivate/dispose cancellation.
- Prevents slash-command supersession from killing the underlying call.
- Violates domain invariant 2.

## Decision Outcome

**Chosen option:** A

**Rationale:** The timer was the liveness guess; the `AbortController` is the cancellation control surface. Removing only the timer satisfies the constitution while preserving explicit caller and reaper aborts.

## Consequences

**Positive:**
- Healthy slow digest calls are no longer killed by an internal 60-second timer.
- Reapers and slash-command supersession can still abort in-flight work.

**Negative:**
- A wedged automatic digest can remain pending until a caller-driven supersession or lifecycle reaper occurs.

**Neutral:**
- Digest storage format and public lifecycle handle remain unchanged.

## Links

- Source design discussion: `openspec/changes/digest-caller-driven-cancel/design.md` (Decision D1)
- Related ADRs: ADR-0002
- External references: N/A

---

<!--
IMMUTABILITY RULE: once this ADR is Accepted, do not edit the body. To
change a decision, create a new ADR and mark this one Superseded with
Superseded-by link → new ADR.

MADR 4.0 short form — see https://adr.github.io/madr/
-->

# ADR-0002: Supersede digest slash commands without deadlines

**Status:** Accepted
<!-- Status values: Proposed | Accepted | Deprecated | Superseded -->
**Date:** 2026-06-16
**Source change:** `openspec/changes/digest-caller-driven-cancel/`
**Supersedes:** N/A
**Superseded by:** N/A

## Context

`triggerNow()` previously handled an in-flight digest call by polling for up to 90 seconds before giving up and returning `null`. That made `/digest:update` and `/digest:rewrite` depend on a wall-clock deadline when the caller's intent was immediate manual recovery.

OpenSpec constitution principle I rejects wall-clock liveness guesses. Domain invariant 1 allows only one digest LLM call in flight per session, and domain invariant 4 requires concurrency conflicts to be resolved by caller-driven strategies instead of deadlines.

## Decision Drivers

- Slash-command triggers must recover from stale or wedged digest work deterministically.
- The lifecycle must not wait on or give up by wall-clock deadline.
- The one-call-per-session mutex must be released before firing the superseding call.
- Abort propagation to `complete()` must remain the kill path for underlying work.

## Considered Options

### Option A: Abort, clear pendingCall, and fire immediately

When `triggerNow()` sees `pendingCall`, call `currentAbort?.abort()`, clear `currentAbort`, clear `pendingCall`, and then run the new digest immediately using the existing full/incremental selection path.

**Pros:**
- Caller intent maps directly to supersession.
- A wedged prior call is killed through the abort signal.
- No wall-clock deadline or polling loop remains.
- The mutex is released before the new digest fires.

**Cons:**
- The old call may settle after abort; the accepted race policy relies on the new call overwriting with a valid digest.

### Option B: Wait indefinitely for the in-flight promise

Expose or store the current promise and await it before starting a new digest.

**Pros:**
- Avoids overlap between old-call settlement and new-call persistence.

**Cons:**
- A wedged call hangs the slash command forever.
- No current exposed promise handle exists.
- Does not provide manual recovery.

### Option C: Use a shorter deadline

Replace the 90-second poll with a shorter cap before giving up or aborting.

**Pros:**
- Reduces worst-case wait.

**Cons:**
- Still uses a wall-clock liveness timer.
- Still guesses about external model/provider latency.

## Decision Outcome

**Chosen option:** A

**Rationale:** Supersession is caller-driven, deterministic, and uses the existing abort propagation path. It satisfies the one-call-per-session invariant by clearing `pendingCall` before the new digest starts, without introducing any deadline.

## Consequences

**Positive:**
- `/digest:update` and `/digest:rewrite` can recover from a wedged in-flight digest without waiting on a timer.
- Process-group kill remains observable through the abort signal path.
- Future lifecycle changes have a clear distinction: automatic triggers coalesce; slash commands supersede.

**Negative:**
- A superseded call can still race to settle after abort; this is accepted because both persisted digests are valid and the new call overwrites.

**Neutral:**
- Debounce and follow-up timers remain as scheduling timers, not liveness timers.

## Links

- Source design discussion: `openspec/changes/digest-caller-driven-cancel/design.md` (Decision D2)
- Related ADRs: ADR-0001
- External references: N/A

---

<!--
IMMUTABILITY RULE: once this ADR is Accepted, do not edit the body. To
change a decision, create a new ADR and mark this one Superseded with
Superseded-by link → new ADR.

MADR 4.0 short form — see https://adr.github.io/madr/
-->

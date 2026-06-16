## Context

`src/digest/lifecycle.ts` installs the per-session digest state machine. Today
two wall-clock **wedge timeouts** guard in-flight LLM calls:

1. **60s hard timeout** (`fireDigest`, ~line 230):
   `const timeout = setTimeout(() => ac.abort(), 60_000)`, tracked by
   `hardTimeoutHandle` and torn down by `clearHardTimeout()`. On fire it aborts
   the call, which the failure path treats as null.
2. **90s deadline poll** (`triggerNow`, ~line 478):
   `const deadline = Date.now() + 90_000; while (state.pendingCall && Date.now()
   < deadline) { await sleep(200) }`, followed by `if (state.pendingCall) return
   null` (give up).

The abort plumbing (`AbortController` → `ac.signal` → `complete()` →
claude-bridge → SIGKILL) is verified end-to-end (constitution principle II).
Three reapers already abort on teardown: `session_shutdown` (~:410),
`deactivate()` (~:434), `dispose()` (~:458). The `agent_end` coalescing path
(`fireDigest` ~:220: `if (pendingCall) { dirty = true; return }`) and the 250ms
`followUpTimer` / `debounceTimer` are functional scheduling, not wedge timers.

This design removes only the two wedge timeouts and replaces the `triggerNow`
wait with caller-driven supersession, per constitution principle I.

## Goals / Non-Goals

**Goals:**
- Remove the 60s hard timeout and its `hardTimeoutHandle` / `clearHardTimeout`.
- Remove the 90s deadline poll + give-up in `triggerNow`; replace with
  supersession (abort in-flight, clear `pendingCall`, fire new).
- Keep `AbortController` / `currentAbort` / `ac.signal` threading intact.
- Keep all three reapers and the coalescing/debounce scheduling timers.

**Non-Goals:**
- Removing the AbortController or any abort wiring (principle II).
- Touching `builder.ts`'s retry-with-stricter-prompt (tool-call formatting, not
  a wedge; out of scope).
- Adding generation bookkeeping for the abort/settle race (clarify C1 = accept).
- Any change to debounce/coalescing UX scheduling (principle I permits them).

## Decisions

### D1: Remove the 60s hard timeout, keep the AbortController

**Choice:** Delete `hardTimeoutHandle`, `clearHardTimeout()`, and the
`setTimeout(() => ac.abort(), 60_000)` line. Keep `const ac = new
AbortController(); currentAbort = ac;` and the `ac.signal` passed into
`generateDigest`. In the `finally`, drop `clearHardTimeout()` but keep
`if (currentAbort === ac) currentAbort = null`.

**Alternatives considered:**
- **Raise the timeout to a large value:** still a liveness timer; violates
  principle I. Rejected.
- **Remove the AbortController entirely:** breaks reapers + supersession, which
  are the only remaining recovery path. Rejected (principle II).

**Rationale:** The signal is the control surface; the timer was the only
liveness guess. Removing just the timer satisfies principle I while preserving
caller/reaper aborts.

**4-point test:** multiple-approaches=Y, lasting=Y, disagreement=N,
future-constraint=Y → 3/4 → ADR candidate flagged (see analyze check 4). At
Scale M an ADR is optional; tracked, not mandatory.

### D2: Replace the 90s deadline poll in `triggerNow` with supersession

**Choice:** Replace
```
const deadline = Date.now() + 90_000;
while (state.pendingCall && Date.now() < deadline) { await sleep(200); }
if (state.pendingCall) return null;
```
with
```
if (state.pendingCall) {
  currentAbort?.abort();
  currentAbort = null;
  state.pendingCall = false;
}
```
then proceed to the existing `forceFull` handling and `await fireDigest()`.
Clearing `pendingCall` frees the mutex (invariant 1) so `fireDigest`'s
`if (pendingCall)` guard does not coalesce the superseding call.

**Alternatives considered:**
- **Keep waiting but with no cap (await the in-flight promise):** there is no
  exposed promise handle, and an unbounded wait on a wedged call hangs the
  slash command forever. Rejected.
- **Shorter deadline:** still a timeout; principle I. Rejected.

**Rationale:** `/digest:update` must KILL a stale/wedged call, not wait on it.
Supersession is deterministic and externally visible (the SIGKILL shows up in
process logs). Matches clarify A1 (fire right after abort, don't block on
teardown).

**4-point test:** multiple-approaches=Y, lasting=Y, disagreement=Y,
future-constraint=Y → 4/4 → ADR candidate (flagged in analyze check 4).

### D3: Classification of every src/digest timer (audit)

**Choice:** Audit result — only two timers are wedge/liveness timers; the rest
are functional scheduling and are KEPT.

| Timer | Location | Purpose | Verdict |
|---|---|---|---|
| `setTimeout(() => ac.abort(), 60_000)` | lifecycle.ts:230 | abort possibly-wedged call | **REMOVE (wedge)** |
| 90s `deadline` poll + give-up | lifecycle.ts:478–482 | wait/give-up on in-flight call | **REMOVE (wedge)** |
| `debounceTimer` (`debounceMs - elapsed`) | lifecycle.ts:344 | debounce agent_end | KEEP (scheduling) |
| `followUpTimer` (250ms) | lifecycle.ts:314 | coalescing tail | KEEP (scheduling) |
| `builder.ts` retry-with-stricter-prompt | builder.ts | tool-call formatting | KEEP (not a timer/wedge) |

**Rationale:** principle I forbids only liveness/wedge timers; debounce and
coalescing tails are UX scheduling (invariant 5).

**4-point test:** multiple-approaches=N → not an ADR candidate (documentation
of the audit).

## Risks / Trade-offs

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | A wedged `agent_end`-triggered digest never self-heals without supersession/reaper | Medium | Low | Documented behavioral envelope (clarify C3, proposal Impact). User recovers via `/digest:update`; reapers fire on shutdown/transition. |
| R2 | Abort/settle race: old call's success persists momentarily before supersession overwrites | Low | Low | Accept (clarify C1). Both writes are valid digests (invariant 3); new call overwrites. |
| R3 | Removing `clearHardTimeout()` leaves a dangling reference if missed in a reaper | Low | Medium | Remove all 3 `clearHardTimeout()` call sites (fireDigest finally, session_shutdown, deactivate) + the declaration; typecheck catches stragglers. |

## Migration Plan

No data migration. Code-only. Rollback = revert the lifecycle.ts diff; the spec
delta is archived separately. Compat: public `LifecycleHandle` surface
(`deactivate`, `dispose`, `triggerNow`) is unchanged; only internal timing
behavior changes.

## Open Questions

- (none — all clarify findings resolved; design is fully determined by the
  pre-approved direction.)

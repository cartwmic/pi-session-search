# Clarify Findings

<!--
Three passes over the delta ACs in specs/session-digest/spec.md. Delta scope
(2 requirements). Ground truth: openspec/domain.md invariants 1–6. Every
finding resolved autonomously per the pre-approved design.
-->

## Pass 1 — Ambiguity (semantic-entropy lite)

| # | AC ref | Question | Option A (keep) | Option B (change) | Status | Resolution |
|---|---|---|---|---|---|---|
| A1 | session-digest.digest-lifecycle-triggers | "abort the in-flight call … then fire the new digest immediately" — does "immediately" mean fire synchronously right after calling `abort()` (not awaiting process death), or block until the aborted process is confirmed dead? | Fire right after calling `currentAbort.abort()` + clearing `pendingCall`; do not block on process teardown | Block the new call until the killed process group is confirmed reaped | answered | **A** — abort() + clear `pendingCall` synchronously, then fire. SIGKILL propagation is async but the mutex (invariant 1) is freed the instant `pendingCall` is cleared, so the new call may proceed. Blocking on process death would reintroduce a wait/deadline (violates principle I). |
| A2 | session-digest.caller-driven-cancellation-without-liveness-timeouts | "treat that call as a failure" — is an aborted call distinguishable from a malformed-output failure in observable behavior? | Both abort and malformed-output collapse to the same null/failure path (no setSessionName, prior digest intact) | Abort gets a distinct error code / branch | answered | **A** — both collapse to the existing null failure path (invariant 3). No new error taxonomy; `generateDigest` returning null is the single failure signal, matching constitution principle III. |

## Pass 2 — Inconsistency (pairwise antecedent overlap)

| # | AC pair | Shared antecedent | Conflict on output | Option A (keep both) | Option B (resolve) | Status | Resolution |
|---|---|---|---|---|---|---|---|
| I1 | (Coalescing branch, Supersession branch) of session-digest.digest-lifecycle-triggers | "a trigger fires WHILE `pendingCall` is true" can hold for both branches simultaneously in wall-clock terms | Coalescing marks dirty + returns; Supersession aborts + fires. If undifferentiated, the same pending state would demand two opposite consequents | Keep both, differentiated by **trigger source**: automatic (`agent_end`/`session_compact`) → coalesce; slash-command (`/digest:update`/`/digest:rewrite`) → supersede | Collapse to a single strategy for all triggers | answered | **A** — the antecedents are NOT actually simultaneous for a single trigger: each trigger has exactly one source, so exactly one branch applies. The spec already partitions on source. No code conflict: `triggerNow` (slash path) performs supersession before reaching `fireDigest`, whose `pendingCall` guard handles the automatic path. |

## Pass 3 — Completeness (event/state combination enumeration)

Events: `agent_end`, `session_compact`, `/digest:update`, `/digest:rewrite`, `session_shutdown`, `deactivate`, `dispose`. States: `idle` (no in-flight call), `pending` (in-flight call).

| # | Combination | Question | Option A (intentional silence) | Option B (add new AC) | Status | Resolution |
|---|---|---|---|---|---|---|
| C1 | slash-command × `pending` where the in-flight call resolves *between* `abort()` and the new call starting (abort/settle race) | What digest is observed if the old call already produced a result mid-supersession? | Accept as undefined-but-safe: the new call wins the mutex; a stale prior result may persist then be overwritten by the new write | Add an AC mandating discard of any result from an aborted call | answered | **A** — accept as safe. Worst case the old call's success persists momentarily and is overwritten by the superseding call; both are valid digests (invariant 3 preserves integrity). Adding a discard-tracking AC would reintroduce generation bookkeeping not required by the design. Covered indirectly by the existing generation guard. |
| C2 | `deactivate` / `dispose` × `pending` | Is reaper-driven abort during a warm transition (not shutdown) specified? | — | Add explicit reaper coverage for `deactivate`/`dispose` | answered | **B (already drafted)** — the ADDED requirement's reaper clause names all three reapers (`session_shutdown`, `deactivate()`, `dispose()`). Combination is covered; no new AC needed beyond what is written. |
| C3 | `agent_end` × `pending` after a wedged call (never returns) | Does the spec acknowledge that a wedged automatic digest does NOT self-heal without supersession/reaper? | Accept: documented behavioral envelope — wedged auto-digest heals only via manual `/digest:update` or a reaper | Add a timeout to auto-heal | answered | **A** — this is the intended "no timeouts, reactive" behavior (principle I). Captured in proposal Impact and the ADDED requirement. Adding auto-heal would reintroduce a wedge timeout. |

## Outstanding (status != answered)

- (none — all findings answered)

## Summary

- Pass 1 findings: 2; unanswered: 0; deferred: 0
- Pass 2 findings: 1; unanswered: 0; deferred: 0
- Pass 3 findings: 3; unanswered: 0; deferred: 0
- **Gate status:** READY for design

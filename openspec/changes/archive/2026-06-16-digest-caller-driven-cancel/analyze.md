# Analyze Findings

<!-- READ-ONLY cross-check. Severity: blocker | major | minor. -->

**Mode:** single-model (Scale M; adversarial-review-cycle reserved for Scale ≥ L)
**Generated:** 2026-06-14 by worker (claude)

## Check 1 — Constitution compliance

| Principle | Status | Rationale | Severity |
|---|---|---|---|
| I. No liveness/wedge timeouts | compliant | Change removes the only two wedge timers (60s hard timeout, 90s deadline poll) and keeps only scheduling timers; design D3 audits all of src/digest. | — |
| II. Abort plumbing is sacred | compliant | AbortController, `currentAbort`, `ac.signal` threading, and all three reapers explicitly retained (design D1, Non-Goals). | — |
| III. Graceful degradation over crashes | compliant | Aborted call still collapses to null failure path; prior digest preserved; no throw (clarify A2, spec ADDED req). | — |
| IV. Single in-flight digest call (mutex) | compliant | Supersession clears `pendingCall` before firing; coalescing guard unchanged; no parallel `complete()`. | — |
| V. Behavior changes flow through specs | compliant | Behavioral change captured in MODIFIED + ADDED requirements before code. | — |

## Check 2 — EARS pattern check (major, human-triage)

Regex `/WHEN\s+[^.]*\b(error|fail|invalid|reject|deny|unauthor)/i` over the delta spec:

| # | File:line | AC | True positive? | Suggested rewrite | Status |
|---|---|---|---|---|---|
| E1 | specs/session-digest/spec.md (Scenario "Slash command kills a wedged in-flight call") | "WHEN a previous digest call is wedged (never returning)" | no | "wedged" matches no error keyword; "never returning" is a precondition, not an unwanted-condition antecedent. Scenario describes the nominal supersession trigger, correctly using WHEN. | n/a |
| E2 | specs/session-digest/spec.md (Scenario "Caller abort is treated as failure") | "the result is null … setSessionName is not called" | no | "failure" appears in the THEN/outcome describing the documented null path, not in a WHEN antecedent. The triggering condition (abort invoked) is a nominal caller action. | n/a |

No true positives. The only IF…THEN-worthy condition (malformed output) lives in the unchanged `Tool-call digest delivery` requirement, out of this delta.

## Check 3 — AC↔design coverage

| AC ID | Design section reference | Status | Severity |
|---|---|---|---|
| session-digest.digest-lifecycle-triggers | D2 (supersession), D3 (kept scheduling timers) | covered | — |
| session-digest.caller-driven-cancellation-without-liveness-timeouts | D1 (remove 60s, keep AC), D2 (remove 90s poll), D3 (audit table) | covered | — |

## Check 4 — design↔ADR promotion candidates (Scale ≥ L)

Scale is M, so ADR promotion is NOT mandatory; candidates flagged for visibility.

| Decision | 4-point score | ADR-candidate? | Rationale or "ADR not warranted because…" |
|---|---|---|---|
| D1 Remove 60s hard timeout | 3/4 | yes (optional at M) | Lasting + future-constraining; low disagreement. Offer promotion at archive. |
| D2 Replace 90s poll with supersession | 4/4 | yes (optional at M) | Reasonable engineers could prefer bounded-wait; the no-timeout principle settles it. Strongest ADR candidate. |
| D3 Timer audit | 0/4 | no | Documentation of an audit, single viable outcome. |

## Check 5 — Duplicate detection

| # | Locations | Restated constraint | Action |
|---|---|---|---|
| Dup1 | spec ADDED req (reaper clause) + MODIFIED req (supersession clause) | Both reference aborting `currentAbort` while pending | differentiate — MODIFIED governs slash-command supersession (caller); ADDED governs reaper teardown. Distinct triggers; intentional, not a true duplicate. |

## Check 6 — Implementation language in specs

| # | AC ID | Tech mentioned | Rewrite suggestion |
|---|---|---|---|
| Imp1 | both delta ACs | `currentAbort`, `pendingCall`, `ac.signal`, `generateDigest`, `setSessionName` | minor — accepted. Spec Level is spec-anchored; these are the agreed control-surface anchors named in the constitution/domain (invariants 1–6) and the pre-approved design. They make the ACs testable against the actual mechanism. Not rewritten. |

## Check 7 — Unresolved clarify findings

| # | clarify.md ref | Status | Risk |
|---|---|---|---|
| U1 | A1, A2, I1, C1, C2, C3 | all answered | none — gate READY |

## Outstanding risks

- R1 (design): wedged auto-digest self-heals only via supersession/reaper —
  intended envelope, not a defect. Track in verify.
- Imp1 (minor): implementation identifiers in specs accepted under spec-anchored.

## Summary

- Blockers: 0
- Major findings: 0
- Minor findings: 1 (Imp1 — accepted, implementation anchors in spec)
- **Gate status:** READY for tasks

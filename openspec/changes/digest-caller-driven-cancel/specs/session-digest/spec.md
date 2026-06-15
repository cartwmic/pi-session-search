# Capability: session-digest

<!-- Delta for change digest-caller-driven-cancel. Operates on the delta only;
unchanged requirements are not restated. Cites domain.md invariants 1–6. -->

## MODIFIED Requirements

### Requirement: Digest lifecycle triggers

The system SHALL trigger digest updates on the following events:

- `agent_end` — debounced by `debounceSeconds` (default `60`) per session.
- `session_compact` — immediate (no debounce); the compaction event materially changes the conversation shape.
- The `/digest:update` slash command — immediate, bypassing debounce.
- The `/digest:rewrite` slash command — immediate, forcing full re-summarize regardless of threshold.
- The `/digest:backfill` slash command — processes all sessions without a current digest, sequentially.

The lifecycle SHALL NOT trigger automatic digest updates on `session_start`. Backfill of historical sessions is opt-in via `/digest:backfill` only.

Only one digest LLM call may be in flight per session at a time (domain invariant 1). Concurrency between triggers SHALL be resolved by one of two caller-driven strategies, and never by a wall-clock deadline (domain invariant 4):

- **Coalescing (automatic triggers):** WHEN an `agent_end` or `session_compact` trigger fires WHILE a digest call is in flight, THE system SHALL mark the lifecycle dirty and return without issuing a parallel call; when the in-flight call settles, exactly one follow-up SHALL be scheduled after the coalescing tail delay if dirty (the most recent trigger wins; intermediate triggers discarded).
- **Supersession (slash-command triggers):** WHEN a `/digest:update` or `/digest:rewrite` trigger fires WHILE a digest call is in flight, THE system SHALL abort the in-flight call via `currentAbort`, clear `pendingCall`, and then fire the new digest immediately — it SHALL NOT wait on the in-flight call.

#### Scenario: Debounce prevents rapid-fire LLM calls

- **WHEN** two `agent_end` events fire 30 seconds apart for the same session
- **AND** `debounceSeconds` is `60`
- **THEN** the second event does not trigger an LLM call
- **AND** no digest is written for the second event

#### Scenario: session_compact bypasses debounce

- **WHEN** an `agent_end` fires at t=0 (digest written) and a `session_compact` fires at t=10s
- **THEN** the compaction triggers an immediate digest LLM call despite `debounceSeconds` not having elapsed

#### Scenario: No automatic backfill on startup

- **WHEN** the extension loads on `session_start` with `reason: "startup"`
- **AND** the index contains 100 sessions without digests
- **THEN** no digest LLM calls are made
- **AND** the user must invoke `/digest:backfill` to digest those sessions

#### Scenario: Automatic trigger while pending coalesces

- **WHEN** an `agent_end` trigger fires WHILE `pendingCall` is true
- **THEN** the lifecycle is marked dirty and no parallel `complete()` call is issued
- **AND** when the in-flight call settles, exactly one follow-up digest is scheduled

#### Scenario: Slash command supersedes an in-flight call

- **WHEN** a digest call is in flight (`pendingCall` is true)
- **AND** the user invokes `/digest:update`
- **THEN** the in-flight call's `currentAbort` is aborted and `pendingCall` is cleared
- **AND** a new digest call is fired immediately without waiting on a deadline
- **AND** the persisted digest returned reflects the new call

#### Scenario: Slash command kills a wedged in-flight call

- **WHEN** a previous digest call is wedged (never returning) with `pendingCall` true
- **AND** the user invokes `/digest:update`
- **THEN** the wedged call is aborted via `currentAbort` (killing the underlying process group)
- **AND** the new digest proceeds instead of the command hanging on a timer

## ADDED Requirements

### Requirement: Caller-driven cancellation without liveness timeouts

The system SHALL NOT use any wall-clock timer whose purpose is to detect a possibly-wedged in-flight digest call and abort or give up on it (constitution principle I; domain invariant 4). Recovery from a wedged call SHALL come only from caller-driven abort, supersession, or a lifecycle reaper.

THE system SHALL thread the in-flight call's `AbortController` signal (`ac.signal`) into `generateDigest` so that aborting `currentAbort` propagates to the underlying `complete()` call and kills its process group (domain invariant 2; constitution principle II).

WHEN `currentAbort` is aborted for an in-flight call, THE system SHALL treat that call as a failure: it SHALL leave the previously persisted digest unchanged, SHALL NOT call `setSessionName`, and SHALL clear `currentAbort` and `pendingCall` (domain invariants 2, 3, 6).

WHEN any lifecycle reaper runs — `session_shutdown`, `deactivate()`, or `dispose()` — WHILE a digest call is in flight, THE system SHALL abort `currentAbort` and clear `pendingCall`.

Functional debounce and coalescing tail-delay timers are scheduling-only and SHALL remain; they SHALL NOT abort or give up on an in-flight call (domain invariant 5).

#### Scenario: No wedge timeout aborts a healthy slow call

- **WHEN** a digest `complete()` call runs longer than any previous hard-timeout window (e.g. 60s) but is still streaming
- **THEN** no internal timer aborts the call
- **AND** the call completes normally and its digest is persisted

#### Scenario: Caller abort is treated as failure

- **WHEN** `currentAbort.abort()` is invoked for an in-flight digest call
- **THEN** `generateDigest` observes the aborted signal and the result is null
- **AND** `setSessionName` is not called and the prior persisted digest is preserved
- **AND** `pendingCall` is cleared

#### Scenario: Shutdown reaper aborts in-flight call

- **WHEN** `session_shutdown` fires WHILE a digest call is in flight
- **THEN** `currentAbort` is aborted (the signal becomes `aborted`)
- **AND** `pendingCall` is cleared and no further digest work is attempted

#### Scenario: Debounce timer is not a wedge timeout

- **WHEN** an `agent_end` fires within the debounce window
- **THEN** a scheduling timer is set for the remaining window
- **AND** that timer only fires the next digest; it never aborts an in-flight call

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| session-digest.digest-lifecycle-triggers | [x] | [x] | [x] | [x] | [x] |
| session-digest.caller-driven-cancellation-without-liveness-timeouts | [x] | [x] | [x] | [x] | [x] |

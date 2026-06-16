## Why

The digest lifecycle currently relies on wall-clock **wedge timeouts** (a 60s
`AbortController` deadline per call, and a 90s deadline poll loop in
`triggerNow`) to recover when an LLM call stalls. This violates constitution
principle I (No liveness/wedge timeouts): timeouts guess at liveness, fire on
slow-but-healthy calls, and mask the real control signal. The abort plumbing
(principle II) is verified end-to-end in production, so wedge recovery should
come from caller-driven cancel + supersession + reapers instead.

## What Changes

- Remove the 60s hard timeout that wraps every digest LLM call
  (`setTimeout(() => ac.abort(), 60_000)`) and its `hardTimeoutHandle` /
  `clearHardTimeout` machinery. Keep the `AbortController`, `currentAbort`, and
  `ac.signal` threaded into `generateDigest` (reapers still need them).
- Remove the 90s deadline poll loop in `triggerNow` and its "give up" branch.
  **BREAKING (behavioral):** `/digest:update` and `/digest:rewrite` no longer
  wait on an in-flight call. Instead they **supersede** it: abort the in-flight
  call, clear `pendingCall`, then fire the new digest immediately.
- Keep the three non-timeout reapers (`session_shutdown`, `deactivate`,
  `dispose`) that call `currentAbort.abort()`.
- Keep the `agent_end` coalescing path (mark dirty + return) and all functional
  debounce/coalescing scheduling timers — these are UX scheduling, not wedge
  handling, and are explicitly permitted by principle I.
- No change to `builder.ts`'s single retry-with-stricter-prompt (tool-call
  formatting, not a wedge; already returns null on failure).

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `session-digest`: the "Digest lifecycle triggers" requirement gains explicit
  caller-driven supersession semantics for slash-command triggers, and a new
  requirement forbids liveness/wedge timeouts and mandates abort/supersession/
  reaper-based recovery.

## Impact

- **Affected files:**
  - `src/digest/lifecycle.ts` — remove hard timeout + deadline poll; add
    supersession in `triggerNow`.
  - `src/__tests__/digest/lifecycle.test.ts` — replace the "hard timeout fires
    after 60s" test with a caller-driven-abort-as-failure test; add a
    `triggerNow` supersession test; assert abort still propagates via
    `ac.signal`.
  - `openspec/specs/session-digest/spec.md` — delta applied at archive.
- **Dependencies/systems:** none. The AbortController → claude-bridge → SIGKILL
  path is unchanged.
- **Behavioral envelope:** post-change, a wedged `agent_end`-triggered digest
  self-heals only on supersession (manual `/digest:update`) or a lifecycle
  reaper — the intended "no timeouts, reactive" behavior (principle I).

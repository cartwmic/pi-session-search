## 1. Remove the 60s hard timeout (wedge)

- [x] 1.1 Delete the `hardTimeoutHandle` field declaration and its doc comment, the `clearHardTimeout()` helper, and the `setTimeout(() => ac.abort(), 60_000)` line + `hardTimeoutHandle = timeout` assignment in `fireDigest`. Remove every `clearHardTimeout()` call site (fireDigest `finally`, `session_shutdown`, `deactivate`). Keep `const ac = new AbortController()`, `currentAbort = ac`, the `ac.signal` passed to `generateDigest`, and `if (currentAbort === ac) currentAbort = null`.
  - intent: refactor
  - files_allowed:
      - src/digest/lifecycle.ts
  - allow_new_files: false
- [x] 1.2 Update the file header doc comment that describes "Hard timeout (4.9): a 60-second AbortController…" to describe caller-driven cancel / supersession / reapers instead.
  - intent: refactor
  - files_allowed:
      - src/digest/lifecycle.ts
  - allow_new_files: false

## 2. Replace the 90s deadline poll with supersession (wedge → caller-driven)

- [x] 2.1 In `triggerNow`, delete the `const deadline = Date.now() + 90_000; while (state.pendingCall && Date.now() < deadline) { await sleep(200) }` loop and the `if (state.pendingCall) return null` give-up. Replace with supersession: if `state.pendingCall`, call `currentAbort?.abort()`, set `currentAbort = null`, set `state.pendingCall = false`; then proceed to the existing `forceFull` handling and `await fireDigest()`. Update the method doc comment (which currently says it "Awaits any in-flight digest completion") to describe supersession.
  - intent: refactor
  - files_allowed:
      - src/digest/lifecycle.ts
  - allow_new_files: false

## 3. Update + add tests

- [x] 3.1 Update the existing "hard timeout: AbortController fires after 60s …" test in lifecycle.test.ts to reflect that there is no internal timeout: reframe it as a caller-driven abort test (manual `currentAbort` / signal abort is treated as failure — no setSessionName, prior digest preserved). Cite AC `session-digest.caller-driven-cancellation-without-liveness-timeouts`. Update the file-header comment that lists "hard timeout (60s) treated as failure".
  - intent: feature
  - files_allowed:
      - src/__tests__/digest/lifecycle.test.ts
  - allow_new_files: false
- [x] 3.2 Add a test: `triggerNow` supersedes an in-flight `pendingCall` — given a never-resolving in-flight call, calling `triggerNow()` aborts the first call's signal and fires a new digest that completes and is persisted (no 90s wait). Cite AC `session-digest.digest-lifecycle-triggers`.
  - intent: feature
  - files_allowed:
      - src/__tests__/digest/lifecycle.test.ts
  - allow_new_files: false
- [x] 3.3 Add (or strengthen) a test asserting `ac.signal` is propagated into `generateDigest` and that a reaper (`session_shutdown`) still aborts it. Cite AC `session-digest.caller-driven-cancellation-without-liveness-timeouts`. (May reuse the existing shutdown-abort test; ensure the AC ID appears.)
  - intent: feature
  - files_allowed:
      - src/__tests__/digest/lifecycle.test.ts
  - allow_new_files: false

## 4. Validate

- [x] 4.1 Run `npm test` (runs `test:lint-modes` + node --test over all `*.test.ts`). Iterate until all tests pass. Quote final output.
  - intent: refactor
  - files_allowed:
      - src/digest/lifecycle.ts
      - src/__tests__/digest/lifecycle.test.ts
  - allow_new_files: false

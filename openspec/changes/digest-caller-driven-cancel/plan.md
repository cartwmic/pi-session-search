# Execution Plan

<!-- Execution Mode = tdd-preferred. Validator = `npm test`. -->

## Plan step 1: Remove the 60s hard timeout

- **Covers:** T1.1, T1.2
- **Pre-conditions:**
  - Baseline `npm test` green (308 tests).
  - `src/digest/lifecycle.ts` read; lines ~166–207 (declarations + helpers),
    ~228–252 (fireDigest abort setup/finally), ~410–442 (reapers).
- **Action:**
  1. Remove `hardTimeoutHandle` declaration + doc comment (~:171–172).
  2. Remove `clearHardTimeout()` helper (~:202–207).
  3. In `fireDigest`: remove `const timeout = setTimeout(() => ac.abort(),
     60_000)` and `hardTimeoutHandle = timeout`; keep `ac` + `currentAbort = ac`.
  4. In `fireDigest` `finally`: remove `clearHardTimeout()`; keep
     `if (currentAbort === ac) currentAbort = null`.
  5. Remove `clearHardTimeout()` from `session_shutdown` and `deactivate`.
  6. Rewrite the file-header "Hard timeout (4.9)" comment block.
- **Verification:** `npm test` (no test should reference `hardTimeout`).
- **Rollback:** `git checkout -- src/digest/lifecycle.ts`.

## Plan step 2: Supersession in triggerNow

- **Covers:** T2.1
- **Pre-conditions:** Step 1 applied; `triggerNow` at ~:472–497 read.
- **Action:**
  1. Delete the `deadline` poll loop + `if (state.pendingCall) return null`.
  2. Insert supersession block: `if (state.pendingCall) { currentAbort?.abort();
     currentAbort = null; state.pendingCall = false; }`.
  3. Keep the `forceFull` block and `await fireDigest()` + final `loadDigest`.
  4. Update the `triggerNow` doc comment to describe supersession (kill, don't
     wait).
- **Verification:** `npm test`.
- **Rollback:** `git checkout -- src/digest/lifecycle.ts`.

## Plan step 3: Tests (TDD-preferred)

- **Covers:** T3.1, T3.2, T3.3
- **Pre-conditions:** Steps 1–2 applied.
- **Action (5-step micro-tasks):**
  1. Write/adjust failing test for supersession in `triggerNow` (cites AC
     `session-digest.digest-lifecycle-triggers`).
  2. Run `npm test` → expect the new supersession test to pass against the new
     code (and confirm the old 60s test, if unmodified, would now mislead).
  3. Reframe the 60s timeout test → caller-driven-abort-as-failure (cites AC
     `session-digest.caller-driven-cancellation-without-liveness-timeouts`);
     ensure shutdown-abort test carries the AC ID.
  4. Run `npm test` → expect PASS (all suites).
  5. Commit code + tests together (`refactor(digest): …`).
- **Verification:** `npm test` → 0 failures; grep both canonical AC IDs present
  in the test file.
- **Rollback:** `git checkout -- src/__tests__/digest/lifecycle.test.ts`.

## Plan step 4: Validate + commit

- **Covers:** T4.1
- **Pre-conditions:** Steps 1–3 applied.
- **Action:** Run `npm test`; quote output. Commit openspec artifacts first
  (docs commit), then code+tests (refactor commit).
- **Verification:** `npm test` exits 0.
- **Rollback:** revert the two commits.

## Completion Verification

- `npm test` → `pass <N>`, `fail 0`.
- `grep -c "session-digest.caller-driven-cancellation-without-liveness-timeouts\|session-digest.digest-lifecycle-triggers" src/__tests__/digest/lifecycle.test.ts` → ≥ 2.
- `grep -n "60_000\|90_000\|hardTimeout\|deadline" src/digest/lifecycle.ts` → no matches.

## Manual Adjustments

- TDD-preferred (not required): the core change is a deletion; tests are updated
  in lockstep but a strict red-before-green cycle is only meaningful for the new
  supersession test (T3.2).

#!/usr/bin/env bash
# Scenario S<N> — <one-line user story>
#
# Goal: <what regression does this catch that nothing else does?>
#
# Copy to your project's scripts/ or tests/scenarios/, then:
#   1. Replace <N> in scn_setup with your scenario id (e.g. "s1", "s7", "s16a")
#   2. Replace placeholder steps with literal text the test will send
#   3. Fill in mechanical assertions (pane / file / log)
#   4. ALWAYS finish with at least one coherence probe IF the scenario submits
#      to the model; for pre-submit-only scenarios, pane/file assertions are
#      sufficient.
#   5. chmod +x and verify it runs standalone before adding to run-all-scenarios.sh

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s<N>"

trap 'scn_pi_stop' EXIT

# Optional environment customisation — uncomment to override scenario-lib defaults:
# export SCENARIO_PROVIDER="claude-bridge"
# export SCENARIO_MODEL="claude-bridge/claude-haiku-4-5"
# export SCENARIO_CWD="/some/test/repo"
# export SCENARIO_PI_ARGS="--no-session -ne -e ./dist/index.js"

scn_pi_start

# ─── Pre-submit pattern (extension transformations, command output) ──────────
# When the change under test happens BEFORE Enter (autocorrect, snippet, status),
# don't submit; just type and capture-pane.
#
# scn_send_no_enter "teh "
# sleep 0.3                                # tiny settle for the editor to render
# scn_assert_pane_contains "the " "S<N>: typo corrected in editor"
# scn_assert_pane_not_contains "teh "      "S<N>: original typo not visible"

# ─── Submit + completion-wait pattern (model interaction) ────────────────────
# When the change requires a model reply, use scn_send (waits for completion).
#
# scn_send "Replace this with the first user prompt."
# scn_assert_pane_contains "<expected-output-marker>" "S<N>: model produced expected output"

# ─── Mid-stream steer pattern ────────────────────────────────────────────────
# scn_send --no-wait "Write me a long essay about X. Take your time."
# scn_wait_for "first-paragraph-marker" 30 || scn_fail "Turn 1 did not start"
# scn_send "Actually stop — make it about Y instead."
# scn_wait_for "Y-marker" 60 || scn_fail "Steer was not integrated"

# ─── Abort pattern ────────────────────────────────────────────────────────────
# scn_send --no-wait "Long task prompt."
# sleep 3                                  # let the turn actually start before aborting
# scn_send_keys Escape
# scn_send "What were you about to do before I interrupted?"

# ─── Command pattern ─────────────────────────────────────────────────────────
# scn_send_no_enter "/typos on"
# scn_send_keys Enter
# scn_wait_for "Autocorrect ON" 5 || scn_fail "S<N>: enable notification missing"

# ─── Status-flash assertion (timed) ──────────────────────────────────────────
# Some markers appear briefly then clear. Assert presence then absence:
# scn_send_no_enter "teh "
# scn_wait_for "✓ teh → the" 2 || scn_fail "S<N>: status flash never appeared"
# scn_wait_for_absent "✓ teh → the" 5 || scn_fail "S<N>: status flash never cleared"

echo "==== S<N> results ===="

# ─── Mechanical assertions (always) ──────────────────────────────────────────
# Combinations of:
#   scn_assert_pane_contains      "<regex>" "<descr>"
#   scn_assert_pane_not_contains  "<regex>" "<descr>"
#   scn_assert_file_contains      "<file>" "<regex>" "<descr>"
#
# For provider/bridge scenarios, also:
#   scn_cache_profile           # prints per-turn cache tuples
#   unique_sids=$(scn_session_count)
#   [[ "$unique_sids" == "1" ]] && scn_pass "single cached session_id" \
#     || scn_fail "expected 1 session, got $unique_sids"

# ─── Coherence probe (REQUIRED if you submitted) ─────────────────────────────
# Send a follow-up whose answer requires the right thing to have happened
# end-to-end. Pair a positive regex (affirmative) with a negative regex (denial).
#
# scn_send "Coherence question requiring recall"
# scn_assert_response \
#     "Coherence question requiring recall" \
#     "<positive-regex-affirming>" \
#     "<negative-regex-denial-or-confusion>" \
#     "S<N> coherence: <what is being asserted>"

echo "===================="
exit $SCN_FAILED

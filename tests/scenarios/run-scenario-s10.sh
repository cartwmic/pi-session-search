#!/usr/bin/env bash
# Scenario S10 — /session:update after a turn writes digest + setSessionName
#
# Goal: Catches regressions where the command exits cleanly but fails to
#       write the digest file, or where a notify error appears in the pane.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s10"

trap 'scn_pi_stop' EXIT

scn_setup_clean_home "s10"

# Digest-hybrid mode requires an embedder. Endpoint need not be live: digest is
# persisted before best-effort index update, and this scenario tests generation.
scn_setup_embedder_config '{
  "embedder": {
    "baseUrl": "http://127.0.0.1:9999",
    "model": "text-embedding-3-small",
    "apiKey": "sk-fake"
  }
}'

# High debounce so the background agent_end hook does not race /session:update.
scn_setup_session_search_config '{"provider":"claude-bridge","model":"claude-haiku-4-5","debounceSeconds":600}'

scn_pi_start_session_search

# One real conversation turn — gives the digest LLM something to summarize.
scn_send "Explain TypeScript generics in 3 sentences."

# Issue the manual digest command (internal LLM call; bridge may log a
# "caching session=" entry for it, so scn_send could time out waiting —
# poll the pane for the notify instead).
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/session:update"
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

# Handler emits on success: "Digest updated: \"<headline>\"". A manual trigger
# can first supersede the agent_end call, so allow time for abort + fresh capture.
scn_wait_for "[Dd]igest updated|[Dd]igest generation failed" 120 \
    || scn_fail "S10: no success/failure notify within 120s"

echo "==== S10 results ===="

# Digest file must exist on disk.
DIGEST_COUNT=0
if [[ -d "$SCN_TEMP_HOME/digests" ]]; then
    DIGEST_COUNT=$(find "$SCN_TEMP_HOME/digests" -name "*.json" 2>/dev/null | wc -l | tr -d ' \n')
fi
DIGEST_COUNT=${DIGEST_COUNT:-0}

if (( DIGEST_COUNT > 0 )); then
    scn_pass "S10: digest file written to disk ($DIGEST_COUNT found)"
else
    scn_fail "S10: no digest file in $SCN_TEMP_HOME/digests/"
fi

scn_assert_pane_contains \
    "[Dd]igest updated" \
    "S10: success notify visible in pane"

scn_assert_pane_not_contains \
    "[Dd]igest generation failed" \
    "S10: no failure notify in pane"

echo "===================="
exit $SCN_FAILED

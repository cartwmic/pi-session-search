#!/usr/bin/env bash
# Scenario S09 — /session:digest with no digest yet shows fallback
#
# Goal: Guards against the show command silently doing nothing or crashing
#       before any digest has been generated for the current session.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s09"

trap 'scn_pi_stop' EXIT

scn_setup_clean_home "s09"

# High debounce so the background agent_end lifecycle cannot write a digest
# automatically before we probe the "no digest yet" path.
scn_setup_session_search_config '{"provider":"claude-bridge","model":"claude-haiku-4-5","debounceSeconds":600}'

scn_pi_start_session_search

# DO NOT send any conversation turn — the digests/ directory must stay empty.
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/session:digest"
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

# Handler emits: ctx.ui.notify("(no digest yet)", "info")
scn_wait_for "no digest yet" 10 \
    || scn_fail "S09: '(no digest yet)' not seen within 10s"

echo "==== S09 results ===="
scn_assert_pane_contains "no digest yet" "S09: pane shows '(no digest yet)' fallback"
echo "===================="
exit $SCN_FAILED

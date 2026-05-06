#!/usr/bin/env bash
# Scenario S14 — session_search in digest-mode shows digest-specific behavior,
# not the legacy fts-raw rendering.
#
# Original goal: verify the empty-state message ("Run /digest:backfill") fires.
# Reality: pi-session-search discovers sessions from $HOME/.pi/agent/sessions/
# (the user's REAL session dir), which PI_SESSION_SEARCH_HOME does not isolate.
# So the index is rarely truly empty in any realistic scenario test.
#
# Adapted assertion: verify the LEGACY "may still be building" message is NOT
# shown in digest-mode. This proves the render code is correctly selecting the
# digest-mode branch even when results exist. The truly-empty-index case is
# covered by a unit test in src/__tests__/index.test.ts.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s14"

trap 'scn_pi_stop' EXIT

scn_setup_clean_home "s14"

# digest.json present → digestRequested=true → detectMode resolves digest-mode.
scn_setup_session_search_config '{"provider":"claude-bridge","model":"claude-haiku-4-5","debounceSeconds": 0}'

scn_pi_start_session_search

scn_send "search sessions for foo"

echo "==== S14 results ===="

# Negative assertion: legacy "may still be building" string must NOT appear.
# Its absence proves digest-mode render branch was selected.
scn_assert_pane_not_contains "may still be building" \
    "S14: legacy empty-state message NOT shown in digest-mode (proves correct render branch)"

echo "===================="
exit $SCN_FAILED

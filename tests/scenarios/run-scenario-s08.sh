#!/usr/bin/env bash
# Scenario S08 — /digest:settings creates global config
#
# Goal: Catches regressions where /digest:settings fails to write digest.json
#       or where the success notify omits the path / reload instruction.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s08"

trap 'scn_pi_stop' EXIT

# Empty HOME — digest.json must NOT exist before the command runs.
scn_setup_clean_home "s08"

# fts-raw mode is fine here: /digest:settings does not check resolvedDigestModel.
scn_pi_start_session_search

# Send the slash command.  No LLM call fires, so we poll the pane directly
# rather than relying on a bridge log event.
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/digest:settings"
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

# Handler emits: "Digest config created at <path>. Edit it then run /reload to activate."
scn_wait_for "[Rr]eload|digest\.json" 10 \
    || scn_fail "S08: notify did not appear within 10s"

echo "==== S08 results ===="

scn_assert_file_exists \
    "$SCN_TEMP_HOME/digest.json" \
    "S08: digest.json created by /digest:settings"

scn_assert_pane_contains \
    "[Rr]eload|digest\.json" \
    "S08: pane shows reload instruction or file path"

echo "===================="
exit $SCN_FAILED

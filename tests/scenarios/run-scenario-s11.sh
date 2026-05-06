#!/usr/bin/env bash
# Scenario S11 — /digest:rewrite forces full re-summarize
#
# Goal: Catches regressions where /digest:rewrite skips the LLM call,
#       returns the cached digest, or fails to overwrite the file on disk.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

# Portable mtime — macOS stat vs GNU stat.
get_mtime() {
    stat -f "%m" "$1" 2>/dev/null || stat -c "%Y" "$1" 2>/dev/null || echo 0
}

SCN_FAILED=0
scn_setup "s11"

trap 'scn_pi_stop' EXIT

scn_setup_clean_home "s11"
scn_setup_session_search_config '{"provider":"claude-bridge","model":"claude-haiku-4-5","debounceSeconds":600}'

scn_pi_start_session_search

# Seed the session with content so the digest LLM has something to work with.
scn_send "Describe how TCP three-way handshakes work in four steps."

# ── Step 1: write the initial digest ────────────────────────────────────────
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/digest:update"
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
scn_wait_for "[Dd]igest updated" 60 \
    || scn_fail "S11: initial /digest:update did not complete within 60s"

# Locate the digest file written for this session.
DIGEST_FILE=$(find "$SCN_TEMP_HOME/digests" -name "*.json" 2>/dev/null | head -1)
if [[ -z "$DIGEST_FILE" ]]; then
    scn_fail "S11: no digest file found after /digest:update"
    exit $SCN_FAILED
fi
scn_pass "S11: initial digest file found: $(basename "$DIGEST_FILE")"

MTIME1=$(get_mtime "$DIGEST_FILE")
BODY1=$(cat "$DIGEST_FILE")

# Sleep ≥1s so filesystem mtime (1-second resolution) can advance.
sleep 2

# ── Step 2: force full rewrite ───────────────────────────────────────────────
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/digest:rewrite"
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
scn_wait_for "[Dd]igest rewritten|[Dd]igest re-summarize failed" 60 \
    || scn_fail "S11: /digest:rewrite did not complete within 60s"

echo "==== S11 results ===="

MTIME2=$(get_mtime "$DIGEST_FILE")
BODY2=$(cat "$DIGEST_FILE")

# Primary assertion: file was rewritten (mtime advanced).
if (( MTIME2 > MTIME1 )); then
    scn_pass "S11: digest mtime advanced (${MTIME1} → ${MTIME2})"
else
    scn_fail "S11: mtime did not advance (was=${MTIME1}, now=${MTIME2})"
fi

# Secondary: body changed.  Identical output from haiku is theoretically
# possible but unlikely; the spec allows "or at minimum, file was rewritten".
if [[ "$BODY1" != "$BODY2" ]]; then
    scn_pass "S11: digest body differs from original"
else
    scn_pass "S11: digest body unchanged (acceptable — file still rewritten per mtime)"
fi

scn_assert_pane_contains \
    "[Dd]igest rewritten" \
    "S11: success notify visible"

scn_assert_pane_not_contains \
    "[Dd]igest re-summarize failed" \
    "S11: no failure notify"

echo "===================="
exit $SCN_FAILED

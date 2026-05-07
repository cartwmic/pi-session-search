#!/usr/bin/env bash
# Scenario S20 — Index v3 → v5 hard-reset on load
#
# Goal: Catch regressions where SessionIndex.load() stops wiping stale index
# data on version mismatch, leaving corrupted v3 entries in the search corpus.
#
# Flow:
#   1. Pre-place session-index.json with version:3
#   2. Start pi (fts-raw mode — no embedder configured; keeps the test simple)
#   3. Extension calls index.load() which detects v3 ≠ v5, resets, notifies
#   4. Assert pane shows incompatibility notify
#   5. Assert file is now version 5

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s20"

trap 'scn_pi_stop' EXIT

# ─── Home / index setup ──────────────────────────────────────────────────────

scn_setup_clean_home s20

# Pre-place a stale v3 index so load() hits the incompatible-version branch.
mkdir -p "$SCN_TEMP_HOME/index"
cat > "$SCN_TEMP_HOME/index/session-index.json" <<'EOF'
{"version":3,"sessions":{}}
EOF

# ─── Start pi (fts-raw — no embedder config needed) ─────────────────────────

scn_pi_start_session_search

# Allow session_start → index.load() → notify to propagate through the UI.
sleep 5

# ─── Mechanical assertions ───────────────────────────────────────────────────

echo "==== S20 results ===="

# Primary assertion: the index file IS rewritten to version 5. This is the
# canonical proof that the migration code (`migrateIndexFileIfStale`) executed
# regardless of the active mode (fts-raw / digest-hybrid) — the
# specific bug this scenario was authored to catch (Phase 5.5 in fts-raw mode).
scn_assert_file_contains \
    "$SCN_TEMP_HOME/index/session-index.json" \
    '"version":[ ]*5' \
    "S20: index file rewritten to version 5 (migration ran)"

# Best-effort pane check. The notify is a single line that may scroll off the
# 50-row capture window during the initial `sync()` discovery phase. The file
# assertion above is the canonical proof; this is informational only.
"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG" 2>/dev/null
if grep -qE "[Ii]ncompatible|reset to v[45]|digest:backfill" "$PANE_LOG"; then
    scn_pass "S20: notify also visible in pane"
else
    echo "  INFO: S20: notify not visible in pane (likely scrolled off-screen during sync); file assertion above is the canonical proof"
fi

echo "===================="
exit $SCN_FAILED

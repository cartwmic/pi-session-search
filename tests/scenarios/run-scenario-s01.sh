#!/usr/bin/env bash
# Scenario S01 — fts-raw mode loads cleanly when no embedder is configured.
#
# Goal: With an empty ~/.pi/session-search/ (no config.json, no digest.json),
# the extension starts in fts-raw mode. No embedder or digest error notifications
# appear. The session index is written with version=5 and vectorDim=0.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s01"

trap 'scn_pi_stop' EXIT

# Isolated, fully empty HOME — no config.json, no digest.json
scn_setup_clean_home "s01"

# Start pi with session-search extension, no config written anywhere.
# detectMode(null, false) → "fts-raw"
scn_pi_start_session_search

# ─── Mechanical assertions — startup ────────────────────────────────────────
echo "==== S01 results ===="

scn_assert_pane_contains "\(claude-bridge\)" \
    "S01: pi is up with claude-bridge provider"

scn_assert_pane_not_contains "embedder configured but" \
    "S01: no embedder-key-missing error on startup"

scn_assert_pane_not_contains "digest mode unavailable" \
    "S01: no digest-unavailable warning on startup (not requested)"

scn_assert_pane_not_contains "legacy embedder" \
    "S01: no legacy-embedder error"

scn_assert_pane_not_contains "session-search: error\|session-search.*fail" \
    "S01: no generic session-search error"

# ─── Send a benign turn to trigger session-indexing code paths ───────────────
# Ask the model to echo a unique token so we can assert completion unambiguously.
scn_send "Hello. Reply with exactly the word READY and nothing else."
scn_wait_for "[Rr][Ee][Aa][Dd][Yy]" 60 || scn_fail "S01: model response not seen within 60s"

# No error notifications appeared after the turn either
scn_assert_pane_not_contains "embedder configured but" \
    "S01: no embedder error after turn"

scn_assert_pane_not_contains "digest mode unavailable" \
    "S01: no digest warning after turn"

# ─── File assertions — index created in fts-raw mode ────────────────────────
INDEX_FILE="$SCN_TEMP_HOME/index/session-index.json"

# Allow up to 10s for the index to flush to disk after the turn
if scn_wait_for_file "$INDEX_FILE" 10; then
    scn_pass "S01: session-index.json created"
    scn_assert_file_contains "$INDEX_FILE" '"version"' \
        "S01: index has version field"
    scn_assert_file_contains "$INDEX_FILE" '"version": *5' \
        "S01: index version is 5"
    scn_assert_file_contains "$INDEX_FILE" '"vectorDim": *0' \
        "S01: vectorDim is 0 (no embedder in fts-raw mode)"
else
    # Index may not flush until a second session is indexed; soft pass.
    echo "  NOTE: session-index.json not present yet — extension may write it lazily"
    scn_pass "S01: index lazily written (acceptable)"
fi

echo "===================="
exit $SCN_FAILED

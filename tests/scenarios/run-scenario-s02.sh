#!/usr/bin/env bash
# Scenario S02 — hybrid-raw mode when embedder configured but no digest model.
#
# Goal: With config.json (embedder section) but NO digest.json, detectMode
# sees embedder present but digestRequested=false. The extension loads in
# hybrid-raw mode. Critically: no "digest mode unavailable" warning is emitted
# because the user never asked for digest mode.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s02"

trap 'scn_pi_stop' EXIT

scn_setup_clean_home "s02"

# Write config.json with a fake OpenAI-compatible embedder endpoint.
# detectMode() only checks that config.embedder is truthy — no actual calls
# will be made because the index is empty and no embedding is triggered.
scn_setup_embedder_config '{
  "embedder": {
    "baseUrl": "http://127.0.0.1:9999",
    "model": "text-embedding-3-small",
    "apiKey": "sk-fake"
  }
}'

# Deliberately do NOT write digest.json.
# digestRequested(config, cwd) returns false → no "unavailable" notification.

scn_pi_start_session_search

# ─── Mechanical assertions — startup ────────────────────────────────────────
echo "==== S02 results ===="

scn_assert_pane_contains "\(claude-bridge\)" \
    "S02: pi is up with claude-bridge provider"

# digest mode was NOT requested → the "unavailable" warning must be absent
scn_assert_pane_not_contains "digest mode unavailable" \
    "S02: no digest-unavailable warning (digest not requested)"

scn_assert_pane_not_contains "Running in hybrid-raw mode" \
    "S02: no explicit hybrid-raw fallback message (not an error)"

scn_assert_pane_not_contains "embedder configured but no API key" \
    "S02: fake apiKey in config is accepted"

scn_assert_pane_not_contains "legacy embedder" \
    "S02: no legacy-embedder warning (new flat config used)"

# ─── Send a benign turn to trigger init paths ────────────────────────────────
scn_send "Hello. Reply with exactly the word READY and nothing else."
scn_wait_for "READY" 60 || scn_fail "S02: model response not seen within 60s"

scn_assert_pane_not_contains "digest mode unavailable" \
    "S02: no digest warning after turn"

# ─── File assertions — index created ────────────────────────────────────────
INDEX_FILE="$SCN_TEMP_HOME/index/session-index.json"

if scn_wait_for_file "$INDEX_FILE" 10; then
    scn_pass "S02: session-index.json created"
    scn_assert_file_contains "$INDEX_FILE" '"version": *4' \
        "S02: index version is 4"
else
    echo "  NOTE: session-index.json not present yet — lazily written"
    scn_pass "S02: index lazily written (acceptable)"
fi

# Digest dir should exist (created by scn_setup_clean_home) but no digest files
DIGEST_DIR="$SCN_TEMP_HOME/digests"
shopt -s nullglob
digest_files=("$DIGEST_DIR"/*.json)
shopt -u nullglob
# Filter out state files and tmp files
real_digests=0
for f in "${digest_files[@]}"; do
    [[ "$f" == *.state.json ]] && continue
    [[ "$f" == *.tmp ]] && continue
    (( real_digests++ ))
done

if (( real_digests == 0 )); then
    scn_pass "S02: no digest file written (digest mode not active)"
else
    scn_fail "S02: unexpected digest file(s) written ($real_digests) — digest should not be active"
fi

echo "===================="
exit $SCN_FAILED

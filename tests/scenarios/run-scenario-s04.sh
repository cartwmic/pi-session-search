#!/usr/bin/env bash
# Scenario S04 — agent_end with debounceSeconds=0 fires generateDigest immediately.
#
# Goal: After a single real conversation turn, both the digest file
# (~/.pi/session-search/digests/<id>.json) and the builder-state file
# (<id>.state.json) are written to disk. The digest contains the required
# schema fields: schemaVersion, headline, body, topics, inputTokenCount.
#
# Depends on real LLM: claude-bridge/claude-haiku-4-5 must be available.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s04"

trap 'scn_pi_stop' EXIT

scn_setup_clean_home "s04"

scn_setup_embedder_config '{
  "embedder": {
    "baseUrl": "http://127.0.0.1:9999",
    "model": "text-embedding-3-small",
    "apiKey": "sk-fake"
  }
}'

# debounceSeconds=0 → generateDigest fires immediately after agent_end
scn_setup_session_search_config '{"provider":"claude-bridge","model":"claude-haiku-4-5",
  "debounceSeconds": 0,
  "resummarizeTokenThreshold": 10000,
  "maxTokens": 1500
}'

scn_pi_start_session_search

scn_assert_file_contains "$BRIDGE_LOG" '"msg":"provider: registered' \
    "S04: pi started successfully"

scn_assert_pane_not_contains "digest mode unavailable" \
    "S04: digest lifecycle installed (haiku resolved)"

# ─── Send a substantive turn so the digest builder has content ───────────────
# Ask for a multi-sentence answer to ensure non-trivial inputTokenCount.
scn_send "Explain the difference between a Python set and a list. Give three concrete differences."
# content-keyword wait removed — digest file presence below proves the model responded

echo "==== S04 results ===="

# ─── Wait for digest file (up to 60s for haiku response) ─────────────────────
DIGEST_DIR="$SCN_TEMP_HOME/digests"
DIGEST_FILE=""

for i in $(seq 1 120); do
    for f in "$DIGEST_DIR"/*.json; do
        [[ -f "$f" ]] || continue
        [[ "$f" == *.state.json ]] && continue
        [[ "$f" == *.tmp ]] && continue
        DIGEST_FILE="$f"
        break 2
    done
    sleep 0.5
done

if [[ -z "$DIGEST_FILE" ]]; then
    scn_fail "S04: digest .json not found within 60s — haiku unavailable or lifecycle not installed"
    echo "===================="
    exit $SCN_FAILED
fi

scn_pass "S04: digest .json appeared"

# ─── Derive session ID and check state file ───────────────────────────────────
SESSION_ID="$(basename "$DIGEST_FILE" .json)"
STATE_FILE="$DIGEST_DIR/${SESSION_ID}.state.json"

if scn_wait_for_file "$STATE_FILE" 10; then
    scn_pass "S04: builder-state .state.json exists alongside digest"
else
    scn_fail "S04: builder-state .state.json not found within 10s"
fi

# ─── Digest schema assertions ────────────────────────────────────────────────
scn_assert_file_contains "$DIGEST_FILE" '"schemaVersion": *1' \
    "S04: schemaVersion=1"
scn_assert_file_contains "$DIGEST_FILE" '"headline"' \
    "S04: digest has headline field"
scn_assert_file_contains "$DIGEST_FILE" '"body"' \
    "S04: digest has body field"
scn_assert_file_contains "$DIGEST_FILE" '"topics"' \
    "S04: digest has topics field"
scn_assert_file_contains "$DIGEST_FILE" '"inputTokenCount"' \
    "S04: digest has inputTokenCount field"
scn_assert_file_contains "$DIGEST_FILE" '"generatedAt"' \
    "S04: digest has generatedAt timestamp"
scn_assert_file_contains "$DIGEST_FILE" '"modelId"' \
    "S04: digest has modelId field"

# headline must not be empty (≤80 chars enforced by schema, ≥1 char)
HEADLINE=$(python3 -c "
import json, sys
d = json.load(open('$DIGEST_FILE'))
h = d.get('headline', '')
sys.exit(0 if h else 1)
" 2>/dev/null && echo "ok" || echo "empty")
if [[ "$HEADLINE" == "ok" ]]; then
    scn_pass "S04: headline is non-empty"
else
    scn_fail "S04: headline is empty or digest is malformed"
fi

# ─── Builder-state schema assertions ─────────────────────────────────────────
scn_assert_file_contains "$STATE_FILE" '"convTokensAtLastWrite"' \
    "S04: state has convTokensAtLastWrite"
scn_assert_file_contains "$STATE_FILE" '"lastWrittenMessageIndex"' \
    "S04: state has lastWrittenMessageIndex"
scn_assert_file_contains "$STATE_FILE" '"lastWrittenSummaryIndex"' \
    "S04: state has lastWrittenSummaryIndex"

# inputTokenCount must be > 0 (real LLM call consumed real tokens)
TOKENS=$(python3 -c "
import json, sys
d = json.load(open('$DIGEST_FILE'))
t = d.get('inputTokenCount', 0)
sys.exit(0 if t > 0 else 1)
" 2>/dev/null && echo "ok" || echo "zero")
if [[ "$TOKENS" == "ok" ]]; then
    scn_pass "S04: inputTokenCount > 0"
else
    scn_fail "S04: inputTokenCount is 0 — digest LLM call may not have consumed tokens"
fi

echo "===================="
exit $SCN_FAILED

#!/usr/bin/env bash
# Scenario S05 — session_compact bypasses debounce.
#
# Goal: With debounceSeconds=600, agent_end does NOT fire a digest within the
# test window. After /compact, triggerImmediate() is called which bypasses the
# debounce timer, and the digest appears within ~30s.
#
# Regression caught: if triggerImmediate() respected the debounce or if
# session_compact was not wired to triggerImmediate(), users who run /compact
# would never get a digest until 10 minutes later.
#
# Depends on real LLM: claude-bridge/claude-haiku-4-5 for the digest call.
# Also requires pi's /compact slash command to fire the session_compact event.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s05"

trap 'scn_pi_stop' EXIT

scn_setup_clean_home "s05"

scn_setup_embedder_config '{
  "embedder": {
    "baseUrl": "http://127.0.0.1:9999",
    "model": "text-embedding-3-small",
    "apiKey": "sk-fake"
  }
}'

# Long debounce — agent_end driven digest will NOT fire in this test window
scn_setup_session_search_config '{"provider":"claude-bridge","model":"claude-haiku-4-5",
  "debounceSeconds": 600,
  "resummarizeTokenThreshold": 10000,
  "maxTokens": 1500
}'

scn_pi_start_session_search

scn_assert_pane_contains "\(claude-bridge\)" \
    "S05: pi started"

scn_assert_pane_not_contains "digest mode unavailable" \
    "S05: digest lifecycle installed (haiku resolved)"

# ─── Build up conversation content over two turns ────────────────────────────
scn_send "Tell me one fact about the Python programming language."
# content-keyword wait removed — scn_send already waits for turn completion

scn_send "Tell me one fact about the JavaScript programming language."
# content-keyword wait removed — scn_send already waits for turn completion

DIGEST_DIR="$SCN_TEMP_HOME/digests"

# ─── Confirm no digest written yet (debounce=600s prevents agent_end digest) ──
sleep 2  # brief settle; digest SHOULD NOT appear
shopt -s nullglob
pre_files=("$DIGEST_DIR"/*.json)
shopt -u nullglob
pre_count=0
for f in "${pre_files[@]}"; do
    [[ "$f" == *.state.json ]] && continue
    [[ "$f" == *.tmp ]] && continue
    (( pre_count++ ))
done

if (( pre_count == 0 )); then
    scn_pass "S05: no digest written before /compact (600s debounce active)"
else
    echo "  WARN: $pre_count digest(s) appeared before /compact — debounce may not be in effect"
fi

# ─── Issue /compact — fires session_compact → triggerImmediate() ─────────────
# /compact triggers a model call to compact the conversation (bridge log entry),
# THEN fires the session_compact extension event → triggers the digest model call.
# scn_send waits for the first "caching session=" (the compact model call).
scn_send "/compact"

echo "==== S05 results ===="

# Wait up to 40s for a (new) digest file; the second model call (haiku for digest)
# fires after the compact model call completes.
DIGEST_FILE=""
for i in $(seq 1 80); do
    shopt -s nullglob
    candidates=("$DIGEST_DIR"/*.json)
    shopt -u nullglob
    for f in "${candidates[@]}"; do
        [[ "$f" == *.state.json ]] && continue
        [[ "$f" == *.tmp ]] && continue
        [[ -f "$f" ]] || continue
        DIGEST_FILE="$f"
        break 2
    done
    sleep 0.5
done

if [[ -n "$DIGEST_FILE" ]]; then
    scn_pass "S05: digest appeared after /compact (debounce bypassed by session_compact)"
    scn_assert_file_contains "$DIGEST_FILE" '"headline"' \
        "S05: digest has headline"
    scn_assert_file_contains "$DIGEST_FILE" '"body"' \
        "S05: digest has body"
    scn_assert_file_contains "$DIGEST_FILE" '"schemaVersion": *1' \
        "S05: digest schemaVersion=1"
else
    # TODO: If pi's /compact command does not fire the session_compact extension
    # event, this assertion will fail even if lifecycle.ts is correct. Verify
    # that pi dispatches the session_compact event to loaded extensions when
    # /compact is issued. Check pi release notes or extension API docs.
    scn_fail "S05: digest not found within 40s after /compact — either session_compact event not fired or haiku unavailable"
fi

echo "===================="
exit $SCN_FAILED

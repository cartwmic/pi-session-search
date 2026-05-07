#!/usr/bin/env bash
# Scenario S03 — digest-hybrid when embedder + cheap model (haiku) both available.
#
# Goal: With config.json (embedder) + digest.json (digest requested), the model
# resolver finds claude-haiku-4-5 from the claude-bridge registry and installs
# the digest lifecycle silently. NO "digest mode unavailable" fallback warning
# appears. After one real turn, a digest file is written to
# ~/.pi/session-search/digests/.
#
# Depends on real LLM: claude-bridge/claude-haiku-4-5 must be available.
# If haiku is not in the registry, the lifecycle emits a fallback notify and
# this scenario will FAIL on the "no digest-unavailable warning" assertion.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s03"

trap 'scn_pi_stop' EXIT

scn_setup_clean_home "s03"

# Embedder — fake endpoint; the field merely needs to be present so verdict
# resolves to digest-hybrid (not fts-raw). No actual embedding calls fire during
# this scenario because the index is empty on a fresh HOME.
scn_setup_embedder_config '{
  "embedder": {
    "baseUrl": "http://127.0.0.1:9999",
    "model": "text-embedding-3-small",
    "apiKey": "sk-fake"
  }
}'

# digest.json — presence makes digestRequested()=true. debounceSeconds=0 so
# the digest fires immediately when agent_end is received.
scn_setup_session_search_config '{"provider":"claude-bridge","model":"claude-haiku-4-5",
  "debounceSeconds": 0,
  "resummarizeTokenThreshold": 10000,
  "maxTokens": 1500
}'

scn_pi_start_session_search

# ─── Startup assertions ───────────────────────────────────────────────────────
echo "==== S03 results ===="

scn_assert_pane_contains "\(claude-bridge\)" \
    "S03: pi is up with claude-bridge provider"

# digest mode IS requested and haiku IS available → no fallback warning
scn_assert_pane_not_contains "digest mode unavailable" \
    "S03: no digest-unavailable warning (haiku resolved)"

scn_assert_pane_not_contains "Running in hybrid-raw mode" \
    "S03: not showing legacy hybrid-raw fallback (mode removed)"

# ─── Send a real turn; digest fires on agent_end (debounce=0) ─────────────────
scn_send "Hello. Briefly explain what a hash map is. Reply with DONE at the very end."
# content-keyword wait removed — digest file presence below proves the model responded

# No late fallback warning
scn_assert_pane_not_contains "digest mode unavailable" \
    "S03: no digest warning after turn"

# ─── Wait for digest file (haiku call fires after agent_end) ─────────────────
DIGEST_DIR="$SCN_TEMP_HOME/digests"
DIGEST_FILE=""

for i in $(seq 1 60); do
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
    scn_pass "S03: digest file appeared within 30s (digest lifecycle active)"
    scn_assert_file_contains "$DIGEST_FILE" '"schemaVersion": *1' \
        "S03: digest schemaVersion=1"
    scn_assert_file_contains "$DIGEST_FILE" '"headline"' \
        "S03: digest has headline"
else
    # TODO: If claude-bridge/claude-haiku-4-5 is not available in the current
    # environment, the model resolver returns undefined and verdict is
    # misconfigured (missing: "digest"). In that case this assertion fails. Run
    # `pi --list-models` to confirm haiku is available before debugging.
    scn_fail "S03: digest file did not appear within 30s — digest LLM call may have failed or haiku not available"
fi

echo "===================="
exit $SCN_FAILED

#!/usr/bin/env bash
# Scenario S19 — Legacy embedder.type = "bedrock" is refused with notify
#
# Goal: Catch silent regressions where createEmbedder's legacy-type guard is
# removed or bypassed, causing users with stale bedrock configs to silently
# enter an unknown mode rather than getting a clear migration prompt.
#
# Flow:
#   1. Write config.json with legacy type:"bedrock" embedder
#   2. Start pi — extension loads, detects unsupported type, fires notify
#   3. Assert pane shows migration notice
#   4. Assert extension is still functional (pi responds to a prompt)

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s19"

trap 'scn_pi_stop' EXIT

# ─── Home / config setup ─────────────────────────────────────────────────────

scn_setup_clean_home s19

# Legacy config: type field is non-openai-compatible → createEmbedder returns
# null and fires notify. The bedrock-specific fields (region, profile) are
# carried in the object to mirror a real migrating user's config.json.
scn_setup_embedder_config '{
  "embedder": {
    "type": "bedrock",
    "baseUrl": "http://fake-bedrock.invalid",
    "model": "amazon.titan-embed-text-v1",
    "region": "us-east-1",
    "profile": "default"
  }
}'

# ─── Start pi ────────────────────────────────────────────────────────────────

scn_pi_start_session_search

# Allow the extension's session_start handler to fire and propagate the notify
# through pi's UI render loop.
sleep 5

# ─── Mechanical assertions ───────────────────────────────────────────────────

echo "==== S19 results ===="

scn_assert_pane_contains \
    "[Ss]ession-search.*[Bb]edrock|[Ss]ession-search.*legacy|[Ss]ession-search.*[Ll]egacy|/session-embeddings-setup|legacy.*embedder|no longer supported" \
    "S19: pane shows legacy-embedder migration notify"

# Pi must still respond — the extension degraded gracefully (fts-raw mode),
# the process did not crash.
scn_send "say the word: ready"

scn_assert_pane_contains \
    "[Rr]eady" \
    "S19: pi responded after legacy-embedder rejection (no crash)"

echo "===================="
exit $SCN_FAILED

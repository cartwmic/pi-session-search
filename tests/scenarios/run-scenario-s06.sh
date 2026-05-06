#!/usr/bin/env bash
# Scenario S06 — session_shutdown aborts in-flight digest LLM call.
#
# Goal: While the model is generating a response to a long prompt, exit pi via
# Ctrl-D. The session_shutdown event fires, which aborts the in-flight
# AbortController and prevents any partial digest file from being written.
# After exit, no corrupt/partial digest exists on disk.
#
# Two valid outcomes (see lifecycle.ts session_shutdown handler):
#   A. No digest file at all — shutdown occurred before agent_end fired and
#      triggered the digest call.
#   B. A valid, complete digest file — agent_end + fireDigest() completed
#      before Ctrl-D arrived (race condition). The file must be valid JSON
#      and pass schema validation (atomic rename ensures this).
# Either outcome is PASS. A corrupt/partial JSON file is always FAIL.
#
# Regression caught: if saveDigest() were not atomic (write-then-rename),
# an aborted in-flight call could leave a partial JSON file.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s06"

trap 'scn_pi_stop' EXIT

scn_setup_clean_home "s06"

scn_setup_embedder_config '{
  "embedder": {
    "baseUrl": "http://127.0.0.1:9999",
    "model": "text-embedding-3-small",
    "apiKey": "sk-fake"
  }
}'

# debounceSeconds=0 — the digest fires immediately after agent_end.
# This maximises the chance of hitting the "in-flight + shutdown" race.
scn_setup_session_search_config '{"provider":"claude-bridge","model":"claude-haiku-4-5",
  "debounceSeconds": 0,
  "resummarizeTokenThreshold": 10000,
  "maxTokens": 1500
}'

scn_pi_start_session_search

scn_assert_pane_contains "\(claude-bridge\)" \
    "S06: pi started"

scn_assert_pane_not_contains "digest mode unavailable" \
    "S06: digest lifecycle installed"

# ─── Send a long prompt WITHOUT waiting for completion ───────────────────────
# After Enter, the editor is empty → Ctrl-D will trigger pi exit.
# The model is mid-generation when we interrupt.
scn_send --no-wait \
    "Write a 500-word essay about the history of computing, starting with Charles Babbage and ending with modern cloud computing."

# Let the turn start and the model begin generating (not necessarily finish)
sleep 3

# ─── Exit pi: Ctrl-D on an empty editor fires session_shutdown ───────────────
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" C-d

# Wait up to 10s for pi to exit (tmux session terminates)
PI_EXITED=0
for i in $(seq 1 20); do
    if ! "${TMUX_CMD[@]}" has-session -t "$SESSION" 2>/dev/null; then
        PI_EXITED=1
        break
    fi
    sleep 0.5
done

echo "==== S06 results ===="

if (( PI_EXITED )); then
    scn_pass "S06: pi exited after Ctrl-D"
else
    scn_pi_stop
    scn_fail "S06: pi did not exit within 10s after Ctrl-D"
fi

DIGEST_DIR="$SCN_TEMP_HOME/digests"

# ─── Inspect what's on disk ───────────────────────────────────────────────────
shopt -s nullglob
all_json=("$DIGEST_DIR"/*.json)
shopt -u nullglob

digest_files=()
for f in "${all_json[@]}"; do
    [[ "$f" == *.state.json ]] && continue
    [[ "$f" == *.tmp ]] && continue
    [[ -f "$f" ]] || continue
    digest_files+=("$f")
done

if (( ${#digest_files[@]} == 0 )); then
    # Outcome A: no digest at all (shutdown interrupted before digest completed)
    scn_pass "S06: no digest file written — in-flight call aborted cleanly by session_shutdown"
else
    # Outcome B: a digest was written — it raced to completion before shutdown.
    # The file MUST be valid JSON (atomic rename in saveDigest ensures this).
    echo "  NOTE: ${#digest_files[@]} digest file(s) found — checking for corruption..."
    all_valid=1
    for f in "${digest_files[@]}"; do
        if python3 -c "import json, sys; json.load(open('$f')); sys.exit(0)" 2>/dev/null; then
            scn_pass "S06: $(basename "$f") is valid JSON (completed before shutdown, atomic write OK)"
        else
            scn_fail "S06: $(basename "$f") is NOT valid JSON — partial/corrupted file detected"
            all_valid=0
        fi
    done

    if (( all_valid )); then
        # Verify schema fields are present (not empty stubs)
        for f in "${digest_files[@]}"; do
            scn_assert_file_contains "$f" '"headline"' \
                "S06: digest has headline (not a stub)"
            scn_assert_file_contains "$f" '"body"' \
                "S06: digest has body (not a stub)"
        done
    fi
fi

# Also check that no .tmp files were left behind (cleanup on abort)
shopt -s nullglob
tmp_files=("$DIGEST_DIR"/*.tmp)
shopt -u nullglob
if (( ${#tmp_files[@]} == 0 )); then
    scn_pass "S06: no leftover .tmp files"
else
    scn_fail "S06: ${#tmp_files[@]} leftover .tmp file(s) found — saveDigest may not have cleaned up"
fi

echo "===================="
exit $SCN_FAILED

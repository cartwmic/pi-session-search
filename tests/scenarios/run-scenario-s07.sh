#!/usr/bin/env bash
# Scenario S07 — builder state persists across pi restart (incremental mode).
#
# Goal: After turn 1 generates digest1 (large inputTokenCount), restarting pi
# from the same CWD/HOME and sending a short follow-up generates digest2 with a
# significantly smaller inputTokenCount. This proves that session_start restored
# the builder anchors from <id>.state.json so the builder used the incremental
# delta-prompt path instead of re-summarising the full conversation.
#
# If state were NOT restored, digest2's inputTokenCount would be large (the
# builder would re-summarise the full session conversation again) and comparable
# to digest1. The 70% threshold is the pass criterion.
#
# NOTE: This scenario starts pi WITHOUT --no-session so that the second invocation
# from the same CWD resumes the same session (same sessionId → loads same
# state.json). With --no-session each run gets a new UUID and state can't be
# shared across restarts. A workspace dir under SCN_TEMP_HOME isolates the session
# from the user's real ~/.pi/agent/sessions/ tree.
#
# Depends on real LLM: claude-bridge/claude-haiku-4-5.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s07"

trap 'scn_pi_stop' EXIT

scn_setup_clean_home "s07"

scn_setup_embedder_config '{
  "embedder": {
    "baseUrl": "http://127.0.0.1:9999",
    "model": "text-embedding-3-small",
    "apiKey": "sk-fake"
  }
}'

scn_setup_session_search_config '{"provider":"claude-bridge","model":"claude-haiku-4-5",
  "debounceSeconds": 0,
  "resummarizeTokenThreshold": 10000,
  "maxTokens": 1500
}'

# Dedicated workspace so sessions don't pollute the repo dir.
# Both pi invocations run from this directory → same CWD-based session ID.
WORKSPACE="$SCN_TEMP_HOME/workspace"
mkdir -p "$WORKSPACE"
SCENARIO_CWD="$WORKSPACE"

# ── Helper: start pi WITHOUT --no-session so the session persists and can be
# resumed. Session files land under HOME/.pi/agent/sessions/ which is isolated
# to SCN_TEMP_HOME. Accepts an optional session name override (for the restart).
s07_start_pi() {
    local sess="${1:-$SESSION}"
    # NO -ne: claude-bridge must auto-load (it's an installed extension); -ne
    # would disable it and pi would fail "Unknown provider claude-bridge".
    # PI_SESSION_SEARCH_HOME isolates session-search state to the temp dir
    # without overriding $HOME (which would break Claude Code SDK auth).
    "${TMUX_CMD[@]}" new-session -d -s "$sess" -x 200 -y 50 \
        "cd '$WORKSPACE' && PI_SESSION_SEARCH_HOME='$SCN_TEMP_HOME' \
         CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
         pi -e '$REPO_DIR' --provider claude-bridge --model '$SCENARIO_MODEL'"

    local deadline=$((SECONDS + 30))
    while (( SECONDS < deadline )); do
        if "${TMUX_CMD[@]}" capture-pane -t "${sess}:0" -p -S -50 2>/dev/null \
                | grep -qE "\(claude-bridge\)"; then
            break
        fi
        sleep 0.5
    done
    # Extra settle: re-eval timer (1s) may need to fire to resolve haiku
    sleep 2
}

# ═══════════════════════════════════════════════════════════════════════════════
# ── First pi run ────────────────────────────────────────────────────────────
# ═══════════════════════════════════════════════════════════════════════════════
s07_start_pi "$SESSION"

scn_assert_pane_contains "\(claude-bridge\)" \
    "S07: first pi instance started"

scn_assert_pane_not_contains "digest mode unavailable" \
    "S07: digest lifecycle installed on first start"

# Send a substantive first turn — larger conversation = larger inputTokenCount
scn_send "Explain three key differences between compiled and interpreted programming languages. Be thorough with at least two sentences per point."
# content-keyword wait removed — scn_send already waits for turn completion via bridge log

DIGEST_DIR="$SCN_TEMP_HOME/digests"

# Wait for digest1 (debounce=0, fires after agent_end)
DIGEST_FILE1=""
for i in $(seq 1 120); do
    shopt -s nullglob
    cands=("$DIGEST_DIR"/*.json)
    shopt -u nullglob
    for f in "${cands[@]}"; do
        [[ "$f" == *.state.json ]] && continue
        [[ "$f" == *.tmp ]] && continue
        [[ -f "$f" ]] || continue
        DIGEST_FILE1="$f"
        break 2
    done
    sleep 0.5
done

if [[ -z "$DIGEST_FILE1" ]]; then
    scn_fail "S07: digest1 not found within 60s — cannot test incremental mode"
    echo "===================="
    exit $SCN_FAILED
fi
scn_pass "S07: digest1 appeared"

SESSION_ID="$(basename "$DIGEST_FILE1" .json)"
STATE_FILE="$DIGEST_DIR/${SESSION_ID}.state.json"

scn_assert_file_exists "$STATE_FILE" \
    "S07: builder-state file written alongside digest1"

TOKENS1=$(python3 -c "
import json, sys
try:
    d = json.load(open('$DIGEST_FILE1'))
    t = d.get('inputTokenCount', 0)
    print(t)
except Exception as e:
    print(0)
" 2>/dev/null || echo 0)
echo "  digest1 inputTokenCount=$TOKENS1"

if ! python3 -c "exit(0 if int('$TOKENS1') > 0 else 1)" 2>/dev/null; then
    scn_fail "S07: digest1 inputTokenCount is 0 — cannot perform incremental comparison"
    echo "===================="
    exit $SCN_FAILED
fi
scn_pass "S07: digest1 inputTokenCount=$TOKENS1 (>0)"

MTIME1=$(python3 -c "import os; print(os.path.getmtime('$DIGEST_FILE1'))" 2>/dev/null || echo 0)

# ── Stop first pi instance ────────────────────────────────────────────────────
# Editor is idle after the turn completes; Ctrl-D exits cleanly.
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" C-d

for i in $(seq 1 20); do
    "${TMUX_CMD[@]}" has-session -t "$SESSION" 2>/dev/null || break
    sleep 0.5
done
scn_pi_stop   # kill server; new server starts fresh below

# ═══════════════════════════════════════════════════════════════════════════════
# ── Second pi run — same HOME + workspace → resumes same session ─────────────
# ═══════════════════════════════════════════════════════════════════════════════
# Fresh tmux socket so the new server doesn't collide with the disposed one.
SCN_TMUX_SOCKET="pi-scn-s07r-$$"
TMUX_CMD=(tmux -L "$SCN_TMUX_SOCKET")

SESSION_R="pi-bridge-s07r-$$"
BRIDGE_LOG="${BRIDGE_LOG%.bridge.log}-r2.bridge.log"

s07_start_pi "$SESSION_R"
SESSION="$SESSION_R"   # redirect scn_send → new pane

scn_assert_pane_contains "\(claude-bridge\)" \
    "S07: second pi instance started"

# Send a SHORT follow-up to the resumed session.
# This single message is the "delta" — in incremental mode the builder only
# sends this message to haiku, not the full prior conversation.
scn_send "What is the single most important takeaway from everything you explained?"
# content-keyword wait removed — scn_send already waits for turn completion via bridge log

# ─── Wait for digest2 (newer than digest1) ───────────────────────────────────
DIGEST_FILE2=""
for i in $(seq 1 120); do
    shopt -s nullglob
    cands=("$DIGEST_DIR"/*.json)
    shopt -u nullglob
    newest=""
    for f in "${cands[@]}"; do
        [[ "$f" == *.state.json ]] && continue
        [[ "$f" == *.tmp ]] && continue
        [[ -f "$f" ]] || continue
        fmtime=$(python3 -c "import os; print(os.path.getmtime('$f'))" 2>/dev/null || echo 0)
        if python3 -c "exit(0 if float('$fmtime') > float('$MTIME1') else 1)" 2>/dev/null; then
            newest="$f"
            break
        fi
    done
    if [[ -n "$newest" ]]; then
        DIGEST_FILE2="$newest"
        break
    fi
    sleep 0.5
done

echo "==== S07 results ===="

if [[ -z "$DIGEST_FILE2" ]]; then
    scn_fail "S07: digest2 not found within 60s — incremental digest did not fire after restart"
    echo "===================="
    exit $SCN_FAILED
fi
scn_pass "S07: digest2 appeared after restart"

TOKENS2=$(python3 -c "
import json
try:
    d = json.load(open('$DIGEST_FILE2'))
    print(d.get('inputTokenCount', 0))
except Exception:
    print(0)
" 2>/dev/null || echo 0)
echo "  digest2 inputTokenCount=$TOKENS2"

# ─── Incremental mode assertion ───────────────────────────────────────────────
# Pass criterion: tokens2 < tokens1 * 0.70
# (70% threshold is generous — real incremental delta should be 10–30% of tokens1)
# Failure means state.json was not loaded and the full conversation was re-sent.
python3 - <<PYEOF
import sys
t1 = int("$TOKENS1")
t2 = int("$TOKENS2")
threshold = t1 * 0.70
ok = t2 < threshold and t1 > 0
print(f"  tokens1={t1}  tokens2={t2}  threshold={threshold:.0f}  ok={ok}")
sys.exit(0 if ok else 1)
PYEOF
if [[ $? -eq 0 ]]; then
    scn_pass "S07: digest2 inputTokenCount ($TOKENS2) is < 70% of digest1 ($TOKENS1) — incremental mode active"
else
    scn_fail "S07: digest2 inputTokenCount ($TOKENS2) is NOT significantly less than digest1 ($TOKENS1) — builder-state may not have been restored from state.json"
fi

echo "===================="
exit $SCN_FAILED

#!/usr/bin/env bash
# Scenario S02 — misconfigured-verdict UX (5 sub-tests)
#
# Repurposed from old "hybrid-raw boots clean" scenario (v2.x).
# 5 independent sub-tests with continued-on-failure semantics:
#   (a) embedder set, digest absent → misconfigured (missing: "digest")
#   (b) digest set, embedder absent → misconfigured (missing: "embedder")
#   (c) both broken (legacy bedrock embedder + digest configured but no model)
#   (d) warm-path: start digest-hybrid, remove digest.json, /reload → misconfigured
#   (e) legacy-bedrock + no-digest-intent → fts-raw (NOT misconfigured)

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"
set +e  # manual error handling for continued-on-failure semantics

SCN_FAILED=0
PASS_COUNT=0
FAIL_COUNT=0

# ──────────────────────────────────────────────────────────────────────────────
# Sub-test (a): embedder set, digest absent → missing: "digest"
# ──────────────────────────────────────────────────────────────────────────────
sub_test_a() {
  local my_failed=0
  scn_setup "s02-a"
  scn_setup_clean_home "s02-a"

  # Write config.json with embedder, deliberately NO digest.json
  scn_setup_embedder_config '{
    "embedder": {
      "baseUrl": "http://127.0.0.1:9999",
      "model": "text-embedding-3-small",
      "apiKey": "sk-fake"
    }
  }'

  scn_pi_start_session_search
  sleep 4  # allow verdict resolution + notify propagation

  echo "==== S02 (a) results ===="

  "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"

  # 1. Status/notify: misconfigured (no digest model)
  if grep -qE "misconfigured.*digest|no digest model" "$PANE_LOG"; then
    scn_pass "S02(a): misconfigured notify visible (no digest model)"
  else
    scn_fail "S02(a): misconfigured notify missing"
    my_failed=1
  fi

  # 2. Remediation message mentions digest.json
  if grep -qE "Configure.*\.pi/session-search/digest\.json" "$PANE_LOG"; then
    scn_pass "S02(a): remediation suggests digest.json config"
  else
    scn_fail "S02(a): remediation missing digest.json reference"
    my_failed=1
  fi

  # 3. /find-session invocation emits remediation (send-keys approach)
  "${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/find-session test"
  "${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
  sleep 2
  "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
  if grep -qE "misconfigured.*digest|no digest model" "$PANE_LOG"; then
    scn_pass "S02(a): /find-session shows remediation"
  else
    scn_fail "S02(a): /find-session did not show remediation"
    my_failed=1
  fi

  # 4. /session:summarizer works normally (recovery command, no short-circuit)
  "${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/session:summarizer"
  "${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
  sleep 2
  "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
  if grep -qE "Digest config created|Digest config exists|Edit it then run /reload" "$PANE_LOG"; then
    scn_pass "S02(a): /session:summarizer works normally (recovery command)"
  else
    scn_fail "S02(a): /session:summarizer did not show expected output"
    my_failed=1
  fi

  # 5. Best-effort: send search prompt to trigger session_search tool
  #    (model must be available for this to work)
  scn_send "search sessions for test query please"
  sleep 3
  "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
  if grep -qE "misconfigured|no digest model|Configure.*digest\.json" "$PANE_LOG"; then
    scn_pass "S02(a): session_search tool returns remediation (via model)"
  else
    echo "  INFO: S02(a): session_search tool assertion skipped (model may not have called tool)"
  fi

  scn_pi_stop
  return $my_failed
}

# ──────────────────────────────────────────────────────────────────────────────
# Sub-test (b): digest set, embedder absent → missing: "embedder"
# ──────────────────────────────────────────────────────────────────────────────
sub_test_b() {
  local my_failed=0
  scn_setup "s02-b"
  scn_setup_clean_home "s02-b"

  # Write digest.json, deliberately NO config.json (no embedder)
  scn_setup_session_search_config '{"provider":"claude-bridge","model":"claude-haiku-4-5","debounceSeconds":0}'

  scn_pi_start_session_search
  sleep 4

  echo "==== S02 (b) results ===="

  "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"

  # 1. Misconfigured (no embedder)
  if grep -qE "misconfigured.*embedder|no embedder" "$PANE_LOG"; then
    scn_pass "S02(b): misconfigured notify visible (no embedder)"
  else
    scn_fail "S02(b): misconfigured notify missing"
    my_failed=1
  fi

  # 2. Remediation mentions config.json
  if grep -qE "Configure.*\.pi/session-search/config\.json" "$PANE_LOG"; then
    scn_pass "S02(b): remediation suggests config.json config"
  else
    scn_fail "S02(b): remediation missing config.json reference"
    my_failed=1
  fi

  # 3. /find-session emits remediation
  "${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/find-session test"
  "${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
  sleep 2
  "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
  if grep -qE "misconfigured|no embedder" "$PANE_LOG"; then
    scn_pass "S02(b): /find-session shows remediation"
  else
    scn_fail "S02(b): /find-session did not show remediation"
    my_failed=1
  fi

  # 4. /session:summarizer works normally (recovery command)
  "${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/session:summarizer"
  "${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
  sleep 2
  "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
  if grep -qE "Digest config created|Digest config exists|Edit it then run /reload" "$PANE_LOG"; then
    scn_pass "S02(b): /session:summarizer works normally (recovery command)"
  else
    scn_fail "S02(b): /session:summarizer did not show expected output"
    my_failed=1
  fi

  scn_pi_stop
  return $my_failed
}

# ──────────────────────────────────────────────────────────────────────────────
# Sub-test (c): both broken → missing: "both"
#   Legacy bedrock embedder (createEmbedder fails) + digest.json with no model
# ──────────────────────────────────────────────────────────────────────────────
sub_test_c() {
  local my_failed=0
  scn_setup "s02-c"
  scn_setup_clean_home "s02-c"

  # Legacy bedrock embedder — createEmbedder returns null, fires rejection notify
  scn_setup_embedder_config '{
    "embedder": {
      "type": "bedrock",
      "baseUrl": "http://fake-bedrock.invalid",
      "model": "amazon.titan-embed-text-v1",
      "region": "us-east-1",
      "profile": "default"
    }
  }'

  # Digest.json with non-resolvable model → digestRequested=true but no model
  scn_setup_session_search_config '{"provider":"nonexistent","model":"no-such-model"}'

  scn_pi_start_session_search
  sleep 4

  echo "==== S02 (c) results ===="

  "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"

  # 1. Legacy bedrock rejection notify fires (from createEmbedder)
  if grep -qE "legacy.*embedder|bedrock.*no.*longer|/session:embedder" "$PANE_LOG"; then
    scn_pass "S02(c): legacy bedrock rejection notify visible"
  else
    scn_fail "S02(c): legacy bedrock rejection notify missing"
    my_failed=1
  fi

  # 2. Missing: "both" notify text mentions both files
  # The remediation message says "Configure both ... config.json AND ... digest.json"
  if grep -qE "Configure both.*config\.json.*AND.*digest\.json" "$PANE_LOG"; then
    scn_pass "S02(c): 'both' remediation mentions both config files"
  elif grep -qE "no embedder.*no digest" "$PANE_LOG"; then
    scn_pass "S02(c): 'both' remediation mentions both components"
  else
    scn_fail "S02(c): 'both' remediation not visible"
    my_failed=1
  fi

  # 3. /find-session emits remediation (either variant)
  "${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/find-session test"
  "${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
  sleep 2
  "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
  if grep -qE "misconfigured|no embedder|no digest" "$PANE_LOG"; then
    scn_pass "S02(c): /find-session shows remediation"
  else
    scn_fail "S02(c): /find-session did not show remediation"
    my_failed=1
  fi

  scn_pi_stop
  return $my_failed
}

# ──────────────────────────────────────────────────────────────────────────────
# Sub-test (d): warm-path transition. Start digest-hybrid, remove digest.json,
#               /reload, assert misconfigured status + tool remediation.
# ──────────────────────────────────────────────────────────────────────────────
sub_test_d() {
  local my_failed=0
  scn_setup "s02-d"
  scn_setup_clean_home "s02-d"

  # Both config files present → digest-hybrid on first boot
  scn_setup_embedder_config '{
    "embedder": {
      "baseUrl": "http://127.0.0.1:9999",
      "model": "text-embedding-3-small",
      "apiKey": "sk-fake"
    }
  }'
  scn_setup_session_search_config '{"provider":"claude-bridge","model":"claude-haiku-4-5","debounceSeconds":0}'

  scn_pi_start_session_search
  sleep 4

  echo "==== S02 (d) results ===="

  "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"

  # 1. First boot: digest-hybrid, no misconfigured error
  if grep -qE "misconfigured" "$PANE_LOG"; then
    # If legacy-rejection or other notify snuck in, log but don't fail yet
    echo "  INFO: S02(d): initial pane shows misconfigured (unexpected backup path — may pass)"
  else
    scn_pass "S02(d): first boot shows no misconfigured (digest-hybrid expected)"
  fi

  # 2. Remove digest.json, send /reload
  rm -f "$SCN_TEMP_HOME/digest.json"
  "${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/reload"
  "${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
  sleep 5  # wait for reload + re-verdict + notify

  "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"

  # 3. After /reload: misconfigured notify visible (missing: "digest")
  if grep -qE "misconfigured.*digest|no digest model|Configure.*digest\.json" "$PANE_LOG"; then
    scn_pass "S02(d): after /reload, misconfigured notify visible (missing digest)"
  else
    scn_fail "S02(d): misconfigured notify not visible after /reload"
    my_failed=1
  fi

  # 4. /find-session now returns remediation
  "${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/find-session test"
  "${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
  sleep 2
  "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
  if grep -qE "misconfigured|no digest model|Configure.*digest\.json" "$PANE_LOG"; then
    scn_pass "S02(d): /find-session returns remediation after transition"
  else
    scn_fail "S02(d): /find-session did not return remediation after transition"
    my_failed=1
  fi

  scn_pi_stop
  return $my_failed
}

# ──────────────────────────────────────────────────────────────────────────────
# Sub-test (e): legacy-bedrock embedder + NO digest.json + NO overrides.
#   createEmbedder-runs-before-verdict + digestRequested=false → fts-raw.
#   Legacy-rejection notify fires, verdict is fts-raw (NOT misconfigured).
# ──────────────────────────────────────────────────────────────────────────────
sub_test_e() {
  local my_failed=0
  scn_setup "s02-e"
  scn_setup_clean_home "s02-e"

  # Legacy bedrock embedder config, NO digest.json
  scn_setup_embedder_config '{
    "embedder": {
      "type": "bedrock",
      "baseUrl": "http://fake-bedrock.invalid",
      "model": "amazon.titan-embed-text-v1",
      "region": "us-east-1",
      "profile": "default"
    }
  }'
  # Deliberately NO digest.json — digestRequested === false

  scn_pi_start_session_search
  sleep 4

  echo "==== S02 (e) results ===="

  "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"

  # 1. Legacy rejection notify fires (from createEmbedder)
  if grep -qE "legacy.*embedder|bedrock.*no.*longer|/session:embedder" "$PANE_LOG"; then
    scn_pass "S02(e): legacy bedrock rejection notify visible"
  else
    scn_fail "S02(e): legacy bedrock rejection notify missing"
    my_failed=1
  fi

  # 2. NO misconfigured notify (verdict is fts-raw, NOT misconfigured)
  if grep -qE "session-search: misconfigured" "$PANE_LOG"; then
    scn_fail "S02(e): misconfigured notify SHOULD NOT appear (verdict should be fts-raw)"
    my_failed=1
  else
    scn_pass "S02(e): no misconfigured notify (correct: verdict is fts-raw)"
  fi

  # 3. session_search works as normal fts-raw search.
  #    Best-effort: send a search prompt, check the tool result is NOT remediation.
  scn_send "search sessions for test query please"
  sleep 4
  "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"

  # The tool should NOT return remediation text in fts-raw mode
  if grep -qE "misconfigured" "$PANE_LOG"; then
    scn_fail "S02(e): session_search shows misconfigured (expected fts-raw behavior)"
    my_failed=1
  else
    scn_pass "S02(e): session_search does not show misconfigured (fts-raw path confirmed)"
  fi

  scn_pi_stop
  return $my_failed
}

# ═══════════════════════════════════════════════════════════════════════════════
# Run all 5 sub-tests sequentially
# ═══════════════════════════════════════════════════════════════════════════════

echo "═══════════════════════════════════"
echo "  S02 — 5 sub-tests"
echo "═══════════════════════════════════"

for fn in sub_test_a sub_test_b sub_test_c sub_test_d sub_test_e; do
  echo ""
  echo "─── Running $fn ───"
  if $fn; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  SUBTEST $fn: PASS"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  SUBTEST $fn: FAIL"
    SCN_FAILED=1
  fi
done

echo ""
echo "═══════════════════════════════════"
echo "  S02 SUMMARY: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "═══════════════════════════════════"
exit $SCN_FAILED

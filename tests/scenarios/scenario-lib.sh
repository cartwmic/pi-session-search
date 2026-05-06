#!/usr/bin/env bash
# scenario-lib.sh — shared helpers for tmux-driven pi scenario validation.
# Source from any scenario script: `source "$(dirname "$0")/scenario-lib.sh"`.
#
# Conventions:
#   - tmux session name is exported as $SESSION
#   - tmux pane is always 0 (single-pane sessions)
#   - bridge debug log is piped to .test-output/scenarios/<scenario>.bridge.log
#   - pane captures go to .test-output/scenarios/<scenario>.pane.log
#
# Reads from environment (with sensible defaults):
#   SCENARIO_MODEL  default: claude-bridge/claude-haiku-4-5
#   SCENARIO_CWD    default: $(pwd)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts live at <project>/tests/scenarios/, so REPO_DIR is two parents up.
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Match run-all-scenarios.sh's RESULTS_DIR: <project>/tests/.test-output/scenarios
OUT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/.test-output/scenarios"
mkdir -p "$OUT_DIR"

: "${SCENARIO_MODEL:=claude-bridge/claude-haiku-4-5}"
: "${SCENARIO_CWD:=$REPO_DIR}"

# Pi's interrupt key is Escape, not Ctrl-C. (See SCENARIOS.md.)
PI_INTERRUPT_KEY="Escape"

# ─── Private tmux server (parallel-safe) ─────────────────────────────────────
# Every scenario runs against its own tmux server (selected via `tmux -L`).
# This makes scenarios independent: kill-server in one cannot affect another,
# stray pi processes from one cannot poison another, and parallel runs
# trivially don't collide. The socket is namespaced by PID so concurrent
# scripts each get a unique one.
: "${SCN_TMUX_SOCKET:=pi-scn-$$}"
TMUX_CMD=(tmux -L "$SCN_TMUX_SOCKET")

scn_setup() {
	local name="$1"
	export SESSION="pi-bridge-${name}-$$"
	export BRIDGE_LOG="$OUT_DIR/${name}.bridge.log"
	export PANE_LOG="$OUT_DIR/${name}.pane.log"
	rm -f "$BRIDGE_LOG" "$PANE_LOG"
	export CLAUDE_BRIDGE_DEBUG=1
	export CLAUDE_BRIDGE_DEBUG_PATH="$BRIDGE_LOG"
}

scn_pi_start() {
	# Start pi in a fresh tmux session. Background; returns when pi is ready.
	#
	# Readiness: poll the pane until pi has rendered its bottom status line
	# `(claude-bridge) <model>` rather than a fixed `sleep 3`. A fixed sleep
	# loses keystrokes when pi's startup is slow (tmux contention, opus
	# boot) — the tmux session exists but pi's input isn't focused yet, so
	# `tmux send-keys` fires into the void and the test silently hangs.
	# Symptom: bridge log only shows "provider: registered" with no fresh
	# query line.
	local extra_args=""
	if (( $# > 0 )); then extra_args="$*"; fi
	# -ne disables auto-discovered extensions; -e loads ONLY our local copy.
	# Without -ne, pi would also load the installed copy at
	# ~/.pi/agent/git/github.com/cartwmic/pi-claude-bridge/, and the symbol
	# guard means the installed (legacy) one would win.
	"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
		"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
		 pi --no-session -ne -e '$REPO_DIR' --provider claude-bridge --model '$SCENARIO_MODEL' $extra_args"

	local deadline=$((SECONDS + 30))
	while (( SECONDS < deadline )); do
		if "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -50 2>/dev/null | grep -qE "\(claude-bridge\)"; then
			break
		fi
		sleep 0.5
	done
	# Settle the draw loop after the ready marker appears.
	sleep 1
}

scn_pi_stop() {
	# Tear down the entire private tmux server, not just the session.
	# Since the server is dedicated to this scenario (per SCN_TMUX_SOCKET),
	# kill-server cleanly disposes of everything: the session, the pi
	# process inside it, and the server itself. No stray state survives,
	# no broad `pkill` needed, no risk to parallel siblings.
	"${TMUX_CMD[@]}" kill-server 2>/dev/null || true
}

# Cross-scenario isolation. Now a no-op when each scenario has its own
# private tmux server (the default). Kept for explicit use in scripts
# that want to ensure their server is fresh — idempotent. NEVER use a
# broad `pkill -f "pi --no-session"` here: it would kill parallel
# scenarios' pi processes that happen to share the user.
scn_clean_state() {
	"${TMUX_CMD[@]}" kill-server 2>/dev/null || true
}

scn_send() {
	# scn_send "<text>"
	# Sends text + Enter, then waits for the bridge to finish processing this
	# turn. "Finish" = a new "caching session=" line appears in the bridge
	# log (one per completed query() call). Falls back to wall-clock timeout.
	#
	# Pass --no-wait as the first arg to skip the wait (e.g. for steering).
	local wait_for_completion=1
	if [[ "${1:-}" == "--no-wait" ]]; then wait_for_completion=0; shift; fi

	local pre_count=0
	if [[ -f "$BRIDGE_LOG" ]]; then
		pre_count=$(grep -cE "caching session=" "$BRIDGE_LOG" 2>/dev/null | head -1 | tr -d ' \n' || echo 0)
		pre_count=${pre_count:-0}
	fi

	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "$1"
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

	if (( wait_for_completion )); then
		local timeout=120
		local start=$SECONDS
		while (( SECONDS - start < timeout )); do
			local cur=0
			if [[ -f "$BRIDGE_LOG" ]]; then
				cur=$(grep -cE "caching session=" "$BRIDGE_LOG" 2>/dev/null | head -1 | tr -d ' \n' || echo 0)
				cur=${cur:-0}
			fi
			if (( cur > pre_count )); then
				sleep 0.5
				return 0
			fi
			sleep 0.5
		done
		echo "WARN: scn_send timed out waiting for turn completion ('$1')" >&2
	fi
}

scn_send_keys() {
	# scn_send_keys Escape   (pass tmux key names, no Enter appended)
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" "$@"
}

scn_capture() {
	# Save the entire scrollback to PANE_LOG, then stream to stdout.
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
	cat "$PANE_LOG"
}

scn_wait_for() {
	# scn_wait_for "regex" timeout_seconds
	# Polls capture-pane until regex matches OR timeout.
	local pat="$1"
	local timeout="${2:-30}"
	local start=$SECONDS
	while ((SECONDS - start < timeout)); do
		"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG" 2>/dev/null || true
		if grep -qE "$pat" "$PANE_LOG"; then return 0; fi
		sleep 0.5
	done
	echo "TIMEOUT waiting for: $pat" >&2
	return 1
}

# Bridge log helpers — extract cache stats per turn from the debug log.
scn_cache_profile() {
	# Print the (creation, read) tuple per usage line in the bridge log.
	# Last usage entry per turn is the "final" usage (post-stream completion).
	grep -E "\"msg\":\"usage:" "$BRIDGE_LOG" | awk '{
		for (i = 1; i <= NF; i++) {
			if ($i ~ /^cacheRead=/) { gsub(/^cacheRead=/, "", $i); read = $i }
			if ($i ~ /^cacheWrite=/) { gsub(/^cacheWrite=/, "", $i); write = $i }
		}
		printf "  creation=%s read=%s\n", write, read
	}'
}

scn_session_count() {
	# How many distinct CC session_ids did the bridge cache during this run?
	# Use a single substitution to avoid the `0\n0` artifact from
	# `pipe-with-grep | ... || echo 0` under pipefail.
	local n
	n=$(grep -oE "caching session=[a-f0-9]+" "$BRIDGE_LOG" 2>/dev/null | sort -u | wc -l | tr -d ' \n' || true)
	echo "${n:-0}"
}

# Helper: count regex matches, sanitizing output to a single integer.
scn_grep_count() {
	# scn_grep_count "<regex>" "<file>"
	# grep -c returns 1 when no matches — under set -euo pipefail this
	# would abort the whole pipeline if combined with `| head | tr || echo 0`
	# (the `|| echo 0` runs after a partial "0" was already on stdout,
	# producing "0\n0"). Single-call form avoids the issue.
	local n
	n=$(grep -cE "$1" "$2" 2>/dev/null || true)
	echo "${n:-0}"
}

scn_pass() { echo "  PASS: $1"; }
scn_fail() { echo "  FAIL: $1"; SCN_FAILED=1; }

# Extract the model's response text to a specific user prompt by looking at
# the pane log for the prompt line, then capturing lines that follow until
# the next visual separator (blank line followed by separator) or another
# prompt. This lets coherence assertions check ONLY what the model said in
# response to the probe, not the entire pane.
#
# Usage: scn_probe_response "<prompt-substring>" -> writes response text to stdout
scn_probe_response() {
	local prompt_marker="$1"
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -3000 > "$PANE_LOG"
	# Find the LAST occurrence of the prompt and emit lines after it that
	# look like model output (skip pi UI separators).
	awk -v pat="$prompt_marker" '
		BEGIN { capture = 0 }
		# When we hit the prompt line, start a new capture window.
		index($0, pat) > 0 { buf = ""; capture = 1; next }
		# Stop capturing if we hit a clear visual separator (long line of ─) or new prompt
		capture && /^─{20,}/ { capture = 0 }
		capture { buf = buf "\n" $0 }
		END { print buf }
	' "$PANE_LOG"
}

# Assert: the model response to <prompt-substring> contains a positive
# pattern AND does NOT contain a negative pattern. This avoids false-passes
# where the negative reply ("I don't know", "I wasn't interrupted") happens
# to contain the same words as the topic.
scn_assert_response() {
	# scn_assert_response "<prompt-substring>" "<positive-regex>" "<negative-regex>" "<descr>"
	local prompt="$1"; shift
	local positive="$1"; shift
	local negative="$1"; shift
	local descr="$1"
	local resp
	resp=$(scn_probe_response "$prompt")
	if [[ -z "$resp" ]]; then
		scn_fail "$descr — no response captured for prompt"
		return
	fi
	if echo "$resp" | grep -qiE "$negative"; then
		scn_fail "$descr — model gave a NEGATIVE response: '$(echo "$resp" | grep -iE "$negative" | head -1 | tr -d '\n' | cut -c1-120)'"
		return
	fi
	if echo "$resp" | grep -qiE "$positive"; then
		scn_pass "$descr — model affirmed: '$(echo "$resp" | grep -iE "$positive" | head -1 | tr -d '\n' | cut -c1-120)'"
		return
	fi
	scn_fail "$descr — neither positive nor negative pattern matched"
}

# Each scenario script begins with `SCN_FAILED=0` and ends with
# `exit $SCN_FAILED`. scn_pass/scn_fail collect into that.

# ============================================================================
# pi-session-search project extensions to scenario-lib
# ============================================================================

# scn_setup_clean_home — call BEFORE scn_pi_start. Creates a temp HOME with an
# empty ~/.pi/session-search/ subtree, exports HOME so pi/session-search write
# into the temp area. Stores the dir in $SCN_TEMP_HOME for direct file
# assertions. Tear-down via scn_pi_stop will leave the dir behind for inspection
# (logged to stdout); to nuke after PASS, set SCN_PURGE_HOME=1.
scn_setup_clean_home() {
	# We do NOT override $HOME (it would break Claude Code SDK keychain auth used by
	# claude-bridge). Instead the extension honors PI_SESSION_SEARCH_HOME for state
	# isolation — introduced specifically so scenario tests can run under real $HOME.
	SCN_TEMP_HOME="$OUT_DIR/${1:-home}-$$"
	rm -rf "$SCN_TEMP_HOME"
	mkdir -p "$SCN_TEMP_HOME/digests" "$SCN_TEMP_HOME/index"
	export PI_SESSION_SEARCH_HOME="$SCN_TEMP_HOME"
	echo "  PI_SESSION_SEARCH_HOME=$SCN_TEMP_HOME (HOME unchanged; claude-bridge auth intact)"
}

scn_setup_session_search_config() {
	# scn_setup_session_search_config '{...}' — write digest.json into the isolated dir
	local config_json="$1"
	mkdir -p "$SCN_TEMP_HOME"
	printf '%s\n' "$config_json" > "$SCN_TEMP_HOME/digest.json"
}

scn_setup_embedder_config() {
	# scn_setup_embedder_config '{...}' — write config.json into the isolated dir
	local config_json="$1"
	mkdir -p "$SCN_TEMP_HOME"
	printf '%s\n' "$config_json" > "$SCN_TEMP_HOME/config.json"
}

scn_assert_pane_contains() {
	# scn_assert_pane_contains "<regex>" "<descr>"
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
	if grep -qE "$1" "$PANE_LOG"; then
		scn_pass "$2"
	else
		scn_fail "$2 — pane did not contain: $1"
	fi
}

scn_assert_pane_not_contains() {
	# scn_assert_pane_not_contains "<regex>" "<descr>"
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
	if grep -qE "$1" "$PANE_LOG"; then
		scn_fail "$2 — pane contained forbidden: $1"
	else
		scn_pass "$2"
	fi
}

scn_assert_file_exists() {
	if [[ -f "$1" ]]; then scn_pass "$2"; else scn_fail "$2 — file not found: $1"; fi
}

scn_assert_file_not_exists() {
	if [[ ! -f "$1" ]]; then scn_pass "$2"; else scn_fail "$2 — file should not exist: $1"; fi
}

scn_assert_file_contains() {
	# scn_assert_file_contains <file> <regex> <descr>
	if grep -qE "$2" "$1" 2>/dev/null; then
		scn_pass "$3"
	else
		scn_fail "$3 — file $1 did not contain: $2"
	fi
}

scn_wait_for_file() {
	# scn_wait_for_file <path> <timeout-seconds>
	local path="$1" timeout="${2:-10}"
	local start=$SECONDS
	while (( SECONDS - start < timeout )); do
		if [[ -f "$path" ]]; then return 0; fi
		sleep 0.5
	done
	return 1
}

# pi-session-search uses pi as the host. Override the scn_pi_start to load the
# repo's local extension build (./src/index.ts via tsx) instead of the default
# (which loads our repo as the bridge). Keep claude-bridge as provider so model
# calls (including digest LLM calls) work via cheap-class haiku.
scn_pi_start_session_search() {
	# Load this repo's extension via tsx (pi supports `pi -e <path>` for direct files
	# OR a directory containing package.json with `pi.extensions`).
	local extension_path="$REPO_DIR"  # repo dir; package.json declares extensions
	local extra_args=""
	if (( $# > 0 )); then extra_args="$*"; fi

	# Enable tmux extended keys on this private server (per pi-tui-scenario-tests skill).
	"${TMUX_CMD[@]}" set -g extended-keys on 2>/dev/null || true
	"${TMUX_CMD[@]}" set -g extended-keys-format csi-u 2>/dev/null || true

	# IMPORTANT: do NOT pass -ne. claude-bridge must auto-load (it lives in ~/.pi/agent/extensions/),
	# otherwise pi exits with `Unknown provider "claude-bridge"`. We additionally pass `-e $repo`
	# to ensure our local pi-session-search source is loaded; auto-discovery would otherwise pick
	# any installed copy of the same extension (none exists today, but be explicit).
	# Pass PI_SESSION_SEARCH_HOME (isolated session-search state) but keep $HOME alone
	# so claude-bridge keychain auth works.
	local extension_log="$OUT_DIR/${BRIDGE_LOG##*/}.ext.log"
	extension_log="${extension_log/.bridge.log/}"
	"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
		"cd '$SCENARIO_CWD' && PI_SESSION_SEARCH_HOME='${PI_SESSION_SEARCH_HOME:-}' PI_SESSION_SEARCH_DEBUG_DIGEST='${PI_SESSION_SEARCH_DEBUG_DIGEST:-}' CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
		 pi --no-session -e '$extension_path' --provider claude-bridge --model '$SCENARIO_MODEL' $extra_args 2>'$extension_log'"

	local deadline=$((SECONDS + 45))
	while (( SECONDS < deadline )); do
		if "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -50 2>/dev/null | grep -qE "\(claude-bridge\)"; then
			break
		fi
		sleep 0.5
	done
	sleep 2
}


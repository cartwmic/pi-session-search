#!/usr/bin/env bash
# Run all available scenario scripts and produce a summary.
# Each individual scenario is in scripts/run-scenario-s<N>.sh.
#
# Concurrency:
#   SCENARIO_PARALLEL=N   default 1 (sequential).
#                         Set >1 to run scenarios in parallel.
#   SCENARIO_TIMEOUT=N    per-script timeout in seconds (default 300).
#
# Each scenario gets its own private tmux server (via SCN_TMUX_SOCKET in
# scenario-lib.sh), so parallel runs don't interfere. Bridge logs and pane
# logs are namespaced by scenario name. Each scenario's pi process is
# scoped to its own tmux server — no cross-scenario `pkill` needed.
#
# Be aware of API rate limits when raising parallelism — most providers
# cap concurrent requests per account. SCENARIO_PARALLEL=4 is usually a
# safe default for haiku; opus may want 2.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/.test-output/scenarios"
mkdir -p "$RESULTS_DIR"

SUMMARY="$RESULTS_DIR/SUMMARY.md"
echo "# Scenario run — $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SUMMARY"
echo "" >> "$SUMMARY"

PER_SCRIPT_TIMEOUT="${SCENARIO_TIMEOUT:-300}"
MAX_CONCURRENCY="${SCENARIO_PARALLEL:-1}"

# Use gtimeout if available (macOS coreutils), else timeout, else nothing.
if command -v gtimeout >/dev/null 2>&1; then
	TIMEOUT_BIN=gtimeout
elif command -v timeout >/dev/null 2>&1; then
	TIMEOUT_BIN=timeout
else
	TIMEOUT_BIN=""
fi

# Run a single scenario. Each invocation gets a unique SCN_TMUX_SOCKET
# (combining its own PID with the scenario name), so even when this
# function runs in parallel via `&`, sockets never collide.
run_one() {
	local script="$1"
	local name="$2"
	local logfile="$RESULTS_DIR/${name}.run.log"
	local socket="pi-scn-${name}-$$"

	local rc=0
	if [[ -n "$TIMEOUT_BIN" ]]; then
		SCN_TMUX_SOCKET="$socket" "$TIMEOUT_BIN" --kill-after=10 "$PER_SCRIPT_TIMEOUT" "$script" > "$logfile" 2>&1
		rc=$?
	else
		SCN_TMUX_SOCKET="$socket" "$script" > "$logfile" 2>&1 || rc=$?
	fi

	# Best-effort cleanup of this scenario's private tmux server.
	tmux -L "$socket" kill-server 2>/dev/null || true

	if (( rc == 0 )); then
		echo "PASS|$name"
	elif (( rc == 124 )); then
		echo "TIMEOUT|$name"
	else
		echo "FAIL|$name|$rc"
	fi
}

# Collect scripts. Use bash 3.2-compatible read loop (mapfile is bash 4+,
# absent on stock macOS bash). Optionally filter by name prefixes via
# SCENARIO_FILTER (regex applied to the scenario short name).
SCRIPTS=()
while IFS= read -r line; do
	name="$(basename "$line" .sh | sed 's/^run-scenario-//')"
	if [[ -n "${SCENARIO_FILTER:-}" ]] && ! echo "$name" | grep -qE "$SCENARIO_FILTER"; then
		continue
	fi
	SCRIPTS+=("$line")
done < <(ls "$SCRIPT_DIR"/run-scenario-s*.sh 2>/dev/null | sort)
[[ ${#SCRIPTS[@]} -gt 0 ]] || { echo "No scenarios found in $SCRIPT_DIR"; exit 1; }

PASS=0
FAIL=0
TIMEOUT=0

if (( MAX_CONCURRENCY <= 1 )); then
	# Sequential
	for s in "${SCRIPTS[@]}"; do
		[[ -x "$s" ]] || continue
		name="$(basename "$s" .sh | sed 's/^run-scenario-//')"
		printf "%-30s " "$name"
		result=$(run_one "$s" "$name")
		case "$result" in
			PASS\|*)    echo "PASS"   ; ((PASS++))   ; echo "## $name — PASS"   >> "$SUMMARY" ;;
			TIMEOUT\|*) echo "TIMEOUT"; ((TIMEOUT++)); echo "## $name — TIMEOUT (>${PER_SCRIPT_TIMEOUT}s)" >> "$SUMMARY" ;;
			FAIL\|*)    echo "FAIL"   ; ((FAIL++))   ; echo "## $name — FAIL"   >> "$SUMMARY" ;;
		esac
		if [[ "$result" != PASS\|* ]]; then
			echo '```' >> "$SUMMARY"
			tail -40 "$RESULTS_DIR/${name}.run.log" >> "$SUMMARY"
			echo '```' >> "$SUMMARY"
		fi
		echo "" >> "$SUMMARY"
	done
else
	# Parallel with concurrency limit. Bash-3.2 compatible (no `wait -n`,
	# no associative arrays). Strategy: file-based completion signaling.
	# Each child writes $RESULTS_DIR/.<name>.done when its result is on
	# disk. The dispatcher polls for these files to detect free slots.
	# `kill -0` is NOT a reliable "still running" check for children:
	# zombies still pass kill -0 until reaped. Polling completion files
	# avoids that pitfall entirely.
	echo "Running with SCENARIO_PARALLEL=$MAX_CONCURRENCY"
	rm -f "$RESULTS_DIR/.summary-raw" "$RESULTS_DIR"/.*.done 2>/dev/null || true

	# Parallel arrays — same index in both = same scenario.
	RUNNING_PIDS=()
	RUNNING_NAMES=()

	reap_completed() {
		# Reap entries whose .done file has appeared. Doesn't block.
		local new_pids=() new_names=() i pid name result_line
		for ((i=0; i<${#RUNNING_PIDS[@]}; i++)); do
			pid="${RUNNING_PIDS[$i]}"
			name="${RUNNING_NAMES[$i]}"
			if [[ -f "$RESULTS_DIR/.${name}.done" ]]; then
				wait "$pid" 2>/dev/null || true
				result_line=$(cat "$RESULTS_DIR/.${name}.result" 2>/dev/null || echo "FAIL|$name|missing")
				rm -f "$RESULTS_DIR/.${name}.result" "$RESULTS_DIR/.${name}.done"
				case "$result_line" in
					PASS\|*)    PASS=$((PASS+1)) ;;
					TIMEOUT\|*) TIMEOUT=$((TIMEOUT+1)) ;;
					FAIL\|*)    FAIL=$((FAIL+1)) ;;
				esac
				printf "  done: %-25s %s\n" "$name" "${result_line%%|*}"
				echo "${result_line}" >> "$RESULTS_DIR/.summary-raw"
			else
				new_pids+=("$pid")
				new_names+=("$name")
			fi
		done
		# Reset arrays cleanly for bash 3.2.
		if [[ ${#new_pids[@]} -gt 0 ]]; then
			RUNNING_PIDS=("${new_pids[@]}")
			RUNNING_NAMES=("${new_names[@]}")
		else
			RUNNING_PIDS=()
			RUNNING_NAMES=()
		fi
	}

	for s in "${SCRIPTS[@]}"; do
		[[ -x "$s" ]] || continue
		name="$(basename "$s" .sh | sed 's/^run-scenario-//')"
		while (( ${#RUNNING_PIDS[@]} >= MAX_CONCURRENCY )); do
			sleep 2
			reap_completed
		done

		(
			r=$(run_one "$s" "$name")
			echo "$r" > "$RESULTS_DIR/.${name}.result"
			# Touch .done LAST — appearance is the dispatcher's reap signal.
			: > "$RESULTS_DIR/.${name}.done"
		) &
		pid=$!
		RUNNING_PIDS+=("$pid")
		RUNNING_NAMES+=("$name")
		printf "  start: %-25s pid=%s\n" "$name" "$pid"
	done

	# Drain remaining.
	while (( ${#RUNNING_PIDS[@]} > 0 )); do
		sleep 2
		reap_completed
	done

	# Write summary in scenario name (alphabetical) order.
	for s in "${SCRIPTS[@]}"; do
		name="$(basename "$s" .sh | sed 's/^run-scenario-//')"
		result_line=$(grep -E "^[A-Z]+\|${name}(\||$)" "$RESULTS_DIR/.summary-raw" 2>/dev/null | head -1 || echo "MISSING|$name")
		case "$result_line" in
			PASS\|*)    echo "## $name — PASS"    >> "$SUMMARY" ;;
			TIMEOUT\|*) echo "## $name — TIMEOUT" >> "$SUMMARY" ;;
			FAIL\|*)    echo "## $name — FAIL"    >> "$SUMMARY" ;;
			*)          echo "## $name — $result_line" >> "$SUMMARY" ;;
		esac
		if [[ "$result_line" != PASS\|* ]]; then
			echo '```' >> "$SUMMARY"
			tail -40 "$RESULTS_DIR/${name}.run.log" 2>/dev/null >> "$SUMMARY" || true
			echo '```' >> "$SUMMARY"
		fi
		echo "" >> "$SUMMARY"
	done
	rm -f "$RESULTS_DIR/.summary-raw"
fi

echo ""
echo "Passed: $PASS  Failed: $FAIL  Timeout: $TIMEOUT"
echo "Results: $SUMMARY"
[[ $((FAIL + TIMEOUT)) -eq 0 ]]

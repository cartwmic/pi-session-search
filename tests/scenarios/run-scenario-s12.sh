#!/usr/bin/env bash
# Scenario S12 — /digest:backfill --dry-run prints cost estimate
#
# Goal: Catches regressions where --dry-run silently exits, fails to enumerate
#       session files, or omits the required cost / accuracy lines from output.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s12"

trap 'scn_pi_stop' EXIT

scn_setup_clean_home "s12"

# digest.json so resolvedDigestModel resolves (required by /digest:backfill).
# debounceSeconds=600 keeps the live lifecycle quiet during the test.
scn_setup_session_search_config '{"provider":"claude-bridge","model":"claude-haiku-4-5","debounceSeconds":600}'

# ── Fixture session JSONLs ────────────────────────────────────────────────────
# discoverSessionFiles walks $HOME/.pi/agent/sessions/ recursively, so any
# subdirectory works.  We use a "fixtures" dir to avoid encoding concerns.
FIXTURES_DIR="$HOME/.pi/agent/sessions/fixtures"
mkdir -p "$FIXTURES_DIR"

# Each file needs:
#   - First line: {"type":"session","id":"<uuid>",...}  (for readSessionId)
#   - Enough bytes to register a non-trivial size estimate (target 600–800 B)
# No digest file must exist for these IDs (clean home guarantees that).

cat > "$FIXTURES_DIR/2026-01-01T00-00-00-000Z_fixture-session-aaa1.jsonl" <<'JSONL'
{"type":"session","version":3,"id":"fixture-session-aaa1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/fixture-a"}
{"type":"user","timestamp":"2026-01-01T00:00:01.000Z","content":"Can you explain how garbage collection works in modern JavaScript engines?"}
{"type":"assistant","timestamp":"2026-01-01T00:00:05.000Z","content":"JavaScript engines like V8 use a generational garbage collector. Objects are first allocated in the young generation (called the nursery or new-space), which is collected frequently using a minor GC. Long-lived objects get promoted to the old generation, collected less often via a major (mark-and-sweep) GC. This design reduces pause times by focusing frequent short collections on short-lived objects."}
{"type":"user","timestamp":"2026-01-01T00:00:10.000Z","content":"What is incremental marking and why does it help?"}
{"type":"assistant","timestamp":"2026-01-01T00:00:15.000Z","content":"Incremental marking breaks the mark phase into small slices interleaved with JavaScript execution. Instead of one long stop-the-world pause to trace all live objects, the GC advances the mark frontier a little at a time. This keeps pause times short and more predictable, which is critical for smooth animations and responsive UIs. V8 introduced incremental marking in 2012 to address 100ms+ pauses in large applications."}
JSONL

cat > "$FIXTURES_DIR/2026-01-02T00-00-00-000Z_fixture-session-bbb2.jsonl" <<'JSONL'
{"type":"session","version":3,"id":"fixture-session-bbb2","timestamp":"2026-01-02T00:00:00.000Z","cwd":"/tmp/fixture-b"}
{"type":"user","timestamp":"2026-01-02T00:00:01.000Z","content":"Summarize the differences between TCP and UDP in networking."}
{"type":"assistant","timestamp":"2026-01-02T00:00:06.000Z","content":"TCP (Transmission Control Protocol) is a connection-oriented protocol that guarantees delivery, ordering, and error correction through a three-way handshake, acknowledgements, and retransmissions. It is ideal for applications like HTTP, FTP, and email where reliability matters. UDP (User Datagram Protocol) is connectionless and provides no delivery guarantees or ordering, but has much lower overhead. It is preferred for latency-sensitive applications such as video streaming, VoIP, and online games where occasional packet loss is acceptable."}
{"type":"user","timestamp":"2026-01-02T00:00:12.000Z","content":"When would you use QUIC instead?"}
{"type":"assistant","timestamp":"2026-01-02T00:00:18.000Z","content":"QUIC (Quick UDP Internet Connections) is used when you want TCP-like reliability with lower latency, especially in lossy or high-latency networks. It eliminates head-of-line blocking at the transport layer (unlike TCP/TLS), supports 0-RTT connection resumption, and multiplexes streams independently so one lost packet does not stall others. HTTP/3 is built on QUIC. It is particularly beneficial for mobile clients that switch between networks frequently."}
JSONL

# Verify files are present and non-trivially sized.
for f in "$FIXTURES_DIR"/*.jsonl; do
    SIZE=$(wc -c < "$f" | tr -d ' ')
    echo "  fixture: $(basename "$f") — ${SIZE} bytes"
done

# ── Start pi and run the dry-run ─────────────────────────────────────────────
scn_pi_start_session_search

"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/digest:backfill --dry-run"
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

# runBackfillDryRun emits a single multi-line notify containing:
#   "Backfill dry run — N un-digested session(s)"
#   "  Input cost:  $..."
#   "  Total est.:  $..."
#   "  Note: accuracy may vary ±30–50% depending on session size distribution."
# Allow 30s for the synchronous enumeration + notify.
scn_wait_for "[Dd]ry run|accuracy|\\$[0-9]" 30 \
    || scn_fail "S12: dry-run output not seen within 30s"

echo "==== S12 results ===="

# Cost / total line
scn_assert_pane_contains \
    "[Ii]nput cost|\\\$[0-9]|[Tt]otal est" \
    "S12: pane contains cost estimate line"

# Accuracy disclaimer — exact string from runBackfillDryRun
scn_assert_pane_contains \
    "accuracy|\\±30" \
    "S12: pane contains accuracy disclaimer"

# Should not report zero sessions (we placed 2 fixture files)
scn_assert_pane_not_contains \
    "no un-digested sessions found" \
    "S12: fixture sessions were discovered"

echo "===================="
exit $SCN_FAILED

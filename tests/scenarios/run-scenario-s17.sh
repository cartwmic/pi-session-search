#!/usr/bin/env bash
# Scenario S17 — /find-session foo opens the TUI overlay and renders a card
# for the matching session.
#
# Goal: The /find-session slash command opens a TUI overlay (FindSessionOverlay),
# runs a search for the supplied query, and renders results as cards with a
# "▶ " selection marker. Regression: if the command registration, search
# dispatch, or overlay render is broken, the user sees nothing (empty pane).
#
# The query line "> foo" is distinctive overlay UI. The "▶ " prefix on the first
# result card is the selected-item marker. Both must appear in the pane.
#
# Note: /find-session is a slash command — no model call is made. Use
# scn_send --no-wait and poll the pane for overlay elements directly.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s17"

# ─── Mock embedder server ─────────────────────────────────────────────────────
SCN_EMBED_PORT=$(python3 -c "
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
p = s.getsockname()[1]
s.close()
print(p)
")

python3 -c "
import json, sys
from http.server import HTTPServer, BaseHTTPRequestHandler

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        if self.path != '/v1/embeddings':
            self.send_response(404)
            self.end_headers()
            return
        n = int(self.headers.get('Content-Length', 0))
        b = json.loads(self.rfile.read(n))
        texts = b.get('input', [])
        data = [{'embedding': [float(i + 1) / 10.0, 0.5, 0.3], 'index': i}
                for i, _ in enumerate(texts)]
        r = json.dumps({'data': data, 'model': 'mock'}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(r)))
        self.end_headers()
        self.wfile.write(r)

port = int(sys.argv[1])
HTTPServer(('127.0.0.1', port), H).serve_forever()
" "$SCN_EMBED_PORT" &
SCN_EMBED_PID=$!
sleep 0.5

trap 'scn_pi_stop; kill "$SCN_EMBED_PID" 2>/dev/null || true' EXIT

scn_setup_clean_home "s17"

# ─── Fixtures: two sessions — one matches "foo", one does not ────────────────
SESSION_DIR="$SCN_TEMP_HOME/test-sessions"
mkdir -p "$SESSION_DIR"

# Session A: body contains "foo" → FTS match
SESSION_A_ID="eeeeeeee-eeee-4eee-eeee-000000000017"
cat > "$SESSION_DIR/fixture-foo.jsonl" << 'JSONL'
{"type":"session","version":3,"id":"eeeeeeee-eeee-4eee-eeee-000000000017","timestamp":"2026-01-05T07:00:00.000Z","cwd":"/tmp/test-s17"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-05T07:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Analyze the foo component architecture"}]}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-05T07:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"The foo component follows a modular design pattern."}]}}
JSONL

cat > "$SCN_TEMP_HOME/digests/${SESSION_A_ID}.json" << 'JSON'
{
  "schemaVersion": 1,
  "body": "Detailed analysis of the foo component architecture and its internal dependencies. We reviewed the foo module graph and identified opportunities for splitting the foo package into smaller units.",
  "headline": "Project alpha foo analysis",
  "topics": ["architecture", "foo"],
  "generatedAt": "2026-01-05T07:05:00.000Z",
  "modelId": "claude-bridge/claude-haiku-4-5",
  "inputTokenCount": 110,
  "cost": 0.001
}
JSON

# Session B: body does not contain "foo" → no FTS match
SESSION_B_ID="ffffffff-ffff-4fff-ffff-000000000017"
cat > "$SESSION_DIR/fixture-other.jsonl" << 'JSONL'
{"type":"session","version":3,"id":"ffffffff-ffff-4fff-ffff-000000000017","timestamp":"2026-01-06T07:00:00.000Z","cwd":"/tmp/test-s17"}
{"type":"message","id":"m5","parentId":null,"timestamp":"2026-01-06T07:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Unrelated work on database migrations"}]}}
{"type":"message","id":"m6","parentId":"m5","timestamp":"2026-01-06T07:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Here is the migration plan for the database schema."}]}}
JSONL

cat > "$SCN_TEMP_HOME/digests/${SESSION_B_ID}.json" << 'JSON'
{
  "schemaVersion": 1,
  "body": "Session about database migration planning and schema evolution. Discussed strategies for zero-downtime schema changes and rollback procedures for the production database.",
  "headline": "Database migration planning",
  "topics": ["database", "migrations"],
  "generatedAt": "2026-01-06T07:05:00.000Z",
  "modelId": "claude-bridge/claude-haiku-4-5",
  "inputTokenCount": 100,
  "cost": 0.001
}
JSON

# ─── Config ──────────────────────────────────────────────────────────────────
cat > "$SCN_TEMP_HOME/config.json" << EOF
{
  "embedder": {
    "baseUrl": "http://127.0.0.1:${SCN_EMBED_PORT}",
    "model": "mock",
    "apiKey": "test",
    "dimensions": 3
  },
  "extraSessionDirs": ["$SESSION_DIR"]
}
EOF

scn_setup_session_search_config '{"provider":"claude-bridge","model":"claude-haiku-4-5","debounceSeconds": 0}'

# ─── Start pi ────────────────────────────────────────────────────────────────
scn_pi_start_session_search

# Wait for sync: both sessions get embedded + FTS-indexed.
sleep 3

# ─── Issue /find-session overlay command ──────────────────────────────────────
# Slash command: no model call, no bridge-log wait. Send --no-wait.
# The command opens FindSessionOverlayComponent with initial query "foo",
# immediately kicks off runSearch() (via Promise.resolve().then(...)).
scn_send --no-wait "/find-session foo"

# Wait for overlay to render + search to complete (debounce=200ms default)
sleep 3

echo "==== S17 results ===="

# ── Mechanical: overlay query bar must be visible ─────────────────────────────
scn_assert_pane_contains "> foo" \
    "S17: overlay query bar shows '> foo'"

# ── Mechanical: selected-card marker must be present ─────────────────────────
# The first result card has "▶ " prefix (selected=true in renderCard).
scn_assert_pane_contains "▶" \
    "S17: overlay has a selected result card (▶ marker)"

# ── Mechanical: matching session headline should appear ───────────────────────
scn_assert_pane_contains "foo" \
    "S17: overlay result references the foo session"

echo "===================="
exit $SCN_FAILED

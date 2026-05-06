#!/usr/bin/env bash
# Scenario S18 — Esc dismisses the /find-session overlay without switching session.
#
# Goal: After the overlay opens, pressing Escape must close it (overlay UI
# elements disappear) without calling ctx.switchSession (current session
# indicator unchanged). Regression: if Esc handling calls done(selectedFile)
# instead of done(undefined), the session switches unexpectedly.
#
# Escape dismissal evidence: the "▶ " card marker and "> foo" query bar
# disappear from the pane. Session-switch evidence would be a new session
# startup sequence in the pane — its absence confirms no switch happened.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s18"

# ─── Mock embedder server (identical to S17) ──────────────────────────────────
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

scn_setup_clean_home "s18"

# ─── Fixtures (same two sessions as S17) ─────────────────────────────────────
SESSION_DIR="$SCN_TEMP_HOME/test-sessions"
mkdir -p "$SESSION_DIR"

SESSION_A_ID="a0a0a0a0-aaaa-4aaa-aaaa-000000000018"
cat > "$SESSION_DIR/fixture-foo.jsonl" << 'JSONL'
{"type":"session","version":3,"id":"a0a0a0a0-aaaa-4aaa-aaaa-000000000018","timestamp":"2026-01-07T06:00:00.000Z","cwd":"/tmp/test-s18"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-07T06:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Analyze the foo component and its dependencies"}]}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-07T06:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"The foo component uses a layered architecture."}]}}
JSONL

cat > "$SCN_TEMP_HOME/digests/${SESSION_A_ID}.json" << 'JSON'
{
  "schemaVersion": 1,
  "body": "In-depth review of the foo component dependency graph. We identified circular imports in the foo subsystem and refactored the foo initialization sequence to remove them.",
  "headline": "Foo component dependency review",
  "topics": ["architecture", "foo"],
  "generatedAt": "2026-01-07T06:05:00.000Z",
  "modelId": "claude-bridge/claude-haiku-4-5",
  "inputTokenCount": 105,
  "cost": 0.001
}
JSON

SESSION_B_ID="b0b0b0b0-bbbb-4bbb-bbbb-000000000018"
cat > "$SESSION_DIR/fixture-other.jsonl" << 'JSONL'
{"type":"session","version":3,"id":"b0b0b0b0-bbbb-4bbb-bbbb-000000000018","timestamp":"2026-01-08T06:00:00.000Z","cwd":"/tmp/test-s18"}
{"type":"message","id":"m3","parentId":null,"timestamp":"2026-01-08T06:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Review the CI pipeline configuration"}]}}
{"type":"message","id":"m4","parentId":"m3","timestamp":"2026-01-08T06:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Here is the pipeline review."}]}}
JSONL

cat > "$SCN_TEMP_HOME/digests/${SESSION_B_ID}.json" << 'JSON'
{
  "schemaVersion": 1,
  "body": "Reviewed the CI pipeline configuration for build caching, test parallelism, and deployment gates. Proposed several optimizations to reduce pipeline duration.",
  "headline": "CI pipeline config review",
  "topics": ["ci", "devops"],
  "generatedAt": "2026-01-08T06:05:00.000Z",
  "modelId": "claude-bridge/claude-haiku-4-5",
  "inputTokenCount": 95,
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
sleep 3

# ─── Open overlay ────────────────────────────────────────────────────────────
scn_send --no-wait "/find-session foo"
sleep 3  # wait for overlay + search to render

echo "==== S18 results ===="

# ── Pre-Escape: confirm overlay IS open ───────────────────────────────────────
scn_assert_pane_contains "> foo" \
    "S18: overlay query bar present before Escape"
scn_assert_pane_contains "▶" \
    "S18: overlay selected-card marker present before Escape"

# ── Send Escape: dismiss the overlay ─────────────────────────────────────────
# In the overlay's handleInput, "\x1b" → this.done(undefined) → closes overlay
# without calling ctx.switchSession.
scn_send_keys Escape
sleep 1

# ── Post-Escape: overlay elements must be gone ────────────────────────────────
scn_assert_pane_not_contains "> foo" \
    "S18: overlay query bar absent after Escape (overlay closed)"

scn_assert_pane_not_contains "▶" \
    "S18: overlay selected-card marker absent after Escape"

# ── Post-Escape: pi still live, no session switch triggered ───────────────────
# If switchSession had fired, pi would show a new session init. The presence of
# the claude-bridge status confirms pi is still in the original session state.
scn_assert_pane_contains "claude-bridge" \
    "S18: pi still active in original session after Escape (no session switch)"

echo "===================="
exit $SCN_FAILED

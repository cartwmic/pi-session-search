#!/usr/bin/env bash
# Scenario S16 — session_search results in digest-hybrid include a Topics line.
#
# Goal: When session_search returns a result in digest-hybrid, the rendered output
# must include "Topics: foo, bar" (or equivalent topic listing). Regression: if
# the digest-hybrid result branch is missing or topicsLine is never included, the
# user sees a raw session summary without topic context.
#
# Requires a working embedder so the session is FTS-indexed (buildContent uses
# digest.body in digest-hybrid, which contains "baz"). A local Python mock server
# returns deterministic embeddings; the actual vectors don't matter — FTS finds
# "baz" and the RRF fusion surfaces the session.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s16"

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
sleep 0.5  # let server bind

trap 'scn_pi_stop; kill "$SCN_EMBED_PID" 2>/dev/null || true' EXIT

scn_setup_clean_home "s16"

# ─── Fixture: one session with topics ["foo","bar"] and body containing "baz" ─
SESSION_DIR="$SCN_TEMP_HOME/test-sessions"
mkdir -p "$SESSION_DIR"

SESSION_ID="dddddddd-dddd-4ddd-dddd-000000000016"
cat > "$SESSION_DIR/fixture-baz.jsonl" << 'JSONL'
{"type":"session","version":3,"id":"dddddddd-dddd-4ddd-dddd-000000000016","timestamp":"2026-01-04T08:00:00.000Z","cwd":"/tmp/test-s16"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-04T08:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Help me debug the baz authentication middleware"}]}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-04T08:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Let us look at the baz middleware configuration."}]}}
JSONL

cat > "$SCN_TEMP_HOME/digests/${SESSION_ID}.json" << 'JSON'
{
  "schemaVersion": 1,
  "body": "This session involved debugging the baz authentication middleware layer. We identified a token validation edge case that caused intermittent failures in the baz request pipeline and fixed the error handling logic.",
  "headline": "Debugging baz middleware auth",
  "topics": ["foo", "bar"],
  "generatedAt": "2026-01-04T08:05:00.000Z",
  "modelId": "claude-bridge/claude-haiku-4-5",
  "inputTokenCount": 120,
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

# Wait for sync: mock server embeds the session, FTS indexes digest.body.
# "Indexing 1 sessions..." → "Sessions: +1 (1 total)"
sleep 2

# ─── Turn: search for "baz" ───────────────────────────────────────────────────
# FTS finds the session (body contains "baz"). session_search renders the
# digest-hybrid result branch which includes "Topics: foo, bar".
scn_send "search sessions for baz"

echo "==== S16 results ===="

# ── Mechanical: topics line must appear ───────────────────────────────────────
scn_assert_pane_contains "Topics:" \
    "S16: Topics: line present in digest-hybrid search result"

# ── Mechanical: specific topics values ───────────────────────────────────────
scn_assert_pane_contains "foo" \
    "S16: topic foo present in result"
scn_assert_pane_contains "bar" \
    "S16: topic bar present in result"

echo "===================="
exit $SCN_FAILED

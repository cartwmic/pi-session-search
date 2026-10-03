#!/usr/bin/env python3
"""Drive real Pi RPC, a slash command, digest dispatch, worker index and search."""
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time

repo = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="pi-session-search-blackbox-") as temp:
    root = Path(temp)
    base = root / "search"
    sessions = root / "sessions" / "--tmp-fixture--"
    base.mkdir()
    sessions.mkdir(parents=True)
    (root / "archive").mkdir()
    (base / "digest.json").write_text(json.dumps({"provider": "sync-fixture", "model": "dummy", "debounceSeconds": 600}))
    fixture = [
        {"type": "session", "version": 3, "id": "fixture-cobalt", "timestamp": "2026-01-15T10:00:00Z", "cwd": "/tmp/fixture"},
        {"type": "message", "id": "m1", "parentId": None, "timestamp": "2026-01-15T10:00:01Z", "message": {"role": "user", "content": "Validate the cobalt migration parser fixture."}},
    ]
    (sessions / "fixture.jsonl").write_text("\n".join(map(json.dumps, fixture)) + "\n")
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(root / "agent"), PI_OFFLINE="1",
               PI_SESSION_DIR=str(root / "sessions"), PI_SESSION_ARCHIVE_DIR=str(root / "archive"),
               PI_SESSION_SEARCH_HOME=str(base), PI_SESSION_SEARCH_DEBUG="0")
    command = ["pi", "-ne", "-ns", "-np", "-nc", "--no-themes", "--no-session", "--mode", "rpc",
               "-e", str(repo / "tests/blackbox/provider.ts"), "-e", str(repo),
               "--provider", "sync-fixture", "--model", "dummy", "--tools", "session_search"]
    print("COMMAND:", " ".join(command), flush=True)
    with (root / "stderr.log").open("w+") as errors:
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
                                text=True, env=env, cwd=root)
        lines = queue.Queue()

        def read_stdout():
            # readline may prefetch several lines; selecting the underlying fd
            # would miss lines already buffered by TextIOWrapper.
            for line in proc.stdout:
                lines.put(line)
            lines.put(None)

        reader = threading.Thread(target=read_stdout, daemon=True)
        reader.start()

        def send(message):
            proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()

        def receive_until(predicate, timeout=30):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    line = lines.get(timeout=0.2)
                except queue.Empty:
                    continue
                if line is None:
                    break
                print(line.rstrip(), flush=True)
                message = json.loads(line)
                if predicate(message):
                    return message
            errors.seek(0)
            raise RuntimeError("Pi did not complete: " + errors.read())

        try:
            # Same slash-command path as a user; this generates a digest via the dummy host provider.
            send({"id": "backfill", "type": "prompt", "message": "/session:backfill"})
            response = receive_until(lambda m: m.get("type") == "response" and m.get("id") == "backfill")
            assert response.get("success"), response
            deadline = time.monotonic() + 30
            while not (base / "digests/fixture-cobalt.json").exists():
                assert time.monotonic() < deadline, "digest was not generated"
                time.sleep(0.05)
            # Confirm indexing/embedding completed before driving the agent's search.
            while True:
                index = base / "index/session-index.json"
                if index.exists():
                    entries = json.loads(index.read_text())["sessions"]
                    if entries.get("fixture-cobalt", {}).get("embedding"):
                        break
                assert time.monotonic() < deadline, "digest did not reach the worker index"
                time.sleep(0.05)
            send({"id": "search", "type": "prompt", "message": "Find the cobalt fixture session."})
            ended = receive_until(lambda m: m.get("type") == "agent_end")
            assert "BLACKBOX PASS" in json.dumps(ended), ended
            print((base / "backend.log").read_text(), flush=True)
            print("BLACKBOX PASS: generated digest, embedded in worker, searched through Pi, expected fixture returned.", flush=True)
        finally:
            proc.stdin.close()
            try:
                exit_code = proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.terminate()
                exit_code = proc.wait(timeout=10)
            reader.join(timeout=1)
            errors.seek(0)
            stderr = errors.read()
            if stderr:
                print("STDERR:", stderr, flush=True)
        assert exit_code == 0, f"Pi exit code {exit_code}"

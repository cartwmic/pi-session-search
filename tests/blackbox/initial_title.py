#!/usr/bin/env python3
"""Drive real Pi RPC: the first prompt names the session before the agent finishes."""
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time

repo = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="pi-session-search-title-") as temp:
    root = Path(temp)
    base = root / "search"
    base.mkdir()
    (root / "sessions").mkdir()
    (root / "archive").mkdir()
    # The digest model comes from config; the agent runs on a different model.
    (base / "digest.json").write_text(json.dumps({"provider": "title-fixture", "model": "digester", "debounceSeconds": 600}))
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(root / "agent"), PI_OFFLINE="1",
               PI_SESSION_DIR=str(root / "sessions"), PI_SESSION_ARCHIVE_DIR=str(root / "archive"),
               PI_SESSION_SEARCH_HOME=str(base), PI_SESSION_SEARCH_DEBUG="0")
    command = ["pi", "-ne", "-ns", "-np", "-nc", "--no-themes", "--no-session", "--mode", "rpc",
               "-e", str(repo / "tests/blackbox/initial_title_provider.ts"), "-e", str(repo),
               "--provider", "title-fixture", "--model", "agent", "--no-tools"]
    trace = base / "backend.log"
    with (root / "stderr.log").open("w+") as errors:
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
                                text=True, env=env, cwd=root)
        lines = queue.Queue()
        threading.Thread(target=lambda: ([lines.put(l) for l in proc.stdout], lines.put(None)), daemon=True).start()
        seen = []

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
                message = json.loads(line)
                seen.append(message.get("type"))
                if predicate(message):
                    return message
            errors.seek(0)
            raise RuntimeError("Pi did not complete: " + errors.read())

        def session_name():
            send({"id": "state", "type": "get_state"})
            return receive_until(lambda m: m.get("id") == "state")["data"].get("sessionName")

        def wait_name(expected, timeout=30):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                name = session_name()
                if name == expected:
                    return
                time.sleep(0.1)
            raise AssertionError(f"session name {name!r} != {expected!r}; trace={trace.read_text() if trace.exists() else ''}")

        try:
            assert session_name() is None
            send({"id": "p1", "type": "prompt", "message": "Please fix the cobalt parser that drops trailing commas"})
            assert receive_until(lambda m: m.get("id") == "p1").get("success")
            wait_name("Fix cobalt parser trailing commas")
            assert "agent_end" not in seen, "named only after the agent finished"
            print("PASS: session named from first prompt while the agent is still running")

            (base / "release-agent").touch()
            receive_until(lambda m: m.get("type") == "agent_end")
            wait_name("Digest headline")
            print("PASS: first digest headline replaced the initial title")

            send({"id": "p2", "type": "prompt", "message": "now also handle tabs"})
            assert receive_until(lambda m: m.get("id") == "p2").get("success")
            receive_until(lambda m: m.get("type") == "agent_end")
            log = trace.read_text()
            print(log)
            assert log.count("TITLE") == 1, "title requested more than once"
            assert "TITLE model=digester prompt=first" in log, "title did not use the configured digest model"
            print("BLACKBOX PASS")
        finally:
            proc.terminate()
            proc.wait(timeout=10)

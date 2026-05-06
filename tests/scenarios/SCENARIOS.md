# pi-session-search — TUI Scenario Tests

End-to-end scenarios validating the `add-digest-driven-indexing` change against a real Pi process. Each scenario follows the standard harness pattern (private tmux server, completion-signal-based wait, two-tier mechanical + coherence assertions).

## Charter

- **Mode detection is non-negotiable.** Wrong mode = wrong index = wrong embeddings vs digests.
- **Silent failures are the threat.** "We didn't crash" passes a unit test but a user sees a broken `/digest:show`. Every scenario that touches user-visible surfaces must have a probe that proves the right thing happened.
- **Real Pi process, real model.** Digest LLM calls go through `claude-bridge` against a cheap-class model (haiku) so generation actually fires.
- **Isolated HOME per scenario.** Each scenario runs against a fresh `~/.pi/session-search/` (set via `scn_setup_clean_home`) so digest files, indexes, and configs don't leak between runs.

## Common test config

| Knob | Value |
|---|---|
| Provider | `claude-bridge` |
| Model | `claude-bridge/claude-haiku-4-5` (cheap, fast) |
| Digest model | resolved from priority list (haiku auto-selected) |
| `debounceSeconds` | `0` (digests fire immediately on `agent_end`) |
| HOME | per-scenario tempdir under `tests/scenarios/.test-output/` |
| Extension load | `pi -ne -e <repo>` |

## Scenario catalog (21 total)

### Mode detection (3)

- **S01 — fts-raw mode loads cleanly when no embedder configured.** Empty `~/.pi/session-search/`. Pi starts. Run `session_list` (via "list my sessions" prompt or direct tool). Assert: extension loaded, no notify error, mode is fts-raw (no embedder warning).
- **S02 — hybrid-raw mode when embedder configured but no digest model.** Write `config.json` with embedder section. Pi starts. Assert: no "digest mode unavailable" notify required (digestRequested === false). Index loads.
- **S03 — digest-mode when embedder + cheap model both available.** Write `config.json` (embedder) + `digest.json` (default). Pi starts. The model-resolver should find haiku. Assert: digest lifecycle installed, no fallback notify.

### Lifecycle and digest generation (4)

- **S04 — agent_end with debounceSeconds=0 fires generateDigest immediately on first turn.** Send a real conversation prompt. After response, assert: `~/.pi/session-search/digests/<id>.json` exists, `<id>.state.json` exists. Headline matches `pi.getSessionName()` via on-screen "Session: …" indicator if visible.
- **S05 — session_compact bypasses debounce.** Send a few turns. Issue `/compact`. Assert: digest written immediately even if debounce timer would have prevented agent_end-driven write.
- **S06 — session_shutdown aborts in-flight LLM call.** Send long prompt. While model is responding, exit pi (Ctrl-D when editor empty). Restart pi. Assert: no partial/corrupted digest file in tempdir.
- **S07 — state persists across restart.** Send a turn, write digest. Restart pi. Send a small follow-up turn. Assert: builder uses incremental mode (loadBuilderState restored anchors). Indirect assertion: the second digest's `inputTokenCount` is small (delta) not full conversation. Verifiable by inspecting the digest file's metadata.

### Slash commands (5)

- **S08 — `/digest:settings` creates global config.** Empty HOME. Run `/digest:settings`. Assert: `~/.pi/session-search/digest.json` now exists with defaults. Pane shows path + `/reload` instruction.
- **S09 — `/digest:show` with no digest yet shows fallback.** Pi just started, no digest written. Run `/digest:show`. Assert pane: `(no digest yet)`.
- **S10 — `/digest:update` after a turn writes digest + setSessionName.** Send a turn. Run `/digest:update`. Assert: digest file written. Pane notify: success message. Session name (footer or status) reflects digest.headline.
- **S11 — `/digest:rewrite` forces full re-summarize.** Have a digest. Run `/digest:rewrite`. Assert: digest file mtime updated; new digest body differs from prior; no incremental-mode metadata.
- **S12 — `/digest:backfill --dry-run` prints cost estimate.** Place 2-3 fixture session JSONLs in `~/.pi/agent/sessions/--<cwd>--/`. Run `/digest:backfill --dry-run`. Assert pane: input/output cost lines printed; total prefixed; "±30–50% accuracy" note.

### Render layer (4)

- **S13 — `session_list` in digest-mode shows headlines for digested + suffix for un-digested.** Set up digest-mode. Pre-place a digest file for one session. Pre-place un-digested fixture session JSONL. Send "list my sessions". Assert pane: digest's headline visible AND `(no digest — run /digest:update)` visible for the un-digested one.
- **S14 — `session_search` empty-state in digest-mode.** Empty index in digest-mode. Send "search sessions for foo". Assert pane: "Run /digest:backfill" message (NOT the "may still be building" message).
- **S15 — primer `before_agent_start` shows digest.headline.** Set up two old sessions, one with digest. Send any turn. Pane (or system prompt section) should show the digest's headline for the digested one and `truncate(firstUserMessage, 80)` for the un-digested one. Easiest probe: ask the model "what was the first session in your context about?" — answer should reference headline content.
- **S16 — `session_search` results in digest-mode show topics line.** Place a fixture digest with topics. Search for matching keyword. Assert pane: `Topics: foo, bar` line under the result title.

### Find-session overlay (2)

- **S17 — `/find-session foo` opens overlay with results.** Place 2-3 digests. Run `/find-session foo` matching one of them. Assert pane: card with headline + topics + body excerpt visible.
- **S18 — Esc dismisses overlay without switching session.** Open `/find-session`. Press Esc. Assert: overlay closed, `ctx.switchSession` not called (current session preserved — pane shows same session footer/status).

### Migration / config (2)

- **S19 — Legacy embedder config (`type: "bedrock"`) is refused with notify.** Write `config.json` with `embedder.type = "bedrock"` (legacy). Pi starts. Assert pane notify: "embedder configured but…" / "rerun /session-embeddings-setup". Mode detected: fts-raw (fallback).
- **S20 — Index v3 → v4 reset on load.** Pre-place a `~/.pi/session-search/index/session-index.json` with `version: 3`. Pi starts. Assert: file rewritten to `version: 4`; pane notify "incompatible; reset to v4. Run /digest:backfill". `sessions-fts.db` and `hybrid-fts.db` (if they existed) have their tables wiped.

### Mode upgrade (1)

- **S21 — case (b) hybrid-raw → digest-mode upgrade clears embeddings.** Start in hybrid-raw with some indexed sessions (raw embeddings populated). Then add `digest.json` config + reload. After the 1-second re-evaluation, assert: index entries' `embedding` field is empty/null (cleared per task 4.5.1 case b). Notify: "embedding dimension changed; re-embedding all sessions." OR similar.

## Running

```bash
# All scenarios sequentially:
./tests/scenarios/run-all-scenarios.sh

# Parallel (haiku tolerates 4):
SCENARIO_PARALLEL=4 ./tests/scenarios/run-all-scenarios.sh

# Filter:
SCENARIO_FILTER='^s(0|1)' ./tests/scenarios/run-all-scenarios.sh
```

Outputs: `tests/scenarios/.test-output/scenarios/SUMMARY.md`, individual `<name>.run.log`, `<name>.pane.log`, `<name>.bridge.log` per scenario.

## Known runner limitation: claude-bridge auth + HOME isolation

`scn_setup_clean_home` redirects `$HOME` to a per-scenario tempdir for clean session-search state. It symlinks `~/.pi/agent`, `~/.claude/`, and `~/.claude.json` from the real HOME into the temp tree so claude-bridge can authenticate, but **claude-bridge still reports `Not logged in` inside the isolated HOME**, so model-driven probes (S03–S07, S10–S11, S13–S18) fail their coherence assertions.

What IS verified by the current runner:
- Pi launches with the local extension
- Extension loads cleanly in fts-raw mode (S01 — PASS)
- All structural assertions before the first model call (no error notifications, file paths exist, config files written by `/digest:settings`)
- Slash-command-only scenarios that don't require model output (S08, S19, S20)

What's blocked:
- Any scenario whose pass criterion needs a model reply

Resolution paths (future work):
1. Add a `PI_SESSION_SEARCH_HOME` env override to `src/digest/storage.ts`, `src/digest/config.ts`, `src/index/session-index.ts` so tests can isolate session-search state without overriding `$HOME`. Drop the HOME redirect.
2. Use `openai-codex` provider with a direct `OPENAI_API_KEY` env var; claude-bridge's OAuth-via-keychain dependency disappears.
3. Run scenarios manually (not via the runner) by exporting the user's keychain creds to env vars before invoking the script.

The scenarios are written and ready; the runner needs one of (1)–(3) to make them pass end-to-end. Until then, treat this as a **test specification + harness scaffold**, not a passing CI suite.

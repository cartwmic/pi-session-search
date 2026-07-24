# pi-session-search — TUI Scenario Tests

End-to-end scenarios validating the `remove-hybrid-raw-mode` change against a real Pi process. Each scenario follows the standard harness pattern (private tmux server, completion-signal-based wait, two-tier mechanical + coherence assertions).

Tags: `[ci]` = CI-safe (no live model access required for pass condition). `[live-model]` = requires model response for pass condition (manual smoke for releases).

## Charter

- **Mode detection is non-negotiable.** Wrong mode = wrong index = wrong embeddings vs digests.
- **Silent failures are the threat.** "We didn't crash" passes a unit test but a user sees a broken `/session:digest`. Every scenario that touches user-visible surfaces must have a probe that proves the right thing happened.
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
| Extension load | `pi -e <repo>` (bundle auto-load) |

## Scenario catalog (20 total)

### CI-safe scenarios (blocking for v3.0.0 release gate)

- **S01** `[ci]` — **fts-raw mode loads cleanly when no embedder configured.** Empty `~/.pi/session-search/`. Pi starts. Assert: extension loaded, no notify error, mode is fts-raw (no embedder warning).
- **S02** `[ci]` — **Misconfigured-verdict UX (5 sub-tests, continued-on-failure).** 5 independent sub-tests each with its own pi instance:
  - (a) embedder set, digest absent → status set, error notify, `session_search`/`/find-session` return remediation, `/session:embedder` and `/session:summarizer` work normally.
  - (b) digest set, embedder absent → symmetric checks with opposite missing field.
  - (c) both broken (legacy bedrock embedder + digest configured but no model) → `missing: "both"` notify mentions both files.
  - (d) warm-path transition. Start digest-hybrid, edit config to remove `digest.json`, `/reload`, assert status updates and prior tool invocations return remediation.
  - (e) legacy-bedrock + no-digest-intent → legacy-rejection notify fires; verdict resolves to `fts-raw`; `session_search` works as normal fts-raw search (NOT misconfigured).
  Sub-tests run sequentially but each sets up its own independent `PI_SESSION_SEARCH_HOME`. Assertions capture pass/fail per sub-test; final exit reports per-sub-test status.
- **S08** `[ci]` — **`/session:summarizer` creates global config.** Empty HOME. Run `/session:summarizer`. Assert: `~/.pi/session-search/digest.json` now exists with defaults. Pane shows path + `/reload` instruction.
- **S09** `[ci]` — **`/session:digest` with no digest yet shows fallback.** Pi just started, no digest written. Run `/session:digest`. Assert pane: `(no digest yet)`.
- **S19** `[ci]` — **Legacy embedder config (`type: "bedrock"`) is refused with notify.** Write `config.json` with `embedder.type = "bedrock"` (legacy). Pi starts. Assert pane notify: "legacy embedder" / "/session:embedder". Mode detected: fts-raw (fallback).
- **S20** `[ci]` — **Index v3 → v4 reset on load.** Pre-place a `~/.pi/session-search/index/session-index.json` with `version: 3`. Pi starts. Assert: file rewritten to `version: 4`; pane notify "incompatible; reset to v4. Run /session:backfill".
- **S21 slot** `[ci]` — **(reserved for migration scenario — TBD).** The old hybrid-raw→digest-mode upgrade scenario has been deleted. A new migration scenario covering INDEX_VERSION 4→5 wipe, FTS rebuild, and notify text selection will be authored in this slot.

### Live-model scenarios (manual smoke for Release)

Lifecycle and digest generation:

- **S03** `[live-model]` — **digest-hybrid when embedder + cheap model both available.** Write `config.json` (embedder) + `digest.json` (default). Pi starts. Assert: digest lifecycle installed, no misconfigured notify, digest file written after a turn.
- **S04** `[live-model]` — **agent_end with `debounceSeconds=0` fires generateDigest immediately on first turn.** Send a real conversation prompt. After response, assert: `~/.pi/session-search/digests/<id>.json` exists, `<id>.state.json` exists.
- **S05** `[live-model]` — **session_compact bypasses debounce.** Send a few turns. Issue `/compact`. Assert: digest written immediately even if debounce timer would have prevented agent_end-driven write.
- **S06** `[live-model]` — **session_shutdown aborts in-flight LLM call.** Send long prompt. While model is responding, exit pi. Restart pi. Assert: no partial/corrupted digest file in tempdir.
- **S07** `[live-model]` — **Builder state persists across restart.** Send a turn, write digest. Restart pi. Send a small follow-up turn. Assert: builder uses incremental mode.

Slash commands:

- **S10** `[live-model]` — **`/session:update` after a turn writes digest + setSessionName.** Send a turn. Run `/session:update`. Assert: digest file written. Pane notify: success message.
- **S11** `[live-model]` — **`/session:rewrite` forces full re-summarize.** Have a digest. Run `/session:rewrite`. Assert: digest file mtime updated; new digest body differs from prior.
- **S12** `[live-model]` — **`/session:backfill --dry-run` prints cost estimate.** Place 2-3 fixture session JSONLs. Run `/session:backfill --dry-run`. Assert pane: cost lines printed.

Render layer:

- **S13** `[live-model]` — **`session_list` in digest-hybrid shows headlines for digested + suffix for un-digested.** Set up digest-hybrid. Pre-place fixtures. Send "list my sessions". Assert pane: headline for digested, `(no digest — run /session:update)` for un-digested.
- **S14** `[live-model]` — **`session_search` empty-state in digest-hybrid.** Empty index in digest-hybrid. Send "search sessions for foo". Assert pane: "Run /session:backfill" message.
- **S15** `[live-model]` — **primer `before_agent_start` shows digest.headline.** Set up two old sessions, one with digest. Send any turn. Assert model response references headline content.
- **S16** `[live-model]` — **`session_search` results in digest-hybrid show topics line.** Place a fixture digest with topics. Search for matching keyword. Assert pane: `Topics: foo, bar` line.

Find-session overlay:

- **S17** `[live-model]` — **`/find-session foo` opens overlay with results.** Place 2-3 digests. Run `/find-session foo`. Assert pane: card with headline + topics + body excerpt.
- **S18** `[live-model]` — **Esc dismisses overlay without switching session.** Open `/find-session`. Press Esc. Assert: overlay closed, session preserved.

## Running

```bash
# All 20 scenarios sequentially:
./tests/scenarios/run-all-scenarios.sh

# CI-only: runs blocking subset (S01, S02, S08, S09, S19, S20, S21-migration):
./tests/scenarios/run-all-scenarios.sh --ci-only

# Parallel (haiku tolerates 4):
SCENARIO_PARALLEL=4 ./tests/scenarios/run-all-scenarios.sh

# Filter:
SCENARIO_FILTER='^s(0|1)' ./tests/scenarios/run-all-scenarios.sh
```

Outputs: `tests/scenarios/.test-output/scenarios/SUMMARY.md`, individual `<name>.run.log`, `<name>.pane.log`, `<name>.bridge.log` per scenario.

## CI release gate for v3.0.0

- **MUST pass on CI** (blocking): S02 (all 5 sub-tests) + S08 + S09 + S19 + S20 + S21 (migration)
- **Manual smoke** (required for release, not blocking CI): S03–S07, S10–S18

Use `--ci-only` on CI. Run full suite before tagging.

## Known runner limitation: claude-bridge auth + HOME isolation

`scn_setup_clean_home` uses `PI_SESSION_SEARCH_HOME` (NOT overriding `$HOME`) to isolate session-search state. This keeps `$HOME` intact so claude-bridge keychain auth works. However, historical runs with the old `$HOME`-override approach caused claude-bridge to report `Not logged in`. The fix (`PI_SESSION_SEARCH_HOME` isolation) is in place but not yet end-to-end validated for all scenarios.

What IS verified by the current runner:
- Pi launches with the local extension
- Extension loads cleanly in fts-raw mode (S01 — PASS)
- All structural assertions before the first model call (no error notifications, file paths exist, config files written by `/session:summarizer`)
- Slash-command-only scenarios that don't require model output (S08, S09, S19, S20)

What's blocked:
- Any scenario whose pass criterion needs a model reply with the old `$HOME`-override

The `$HOME` override was the root cause. With `PI_SESSION_SEARCH_HOME` isolation, model-driven scenarios may now work. Validate on your machine before tagging a release.

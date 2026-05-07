/**
 * registration.test.ts — Phase B tests (task 2.12)
 *
 * Covers:
 *   1. Handler-list non-growth across N session_start events
 *   2. installDigestLifecycle invoked exactly once per process
 *   3. search/digest tools and commands installed at module-load
 *
 * Uses the shared mock-pi harness from src/__tests__/_helpers/mock-pi.ts.
 *
 * NOTE: runtime verdict tests (cold-start misconfigured, warm-path transitions)
 * are covered by headless.test.ts and warm-path-race.test.ts.
 * This file focuses on module-load registration invariants.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { createMockPi, createMockCtx } from "../_helpers/mock-pi"

// ─── Test home isolation ────────────────────────────────────────────
const sessionSearchHome = join(
  tmpdir(),
  "pi-session-search-reg-" + process.pid,
)

before(() => {
  process.env.PI_SESSION_SEARCH_HOME = sessionSearchHome
  process.env.OPENAI_API_KEY = "sk-test-reg-key"
  try { rmSync(sessionSearchHome, { recursive: true }) } catch {}
  mkdirSync(sessionSearchHome, { recursive: true })
  // Pre-write both config files so resolveModeVerdict resolves to
  // digest-hybrid without triggering the 1000ms async retry.
  writeFileSync(
    join(sessionSearchHome, "config.json"),
    JSON.stringify({
      embedder: {
        baseUrl: "https://api.openai.com",
        model: "text-embedding-3-small",
      },
    }),
  )
  writeFileSync(
    join(sessionSearchHome, "digest.json"),
    JSON.stringify({ provider: "test", model: "gpt-4-mini" }),
  )
})

after(() => {
  try { rmSync(sessionSearchHome, { recursive: true }) } catch {}
})

/**
 * Helper: invoke the extension's default export then fire session_shutdown
 * before the test ends, so the periodic-sync setInterval and any open
 * SQLite handles are released.  Without this the node:test runner reports
 * "Promise resolution is still pending but the event loop has already
 * resolved" when the test process tries to exit.
 */
async function installAndCleanup(
  pi: ReturnType<typeof createMockPi>,
  ctx: any,
  body: () => Promise<void>,
) {
  const mod = await import("../../index")
  mod.default(pi as any)
  try {
    await body()
  } finally {
    const shutdownHandlers = pi._eventHandlers.filter(
      (h) => h.event === "session_shutdown",
    )
    for (const h of shutdownHandlers) {
      try { await h.handler("event", ctx) } catch {}
    }
  }
}

describe("registration (Phase B) — module-load invariants", () => {
  it("1. handler-list non-growth: N session_start events do not grow handler list", async () => {
    const pi = createMockPi()
    const ctx = createMockCtx({
      cwd: "/tmp",
      ui: { notify() {}, setStatus() {}, input: async () => "" },
      modelRegistry: {
        getAvailable: () => [
          {
            provider: "test",
            id: "gpt-4-mini",
            cost: { input: 0.00015, output: 0.0006 },
          },
        ],
      },
    })

    await installAndCleanup(pi, ctx, async () => {
    // Count handlers per event
    const ssCount = pi.handlerCount("session_start")
    const shutdownCount = pi.handlerCount("session_shutdown")
    const basCount = pi.handlerCount("before_agent_start")
    const aeCount = pi.handlerCount("agent_end")
    const scCount = pi.handlerCount("session_compact")

    assert.equal(
      ssCount,
      2,
      "session_start: 1 from extension + 1 from lifecycle = 2",
    )
    assert.equal(
      shutdownCount,
      2,
      "session_shutdown: 1 from extension + 1 from lifecycle = 2",
    )
    assert.equal(basCount, 1, "before_agent_start must be registered once")
    assert.equal(aeCount, 1, "agent_end must be registered once (from lifecycle)")
    assert.equal(scCount, 1, "session_compact must be registered once (from lifecycle)")

    // Simulate N synthetic session_start events.
    // With both config files present, resolveModeVerdict resolves without
    // async retry.  2 iterations is sufficient: the first sets up
    // closure state; the second verifies handler counts stay flat.
    for (let i = 0; i < 2; i++) {
      const handlers = pi._eventHandlers.filter(
        (h) => h.event === "session_start",
      )
      for (const h of handlers) {
        await h.handler("event", ctx)
      }
    }

    // Handler counts must NOT have grown
    assert.equal(pi.handlerCount("session_start"), ssCount)
    assert.equal(pi.handlerCount("before_agent_start"), basCount)
    assert.equal(pi.handlerCount("session_shutdown"), shutdownCount)
    assert.equal(pi.handlerCount("agent_end"), aeCount)
    assert.equal(pi.handlerCount("session_compact"), scCount)
    })
  })

  it("2. installDigestLifecycle invoked exactly once per ext() call", async () => {
    const pi = createMockPi()
    const ctx = { cwd: "/tmp", ui: { notify() {}, setStatus() {}, input: async () => "" } } as any
    await installAndCleanup(pi, ctx, async () => {
      assert.equal(pi.handlerCount("agent_end"), 1)
      assert.equal(pi.handlerCount("session_compact"), 1)
    })
  })

  it("3. search/digest tools and commands installed at module-load", async () => {
    const pi = createMockPi()
    const ctx = { cwd: "/tmp", ui: { notify() {}, setStatus() {}, input: async () => "" } } as any
    await installAndCleanup(pi, ctx, async () => {
    const names = pi.toolNames()
    assert.ok(names.includes("session_search"), "session_search tool")
    assert.ok(names.includes("session_list"), "session_list tool")
    assert.ok(names.includes("session_read"), "session_read tool")

    const cmds = pi.commandNames()
    assert.ok(cmds.includes("digest:settings"), "digest:settings")
    assert.ok(cmds.includes("digest:update"), "digest:update")
    assert.ok(cmds.includes("digest:show"), "digest:show")
    assert.ok(cmds.includes("digest:rewrite"), "digest:rewrite")
    assert.ok(cmds.includes("digest:backfill"), "digest:backfill")
    assert.ok(cmds.includes("digest:cost"), "digest:cost")
    assert.ok(cmds.includes("session-embeddings-setup"), "session-embeddings-setup")
    assert.ok(cmds.includes("session-sync"), "session-sync")
    assert.ok(cmds.includes("session-reindex"), "session-reindex")
    })
  })
})

describe("index module exports", () => {
  it("should export expected public API", async () => {
    const mod = await import("../../index")
    assert.ok(typeof mod.default === "function", "default export must be a function")
    assert.ok(typeof mod.truncate === "function", "should export truncate")
    assert.ok(typeof mod.toFtsQuery === "function", "should export toFtsQuery")
    assert.ok(typeof mod.loadConfig === "function", "should export loadConfig")
    assert.ok(typeof mod.resolveModel === "function", "should export resolveModel")
    assert.ok(typeof mod.installDigestLifecycle === "function", "should export installDigestLifecycle")
  })
})

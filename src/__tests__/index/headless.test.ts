/**
 * headless.test.ts — headless-deployment safety test (task 7.9a)
 *
 * Asserts that on misconfigured verdict resolution, the extension:
 *   1. Calls ctx.ui.notify(...) with "error" level
 *   2. Emits console.error(...) containing the same remediation text
 *
 * This pins the spec promise that headless/RPC deployments get the
 * structured-log error even when the TUI notify is unavailable.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

import { createMockPi, createMockCtx } from "../_helpers/mock-pi"

// ─── Console.error spy ────────────────────────────────────────────

const originalConsoleError = console.error.bind(console)
let capturedErrors: string[] = []

function spyConsoleError() {
  capturedErrors = []
  console.error = (...args: any[]) => {
    const msg = args.map((a: any) => String(a)).join(" ")
    capturedErrors.push(msg)
    originalConsoleError(...args)
  }
}

function restoreConsoleError() {
  console.error = originalConsoleError
}

// ─── Notify capture ──────────────────────────────────────────────

function captureNotifyCtx() {
  const notifications: Array<{ msg: string; level: string }> = []
  const ctx = createMockCtx({
    ui: {
      notify: (msg: string, level?: string) => {
        notifications.push({ msg, level: level ?? "info" })
      },
      setStatus: (_key: string, _msg: string) => {},
      input: async (_prompt: string, _default?: string) => "",
    },
  })
  return { ctx, notifications }
}

describe("headless safety (7.9a)", () => {
  const sessionSearchHome = join(
    tmpdir(),
    "pi-session-search-headless-" + process.pid,
  )

  before(() => {
    process.env.PI_SESSION_SEARCH_HOME = sessionSearchHome
    process.env.OPENAI_API_KEY = "sk-test-misconfigured-verdict"
    try { rmSync(sessionSearchHome, { recursive: true }) } catch {}
    mkdirSync(sessionSearchHome, { recursive: true })
    writeFileSync(
      join(sessionSearchHome, "digest.json"),
      JSON.stringify({ provider: "missing-provider", model: "missing-model" }),
    )
    spyConsoleError()
  })

  after(() => {
    restoreConsoleError()
    try { rmSync(sessionSearchHome, { recursive: true }) } catch {}
  })

  it("misconfigured verdict emits console.error with remediation text", async () => {
    writeFileSync(
      join(sessionSearchHome, "config.json"),
      JSON.stringify({
        embedder: {
          baseUrl: "https://api.openai.com",
          model: "text-embedding-3-small",
        },
      }),
    )

    const pi = createMockPi()
    const mod = await import("../../index")
    mod.default(pi as any)

    const handlers = pi._eventHandlers.filter(
      (h) => h.event === "session_start",
    )
    const { ctx, notifications } = captureNotifyCtx()

    for (const h of handlers) {
      await h.handler("event", ctx)
    }

    const errorNotifies = notifications.filter((n) => n.level === "error")
    assert.ok(
      errorNotifies.length >= 1,
      `expected error-level notify, got ${notifications.length}: ${JSON.stringify(notifications)}`,
    )

    const firstError = errorNotifies[0].msg
    assert.ok(firstError.includes("misconfigured"), `error: ${firstError}`)
    assert.ok(firstError.includes("digest.json"), `error: ${firstError}`)
    assert.ok(firstError.includes("config.json"), `error: ${firstError}`)

    assert.ok(
      capturedErrors.length >= 1,
      `console.error called ${capturedErrors.length} times`,
    )
    const consoleMsg = capturedErrors[0]
    assert.ok(consoleMsg.includes("misconfigured"), `console: ${consoleMsg}`)
  })

  it("misconfigured verdict console.error matches notify error text", async () => {
    capturedErrors = []
    writeFileSync(
      join(sessionSearchHome, "config.json"),
      JSON.stringify({
        embedder: {
          baseUrl: "https://api.openai.com",
          model: "text-embedding-3-small",
        },
      }),
    )

    const pi = createMockPi()
    const mod = await import("../../index")
    mod.default(pi as any)

    const handlers = pi._eventHandlers.filter(
      (h) => h.event === "session_start",
    )
    const { ctx, notifications } = captureNotifyCtx()

    for (const h of handlers) {
      await h.handler("event", ctx)
    }

    const errorNotifies = notifications.filter((n) => n.level === "error")
    assert.ok(errorNotifies.length >= 1, "should emit error-level notify")

    assert.ok(
      capturedErrors.some((ce) => ce.includes("misconfigured")),
      "console.error should contain 'misconfigured'",
    )

    const matchingError = capturedErrors.find((ce) =>
      ce.includes("session-search: misconfigured"),
    )
    assert.ok(
      matchingError,
      `console.error should contain 'session-search: misconfigured': ${JSON.stringify(capturedErrors)}`,
    )
  })
})

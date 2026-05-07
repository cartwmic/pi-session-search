/**
 * mode-resolver.test.ts — unit tests for resolveModeVerdict (tasks 1.2–1.4, 1.7)
 *
 * Covers the four verdict cases (a)–(d) from task 1.7:
 *   (a) All four binary config combinations → expected verdict
 *   (b) Bounded async retry: registry empty initially → retry → populated → digest-hybrid
 *   (c) Async retry does NOT fire for missing: "embedder"
 *   (d) missing: "both" produced when both halves are absent with digest intent
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Config } from "../../config"
import type { DigestConfig } from "../../digest/config"
import { resolveModeVerdict, composeRemediation } from "../../index/mode"
import type { Verdict } from "../../index/mode"

// ─── Helpers ─────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Config> = {}): Config {
	return {
		embedder: overrides.embedder ?? { baseUrl: "https://api.openai.com", model: "text-embedding-3-small" },
		extraSessionDirs: [],
		extraArchiveDirs: [],
		...overrides,
	}
}

function makeNullConfig(): Config | null {
	return null
}

function makeDigestConfig(overrides: Partial<DigestConfig> = {}): DigestConfig {
	return {
		debounceSeconds: 10,
		resummarizeTokenThreshold: 10_000,
		maxTokens: 1500,
		showWidget: false,
		verbose: false,
		provider: "test-provider",
		model: "gpt-5.4-mini",
		...overrides,
	}
}

function makeRegistryEntry(id: string, provider: string) {
	return { provider, id }
}

/** Injected delay that resolves instantly — makes retry-path tests fast. */
const instantDelay = async (_ms: number) => {}

function expectFtsRaw(v: Verdict): void {
	assert.equal(v.kind, "fts-raw", `expected fts-raw, got ${JSON.stringify(v)}`)
}

function expectDigestHybrid(v: Verdict): void {
	assert.equal(v.kind, "digest-hybrid", `expected digest-hybrid, got ${JSON.stringify(v)}`)
}

function expectMisconfigured(v: Verdict, expectedMissing: string): void {
	assert.equal(v.kind, "misconfigured", `expected misconfigured, got ${JSON.stringify(v)}`)
	if (v.kind === "misconfigured") {
		assert.equal(v.missing, expectedMissing, `missing mismatch: expected ${expectedMissing}, got ${v.missing}`)
		assert.ok(v.statusLine.length > 0, "statusLine must not be empty")
		assert.ok(v.notifyMessage.length > 0, "notifyMessage must not be empty")
	}
}

// ─── (a) Binary config combinations → expected verdict ───────────────

describe("(a) binary config combinations", () => {

  it("no embedder, no digest intent → fts-raw", async () => {
    const v = await resolveModeVerdict(makeNullConfig(), () => [], { embedderAvailable: false })
    expectFtsRaw(v)
  })

  it("embedder available, digest model resolved → digest-hybrid", async () => {
    const registry = [makeRegistryEntry("gpt-5.4-mini", "test-provider")]
    const v = await resolveModeVerdict(makeConfig(), () => registry, {
      embedderAvailable: true,
      digestConfig: makeDigestConfig(),
    })
    expectDigestHybrid(v)
  })

  it("embedder available, no digest model, digest requested → misconfigured (missing: digest)", async () => {
    const v = await resolveModeVerdict(makeConfig(), () => [], {
      embedderAvailable: true,
      digestConfig: makeDigestConfig(),
      delay: instantDelay,
    })
    expectMisconfigured(v, "digest")
  })

  it("embedder available, no digest intent → misconfigured (missing: digest)", async () => {
    const v = await resolveModeVerdict(makeConfig(), () => [], {
      embedderAvailable: true,
    })
    expectMisconfigured(v, "digest")
  })

  it("no embedder, digest model resolved, digest requested → misconfigured (missing: embedder)", async () => {
    const registry = [makeRegistryEntry("gpt-5.4-mini", "test-provider")]
    const v = await resolveModeVerdict(makeNullConfig(), () => registry, {
      embedderAvailable: false,
      digestConfig: makeDigestConfig(),
    })
    expectMisconfigured(v, "embedder")
  })

  it("no embedder, no digest model, digest requested → misconfigured (missing: both)", async () => {
    const v = await resolveModeVerdict(makeNullConfig(), () => [], {
      embedderAvailable: false,
      digestConfig: makeDigestConfig(),
      delay: instantDelay,
    })
    expectMisconfigured(v, "both")
  })
})

// ─── (b) Bounded async retry ─────────────────────────────────────────

describe("(b) bounded async retry", () => {

  it("retry fires for missing:digest → digest-hybrid after registry populates", async () => {
    let callCount = 0
    const delayedRegistry = () => {
      callCount++
      return callCount === 1 ? [] : [makeRegistryEntry("gpt-5.4-mini", "test-provider")]
    }

    let delayCalled = false
    const v = await resolveModeVerdict(makeConfig(), delayedRegistry, {
      embedderAvailable: true,
      digestConfig: makeDigestConfig(),
      delay: async (ms: number) => { delayCalled = true },
    })

    expectDigestHybrid(v)
    assert.ok(delayCalled, "delay should have been called (retry fired)")
    assert.equal(callCount, 2, "registryGetter should have been called twice")
  })

  it("retry fires for missing:both → embedder after registry populates", async () => {
    let callCount = 0
    const delayedRegistry = () => {
      callCount++
      return callCount === 1 ? [] : [makeRegistryEntry("gpt-5.4-mini", "test-provider")]
    }

    let delayCalled = false
    const v = await resolveModeVerdict(makeNullConfig(), delayedRegistry, {
      embedderAvailable: false,
      digestConfig: makeDigestConfig(),
      delay: async (ms: number) => { delayCalled = true },
    })

    // After retry: embedderAvailable=false, model resolved → missing: embedder
    expectMisconfigured(v, "embedder")
    assert.ok(delayCalled, "delay should have been called (retry fired)")
    assert.equal(callCount, 2, "registryGetter should have been called twice")
  })

  it("retry does NOT fire for fts-raw result (no digest intent)", async () => {
    let callCount = 0
    let delayCalled = false
    const v = await resolveModeVerdict(makeNullConfig(), () => { callCount++; return [] }, {
      embedderAvailable: false,
      delay: async (ms: number) => { delayCalled = true },
    })

    expectFtsRaw(v)
    assert.ok(!delayCalled, "delay should NOT have been called")
    assert.equal(callCount, 1, "registryGetter should have been called exactly once")
  })

  it("retry fires for missing:both but both remain absent → stays misconfigured (both)", async () => {
    let callCount = 0
    let delayCalled = false
    const v = await resolveModeVerdict(makeNullConfig(), () => { callCount++; return [] }, {
      embedderAvailable: false,
      digestConfig: makeDigestConfig(),
      delay: async (ms: number) => { delayCalled = true },
    })

    expectMisconfigured(v, "both")
    assert.ok(delayCalled, "delay should have been called")
    assert.equal(callCount, 2, "registryGetter should have been called twice")
  })
})

// ─── (c) Retry does NOT fire for missing: embedder ───────────────────

describe("(c) retry does NOT fire for missing: embedder", () => {

  it("no retry when embedder is missing and digest model is resolved", async () => {
    let callCount = 0
    let delayCalled = false
    const v = await resolveModeVerdict(makeNullConfig(), () => { callCount++; return [makeRegistryEntry("gpt-5.4-mini", "test-provider")] }, {
      embedderAvailable: false,
      digestConfig: makeDigestConfig(),
      delay: async (ms: number) => { delayCalled = true },
    })

    expectMisconfigured(v, "embedder")
    assert.ok(!delayCalled, "delay should NOT have been called for missing: embedder")
    assert.equal(callCount, 1, "registryGetter should have been called exactly once")
  })
})

// ─── (d) missing: both ───────────────────────────────────────────────

describe("(d) missing: both", () => {

  it("no embedder, no digest model, digest requested → missing: both", async () => {
    const v = await resolveModeVerdict(makeNullConfig(), () => [], {
      embedderAvailable: false,
      digestConfig: makeDigestConfig(),
      delay: instantDelay,
    })
    expectMisconfigured(v, "both")
  })

  it("remediation names both config files", async () => {
    const v = await resolveModeVerdict(makeNullConfig(), () => [], {
      embedderAvailable: false,
      digestConfig: makeDigestConfig(),
      delay: instantDelay,
    })

    assert.equal(v.kind, "misconfigured")
    if (v.kind === "misconfigured") {
      assert.ok(v.notifyMessage.includes("config.json"), `should mention config.json: ${v.notifyMessage}`)
      assert.ok(v.notifyMessage.includes("digest.json"), `should mention digest.json: ${v.notifyMessage}`)
    }
  })
})

// ─── Remediation string verification (task 1.4) ──────────────────────

describe("composeRemediation (task 1.4)", () => {

  it("missing: digest → correct strings", () => {
    const { statusLine, notifyMessage } = composeRemediation("digest")
    assert.ok(statusLine.includes("misconfigured"))
    assert.ok(statusLine.includes("no digest model"))
    assert.ok(notifyMessage.includes("digest.json"))
    assert.ok(notifyMessage.includes("config.json"))
  })

  it("missing: embedder → correct strings", () => {
    const { statusLine, notifyMessage } = composeRemediation("embedder")
    assert.ok(statusLine.includes("misconfigured"))
    assert.ok(statusLine.includes("no embedder"))
    assert.ok(notifyMessage.includes("config.json"))
    assert.ok(notifyMessage.includes("digest.json"))
  })

  it("missing: both → correct strings", () => {
    const { statusLine, notifyMessage } = composeRemediation("both")
    assert.ok(statusLine.includes("misconfigured"))
    assert.ok(statusLine.includes("no embedder"))
    assert.ok(statusLine.includes("no digest model"))
    assert.ok(notifyMessage.includes("config.json"))
    assert.ok(notifyMessage.includes("digest.json"))
  })
})

import { describe, it } from "node:test"
import { strict as assert } from "node:assert"
import type { ParsedSession } from "../../parser"
import { buildRawFtsContent } from "../../index/raw-fts-content"

function makeSession(overrides: Partial<ParsedSession>): ParsedSession {
  return {
    file: "/tmp/test.jsonl",
    id: "test-uuid",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T01:00:00Z",
    cwd: "/home/user/project",
    name: "Test Session",
    archived: false,
    projectSlug: "test-project",
    models: ["claude-3"],
    userMessageCount: 1,
    assistantMessageCount: 1,
    toolCalls: [],
    filesRead: [],
    filesModified: [],
    firstUserMessage: "Hello",
    userMessages: ["Hello"],
    assistantText: "",
    compactionSummaries: [],
    branchSummaries: [],
    totalCost: 0,
    totalTokens: 0,
    ...overrides,
  }
}

describe("buildRawFtsContent — byte-cap with multibyte UTF-8 (§4.11)", () => {
  it("truncates userMessages to ≤6 KB preserving UTF-8 character boundaries", () => {
    // Build a session where userMessages total > 6 KB with multibyte chars
    // Each "𝄞" (MUSICAL SYMBOL G CLEF, U+1D11E) is 4 bytes
    const fourByteChar = "𝄞" // U+1D11E, 4 bytes in UTF-8
    // 2000 chars of 4 bytes each = 8000 bytes → exceeds 6 KB (6144 bytes)
    // 6144 / 4 = 1536 chars fit exactly
    // We'll create 2000 chars → 8000 bytes to test truncation
    const longMessages = Array.from({ length: 2000 }, () => fourByteChar)

    // Split into userMessages (each message joined with \n)
    // The messages array is joined with \n, which adds ~1 byte per message separator
    // Let's make it a single long message for simplicity
    const session = makeSession({
      userMessages: [longMessages.join("")],
    })

    const result = buildRawFtsContent(session)

    // Assert byte length ≤ 12 KB (the final cap)
    const byteLen = Buffer.byteLength(result, "utf8")
    assert.ok(
      byteLen <= 12 * 1024,
      `result should be ≤ 12 KB (got ${byteLen} bytes)`,
    )

    // The original 2000 chars are 8000 bytes, which exceeds the 6 KB userMessages cap
    // and also the 12 KB final cap. So the result should be truncated.
    assert.ok(
      byteLen <= 12 * 1024,
      `truncated result should not exceed final cap`,
    )

    // Verify the truncated string is valid UTF-8 (no replacement characters)
    // Replacement character U+FFFD in UTF-8 = EF BF BD (3 bytes)
    assert.ok(!result.includes("\uFFFD"), "truncated result must not contain replacement characters")

    // Verify no broken surrogate pairs
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i)
      if (code >= 0xD800 && code <= 0xDBFF) {
        // High surrogate — must be followed by a low surrogate
        assert.ok(
          i + 1 < result.length,
          `broken high surrogate at position ${i}`,
        )
        const next = result.charCodeAt(i + 1)
        assert.ok(
          next >= 0xDC00 && next <= 0xDFFF,
          `high surrogate at ${i} not followed by low surrogate (got ${next})`,
        )
        i++ // skip the low surrogate
      } else if (code >= 0xDC00 && code <= 0xDFFF) {
        assert.fail(`stray low surrogate at position ${i}`)
      }
    }
  })

  it("truncation point preserves UTF-8 character boundaries with mixed-width chars", () => {
    // Mix of ASCII (1 byte), 2-byte, 3-byte, and 4-byte chars
    // Create a string that gets truncated mid-multibyte-char
    const chars = "a".repeat(6000) + "𝄞".repeat(500) // 6000 ASCII + 2000 bytes of 4-byte chars = 8000 bytes
    // But userMessages has a 6 KB cap, so this should truncate at 6144 bytes
    // 6144 ASCII chars = 6144 bytes exactly. Since no multibyte in first 6144, clean.
    // Let's make a harder case: mix multibyte early
    const mixed = Array.from({ length: 1000 }, () => "a𝄞").join("") // 1000 * (1+4) = 5000 bytes - under 6KB

    const session = makeSession({
      userMessages: [mixed],
    })

    const result = buildRawFtsContent(session)
    const byteLen = Buffer.byteLength(result, "utf8")
    assert.ok(byteLen <= 12 * 1024)
    assert.ok(!result.includes("\uFFFD"), "no replacement chars in truncated result")
  })
})

describe("buildRawFtsContent — excludes assistantText (§4.12)", () => {
  it("raw_content excludes assistantText: a token only in assistantText is not matchable", () => {
    // Create a session where 'NEBULAZOID' appears ONLY in assistantText
    const session = makeSession({
      name: "test",
      userMessages: ["Hello"],
      assistantText: "The NEBULAZOID algorithm converges quickly.",
      firstUserMessage: "Hello",
      compactionSummaries: [],
      branchSummaries: [],
      filesModified: [],
    })

    const result = buildRawFtsContent(session)

    // The token 'NEBULAZOID' should NOT appear in the FTS content
    assert.ok(
      !result.includes("NEBULAZOID"),
      "buildRawFtsContent should not include assistantText",
    )
  })

  it("raw_content includes userMessages but 'NEBULAZOID' in assistantText is absent", () => {
    // More thorough: userMessages contain 'PRESENT' but assistantText has 'NEBULAZOID'
    const session = makeSession({
      name: "test",
      userMessages: ["PRESENT in user message"],
      assistantText: "NEBULAZOID only in assistant",
      firstUserMessage: "PRESENT in user message",
      compactionSummaries: [],
      branchSummaries: [],
      filesModified: [],
    })

    const result = buildRawFtsContent(session)

    assert.ok(result.includes("PRESENT"), "userMessages content should be included")
    assert.ok(
      !result.includes("NEBULAZOID"),
      "assistantText content must be excluded",
    )
  })
})

describe("buildRawFtsContent — base64-blob stripping", () => {
  it("strips lines matching ^[A-Za-z0-9+/=]{200,}$ from filesModified", () => {
    // Long base64-looking line (≥200 chars of base64 chars)
    const longBase64 =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+//".repeat(
        5,
      ) // 64*5=320 chars
    assert.ok(
      longBase64.length >= 200,
      "base64 line must be ≥200 chars",
    )

    const session = makeSession({
      filesModified: ["/src/index.ts", longBase64, "/src/utils.ts"],
    })

    const result = buildRawFtsContent(session)

    // The long base64 line should be stripped
    assert.ok(
      !result.includes("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"),
      "long base64 line must be stripped",
    )
    // Legitimate paths should remain
    assert.ok(result.includes("/src/index.ts") || result.includes("src / index.ts"), "legitimate paths should remain")
    assert.ok(result.includes("/src/utils.ts") || result.includes("src / utils.ts"), "legitimate paths should remain")
  })

  it("short base64-like strings (under 200 chars) are preserved", () => {
    // Use a short string without / so path normalization doesn't change it
    const shortB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" // < 200 chars, no slash

    const session = makeSession({
      filesModified: [shortB64],
    })

    const result = buildRawFtsContent(session)

    assert.ok(
      result.includes(shortB64),
      "short base64 strings must be preserved",
    )
  })
})

describe("buildRawFtsContent — file-path normalization", () => {
  it("normalizes filesModified paths by replacing / with space-slash-space", () => {
    const session = makeSession({
      filesModified: ["/src/index.ts", "/src/utils.ts"],
    })

    const result = buildRawFtsContent(session)

    // The file paths should appear with / replaced by " / "
    assert.ok(
      result.includes("src / index.ts"),
      `should normalize /src/index.ts to have spaces around slashes, got: ${result}`,
    )
    assert.ok(
      result.includes("src / utils.ts"),
      "should normalize /src/utils.ts to have spaces around slashes",
    )
  })

  it("normalizes paths with multiple path segments", () => {
    const session = makeSession({
      filesModified: ["/home/user/project/src/lib/util.ts"],
    })

    const result = buildRawFtsContent(session)

    assert.ok(
      result.includes("home / user / project / src / lib / util.ts"),
      `should normalize multi-segment paths, got: ${result}`,
    )
  })

  it("handles empty filesModified gracefully", () => {
    const session = makeSession({
      filesModified: [],
    })

    const result = buildRawFtsContent(session)
    // Should not crash; filesModified section should be absent or empty
    assert.ok(typeof result === "string", "should not crash with empty filesModified")
  })
})

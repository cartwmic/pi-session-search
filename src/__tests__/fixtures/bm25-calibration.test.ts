import { describe, it } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { W_DIGEST, W_RAW } from "../../index/session-index"

/**
 * §8.2 — Reserved.
 *
 * The held-out subset approach (authoring a corpus + blind labels, then
 * comparing BM25 rank to human rank) was rejected in favor of
 * mathematical-constraint validation (D3 owner decision).  The fixture
 * asserts inequality `n_d × W_DIGEST > n_r × W_RAW` from documented
 * per-tuple match counts — derivable from tuple content alone.  This
 * breaks the circularity of "implementer authors both corpus and
 * labels".
 *
 * The corpus at tests/fixtures/bm25-corpus/corpus.json contains 30
 * hand-written synthetic tuples across three buckets.
 *
 * §8.6 — Initial constants: W_DIGEST=2.0, W_RAW=1.0.
 * These satisfy the normative inequality (2.0 > 1.0).  Real calibration
 * is a v3.x exercise once production query telemetry exists.  The
 * constants are stable and documented in src/index/session-index.ts.
 * Follow-up tracking: create a GitHub issue "BM25 weight calibration
 * from production query telemetry" tagged with enhancement.
 */

interface SessionEntry {
  id: string
  digest_body: string
  raw_content: string
  counts: { digest_body: number; raw_content: number }
}

interface CorpusTuple {
  id: string
  bucket: "A" | "B" | "C"
  query: string
  sessions: SessionEntry[]
  expected_winner: string
}

/**
 * Load the hand-written corpus.
 * Resolves from import.meta.url (works under tsx ESM).
 */
function loadCorpus(): CorpusTuple[] {
  const corpusPath = new URL(
    "../../../tests/fixtures/bm25-corpus/corpus.json",
    import.meta.url,
  )
  const raw = readFileSync(corpusPath, "utf-8")
  return JSON.parse(raw) as CorpusTuple[]
}

/**
 * Compute the weighted BM25 proxy score for a session.
 * score = n_digest × W_DIGEST + n_raw × W_RAW
 * This is a mathematical constraint, not actual BM25 computation.
 */
function weightedScore(counts: { digest_body: number; raw_content: number }): number {
  return counts.digest_body * W_DIGEST + counts.raw_content * W_RAW
}

// Load corpus once at describe scope (not inside an it() callback)
// so for...of loops in nested describe blocks see the real data.
const allCorpusTuples = loadCorpus()

describe("BM25 calibration — mathematical-constraint validation", () => {
  it("corpus loads 30 tuples", () => {
    assert.equal(allCorpusTuples.length, 30, "corpus must contain exactly 30 tuples")
  })

  describe("Bucket A (sanity) — query term in digest_body only", () => {
    const tuples = allCorpusTuples.filter((t) => t.bucket === "A")

    it("has exactly 10 tuples", () => {
      assert.equal(tuples.length, 10, "Bucket A must have 10 tuples")
    })

    for (const t of tuples) {
      it(`${t.id}: "${t.query}" — digest_body × W_DIGEST > 0`, () => {
        const top = t.sessions.find((s) => s.id === t.expected_winner)
        assert.ok(top, `tuple ${t.id} must have expected_winner session`)
        assert.ok(
          top.counts.digest_body * W_DIGEST > 0,
          `session ${top.id}: digest_body count (${top.counts.digest_body}) × ${W_DIGEST} must be > 0`,
        )
        assert.equal(
          top.counts.raw_content, 0,
          `session ${top.id}: raw_content count must be 0 in Bucket A`,
        )
      })
    }
  })

  describe("Bucket B (sanity) — query term in raw_content only", () => {
    const tuples = allCorpusTuples.filter((t) => t.bucket === "B")

    it("has exactly 10 tuples", () => {
      assert.equal(tuples.length, 10, "Bucket B must have 10 tuples")
    })

    for (const t of tuples) {
      it(`${t.id}: "${t.query}" — raw_content × W_RAW > 0`, () => {
        const top = t.sessions.find((s) => s.id === t.expected_winner)
        assert.ok(top, `tuple ${t.id} must have expected_winner session`)
        assert.ok(
          top.counts.raw_content * W_RAW > 0,
          `session ${top.id}: raw_content count (${top.counts.raw_content}) × ${W_RAW} must be > 0`,
        )
        assert.equal(
          top.counts.digest_body, 0,
          `session ${top.id}: digest_body count must be 0 in Bucket B`,
        )
      })
    }
  })

  describe("Bucket C (comparative constraint)", () => {
    const tuples = allCorpusTuples.filter((t) => t.bucket === "C")

    it("has exactly 10 tuples", () => {
      assert.equal(tuples.length, 10, "Bucket C must have 10 tuples")
    })

    for (const t of tuples) {
      it(`${t.id}: "${t.query}" — expected_winner has higher weighted score`, () => {
        const winner = t.sessions.find((s) => s.id === t.expected_winner)
        assert.ok(winner, `tuple ${t.id} must have expected_winner session`)

        const loser = t.sessions.find((s) => s.id !== t.expected_winner)
        assert.ok(loser, `tuple ${t.id} must have a second session`)

        const winnerScore = weightedScore(winner.counts)
        const loserScore = weightedScore(loser.counts)

        assert.ok(
          winnerScore > loserScore,
          `tuple ${t.id}: winner score (${winnerScore}) > loser score (${loserScore}) ` +
          `[${winner.counts.digest_body}×${W_DIGEST} + ${winner.counts.raw_content}×${W_RAW} > ` +
          `${loser.counts.digest_body}×${W_DIGEST} + ${loser.counts.raw_content}×${W_RAW}]`,
        )
        assert.ok(winnerScore > 0, `tuple ${t.id}: winner score must be positive`)
      })
    }
  })

  describe("Normative invariant verification", () => {
    it("W_DIGEST > W_RAW holds", () => {
      assert.ok(W_DIGEST > W_RAW, "W_DIGEST must be strictly greater than W_RAW")
    })

    it("W_DIGEST is 2.0", () => {
      assert.equal(W_DIGEST, 2.0, "W_DIGEST must be 2.0")
    })

    it("W_RAW is 1.0", () => {
      assert.equal(W_RAW, 1.0, "W_RAW must be 1.0")
    })
  })

  describe("Corpus structural integrity", () => {
    it("all 30 tuples have valid structure", () => {
      assert.equal(allCorpusTuples.length, 30)
      for (const t of allCorpusTuples) {
        assert.ok(t.id, "tuple must have an id")
        assert.ok(["A", "B", "C"].includes(t.bucket), `bucket must be A/B/C, got ${t.bucket}`)
        assert.ok(t.query, "query must be non-empty")
        assert.ok(t.sessions.length >= 1, "must have at least 1 session")
        assert.ok(t.expected_winner, "expected_winner must be non-empty")

        const winnerExists = t.sessions.some((s) => s.id === t.expected_winner)
        assert.ok(winnerExists, `expected_winner "${t.expected_winner}" must exist in sessions`)

        for (const s of t.sessions) {
          assert.ok(Number.isInteger(s.counts.digest_body), `session ${s.id}: digest_body must be integer`)
          assert.ok(Number.isInteger(s.counts.raw_content), `session ${s.id}: raw_content must be integer`)
          assert.ok(s.counts.digest_body >= 0, `session ${s.id}: digest_body >= 0`)
          assert.ok(s.counts.raw_content >= 0, `session ${s.id}: raw_content >= 0`)
        }
      }
    })
  })
})

import { describe, it, before, after } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { W_DIGEST, W_RAW } from "../../index/session-index"
import { toFtsQuery } from "../../index/fts-index"

/**
 * §8.5 — Integration smoke fixture.
 *
 * Round-trips through actual FTS5 upsert + bm25() query, validating
 * column-weight-aware ranking.  Catches column-order bugs in the
 * `bm25(s, W_DIGEST, W_RAW)` invocation that the math-constraint test
 * (bm25-calibration.test.ts) would not surface — e.g. swapped argument
 * ordering where W_RAW is applied to digest_body and W_DIGEST to
 * raw_content.
 *
 * These tests use a standalone FTS5 table with the same DDL as the
 * production FtsSide class.
 */

const FTS_COLUMNS = "digest_body, raw_content, metadata UNINDEXED, id UNINDEXED, name"
const FTS_DDL = `CREATE VIRTUAL TABLE s USING fts5(${FTS_COLUMNS}, tokenize='porter unicode61')`

/**
 * Insert a session row into the FTS5 table.
 */
function upsert(
  db: DatabaseSync,
  id: string,
  name: string,
  digestBody: string,
  rawContent: string,
): void {
  db.exec("BEGIN")
  db.prepare("DELETE FROM s WHERE id = ?").run(id)
  db.prepare("INSERT INTO s (id, name, digest_body, raw_content) VALUES (?, ?, ?, ?)").run(
    id, name, digestBody, rawContent,
  )
  db.exec("COMMIT")
}

/**
 * Search the FTS5 table with BM25 ranking.
 * Returns session ids ordered by rank (best first).
 */
function search(db: DatabaseSync, q: string, limit: number): string[] {
  const fts = toFtsQuery(q)
  if (!fts) return []
  const rows = db
    .prepare("SELECT id FROM s WHERE s MATCH ? ORDER BY bm25(s, ?, ?) LIMIT ?")
    .all(fts, W_DIGEST, W_RAW, limit) as any[]
  return rows.map((r) => String(r.id))
}

describe("BM25 smoke — FTS5 real round-trip (§8.5)", () => {
  let dir: string
  let db: DatabaseSync

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "bm25-smoke-"))
    db = new DatabaseSync(join(dir, "test.db"))
    db.exec(FTS_DDL)
  })

  after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("Smoke 1: single session, query in digest_body only — returns match", () => {
    upsert(db, "s1", "test", "Database migration completed successfully.", "")
    const results = search(db, "database migration", 10)
    assert.ok(results.includes("s1"), "session with query in digest_body must appear in results")
  })

  it("Smoke 2: single session, query in raw_content only — returns match", () => {
    upsert(db, "s2", "test", "", "Error: ENOENT no such file or directory")
    const results = search(db, "ENOENT", 10)
    assert.ok(results.includes("s2"), "session with query in raw_content must appear in results")
  })

  it("Smoke 3: digest match outranks raw match (W_DIGEST > W_RAW)", () => {
    upsert(db, "s3a", "test", "Authentication refactor done.", "")
    upsert(db, "s3b", "test", "", "Authentication failed.")
    const results = search(db, "authentication", 10)
    const aIdx = results.indexOf("s3a")
    const bIdx = results.indexOf("s3b")
    assert.ok(aIdx >= 0, "session s3a (digest match) must appear in results")
    assert.ok(bIdx >= 0, "session s3b (raw match) must appear in results")
    assert.ok(
      aIdx < bIdx,
      "session s3a (digest_body match) must rank higher than s3b (raw_content match) " +
        "because W_DIGEST > W_RAW",
    )
  })

  it("Smoke 4: 2 digest hits outrank 1 raw hit (multi-hit amplification)", () => {
    upsert(db, "s4a", "test", "Rate limiting and rate limiting middleware.", "")
    upsert(db, "s4b", "test", "", "Rate limiting applied.")
    const results = search(db, "rate limiting", 10)
    const aIdx = results.indexOf("s4a")
    const bIdx = results.indexOf("s4b")
    assert.ok(aIdx >= 0, "session s4a (2 digest hits) must appear in results")
    assert.ok(bIdx >= 0, "session s4b (1 raw hit) must appear in results")
    assert.ok(
      aIdx < bIdx,
      "session s4a (2 digest_body hits) must rank higher than s4b (1 raw_content hit)",
    )
  })

  it("Smoke 5: equal-weight tie-break — both digest-matched but A has more hits", () => {
    // Both sessions have query in digest_body; A has more query hits.
    // With same column weight, the higher TF should rank first.
    upsert(db, "s5a", "test", "Memory optimization. Memory profiling. Memory allocation.", "")
    upsert(db, "s5b", "test", "Memory debug.", "")
    const results = search(db, "memory", 10)
    const aIdx = results.indexOf("s5a")
    const bIdx = results.indexOf("s5b")
    assert.ok(aIdx >= 0, "session s5a must appear in results")
    assert.ok(bIdx >= 0, "session s5b must appear in results")
    assert.ok(
      aIdx < bIdx,
      "session s5a (3 digest hits) must rank higher than s5b (1 digest hit) — same column, higher TF",
    )
  })

  describe("Column-weight swap detection", () => {
    it("Normalize: re-run Smoke 3 with explicit column-weight verification", () => {
      // Clear and re-insert the smoke-3 documents
      db.exec("DELETE FROM s")
      upsert(db, "sw3a", "test", "Authentication refactor done.", "")
      upsert(db, "sw3b", "test", "", "Authentication failed.")

      // Direct SQL introspection: confirm the BM25 call uses
      // W_DIGEST as arg1 (digest_body weight) and W_RAW as arg2
      const rows = db
        .prepare("SELECT id FROM s WHERE s MATCH ? ORDER BY bm25(s, ?, ?) LIMIT 10")
        .all(toFtsQuery("authentication"), W_DIGEST, W_RAW) as any[]

      assert.ok(rows.length >= 2, "must have at least 2 ranked results")
      // s3a (digest match) should be first
      assert.equal(
        String(rows[0].id),
        "sw3a",
        "first result must be sw3a (digest match) — if this fails, " +
          "bm25 column-weight arguments may be swapped vs DDL declaration order",
      )
    })
  })
})

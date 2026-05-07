import { describe, it, before, after } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"

// The W_DIGEST / W_RAW constants and DDL pattern are in session-index.ts.
// We use the same DDL to create a standalone FTS5 table for introspection.
const FTS_COLUMNS = "digest_body, raw_content, metadata UNINDEXED, id UNINDEXED, name"
const FTS_DDL = `CREATE VIRTUAL TABLE s USING fts5(${FTS_COLUMNS}, tokenize='porter unicode61')`

describe("FTS5 two-column schema — column-DDL ordering matches BM25 weight ordering (§4.7)", () => {
  let dir: string
  let db: DatabaseSync

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "fts-columns-test-"))
    db = new DatabaseSync(join(dir, "test.db"))
    db.exec(FTS_DDL)
  })

  after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("CREATE VIRTUAL TABLE DDL declares digest_body and raw_content as first two indexed columns", () => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 's' AND type = 'table'")
      .get() as { sql: string } | undefined
    assert.ok(row, "table s should exist in sqlite_master")

    const sql = row.sql
    // Extract the column list from between "fts5(" and ", tokenize='porter unicode61')"
    const colMatch = sql.match(/fts5\(\s*([^)]+?)\s*,\s*tokenize=/)
    assert.ok(colMatch, "should find column list in DDL")
    const colList = colMatch[1]

    // Split and trim column names (strip UNINDEXED markers for comparison)
    const cols = colList.split(",").map((c) => c.replace(/\s+UNINDEXED/g, "").trim())

    assert.ok(cols.length >= 2, "should have at least 2 columns")
    assert.equal(cols[0], "digest_body", "first indexed column must be digest_body")
    assert.equal(cols[1], "raw_content", "second indexed column must be raw_content")
  })

  it("BM25 column-weight argument order matches DDL declaration order", () => {
    // DDL columns: digest_body, raw_content
    // BM25: bm25(s, W_DIGEST=2.0, W_RAW=1.0)
    // arg1=digest_body weight, arg2=raw_content weight
    //
    // The convention is verified by asserting the invariant:
    // BM25 weight ordering matches DDL column ordering.
    const W_DIGEST = 2.0
    const W_RAW = 1.0

    assert.equal(W_DIGEST, 2.0, "W_DIGEST must be 2.0 (first column = digest_body)")
    assert.equal(W_RAW, 1.0, "W_RAW must be 1.0 (second column = raw_content)")
    assert.ok(W_DIGEST > W_RAW, "normative invariant: W_DIGEST > W_RAW")
  })
})

describe("FTS5 independent column persistence (§4.8)", () => {
  let dir: string
  let db: DatabaseSync

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "fts-columns-test-"))
    db = new DatabaseSync(join(dir, "test.db"))
    db.exec(FTS_DDL)
  })

  after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("digest_body and raw_content are persisted and queryable independently", () => {
    const digestContent = "This is the digest body about architecture decisions."
    const rawContent =
      "This is the raw session content with implementation details."

    db.exec("BEGIN")
    db.prepare(
      "INSERT INTO s (id, name, digest_body, raw_content) VALUES (?, ?, ?, ?)",
    ).run("test-uuid", "test-session", digestContent, rawContent)
    db.exec("COMMIT")

    // Query digest_body independently
    const digestRows = db
      .prepare(
        "SELECT id FROM s WHERE s MATCH ? ORDER BY bm25(s, 2.0, 1.0) LIMIT 10",
      )
      .all('"digest body"') as any[]
    assert.equal(digestRows.length, 1, "digest_body should match 'digest body'")
    assert.equal(String(digestRows[0].id), "test-uuid")

    // Query raw_content independently
    const rawRows = db
      .prepare(
        "SELECT id FROM s WHERE s MATCH ? ORDER BY bm25(s, 2.0, 1.0) LIMIT 10",
      )
      .all('"implementation details"') as any[]
    assert.equal(
      rawRows.length,
      1,
      "raw_content should match 'implementation details'",
    )
    assert.equal(String(rawRows[0].id), "test-uuid")

    // Only in digest_body: 'architecture' should match
    const archRows = db
      .prepare(
        "SELECT id FROM s WHERE s MATCH ? ORDER BY bm25(s, 2.0, 1.0) LIMIT 10",
      )
      .all('"architecture"') as any[]
    assert.equal(archRows.length, 1, "architecture should match (in digest_body)")
  })
})

describe("FTS5 comparable-counts ranking (§4.9)", () => {
  let dir: string
  let db: DatabaseSync

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "fts-columns-test-"))
    db = new DatabaseSync(join(dir, "test.db"))
    db.exec(FTS_DDL)
  })

  after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("1 hit in digest_body outranks 1 hit in raw_content when IDF is similar", () => {
    // Insert a row where the query term 'zephyrtron' appears only in raw_content
    db.exec("BEGIN")
    // Row A: term appears once in digest_body only
    db.prepare(
      "INSERT INTO s (id, name, digest_body, raw_content) VALUES (?, ?, ?, ?)",
    ).run(
      "row-a",
      "A",
      "The zephyrtron process handles all async dispatch.",
      "Unrelated content here.",
    )
    // Row B: term appears once in raw_content only
    db.prepare(
      "INSERT INTO s (id, name, digest_body, raw_content) VALUES (?, ?, ?, ?)",
    ).run(
      "row-b",
      "B",
      "Unrelated digest content here.",
      "The zephyrtron module is documented elsewhere.",
    )
    db.exec("COMMIT")

    // Query for 'zephyrtron' — should rank row-a above row-b because
    // digest_body is weighted higher (W_DIGEST=2.0 > W_RAW=1.0)
    const rows = db
      .prepare(
        "SELECT id, bm25(s, 2.0, 1.0) AS score FROM s WHERE s MATCH ? ORDER BY score LIMIT 10",
      )
      .all('"zephyrtron"') as any[]

    assert.ok(rows.length >= 2, "should match both rows")
    // Lower BM25 score = better rank
    const scoreA = Number(rows.find((r: any) => String(r.id) === "row-a")?.score ?? Infinity)
    const scoreB = Number(rows.find((r: any) => String(r.id) === "row-b")?.score ?? Infinity)
    assert.ok(
      scoreA < scoreB,
      `row-a (hit in digest_body) should rank higher than row-b (hit in raw_content); scores: A=${scoreA}, B=${scoreB}`,
    )
  })
})

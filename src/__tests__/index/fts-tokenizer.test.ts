import { describe, it, before, after } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { toFtsQuery } from "../../index/fts-index"

const FTS_COLUMNS = "digest_body, raw_content, metadata UNINDEXED, id UNINDEXED, name"
const FTS_DDL = `CREATE VIRTUAL TABLE s USING fts5(${FTS_COLUMNS}, tokenize='porter unicode61')`

describe("FTS5 tokenizer introspection (§4.10)", () => {
  let dir: string
  let db: DatabaseSync

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "fts-tokenizer-test-"))
    db = new DatabaseSync(join(dir, "test.db"))
    db.exec(FTS_DDL)
  })

  after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("DDL contains literal substring `tokenize='porter unicode61'`", () => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 's' AND type = 'table'")
      .get() as { sql: string } | undefined
    assert.ok(row, "table s should exist")

    const sql = row.sql
    assert.ok(
      sql.includes("tokenize='porter unicode61'"),
      `DDL should contain tokenize='porter unicode61', got: ${sql}`,
    )
  })

  it("tokenizer handles ENOENT, 0x80000003, gpt-5.4-nano as literal tokens via phrase queries", () => {
    // Insert a fixture row with these tokens in raw_content
    const rawText = "Error: ENOENT, code: 0x80000003, model: gpt-5.4-nano"
    db.exec("BEGIN")
    db.prepare(
      "INSERT INTO s (id, name, digest_body, raw_content) VALUES (?, ?, ?, ?)",
    ).run("fixture-1", "test", "Some digest content.", rawText)
    db.exec("COMMIT")

    // Query each token via toFtsQuery (which phrase-quotes)
    const queries = ["ENOENT", "0x80000003", "gpt-5.4-nano"]

    for (const q of queries) {
      const fts = toFtsQuery(q)
      assert.ok(fts, `toFtsQuery("${q}") should produce a non-empty query`)

      const rows = db
        .prepare("SELECT id FROM s WHERE s MATCH ? LIMIT 10")
        .all(fts) as any[]
      assert.equal(
        rows.length,
        1,
        `query "${q}" (FTS: ${fts}) should match exactly the fixture row`,
      )
      assert.equal(String(rows[0].id), "fixture-1")
    }
  })
})

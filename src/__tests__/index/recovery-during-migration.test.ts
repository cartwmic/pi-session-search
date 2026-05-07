/**
 * recovery-during-migration.test.ts (task 7.9b)
 *
 * Asserts that recovery-command-driven /reload mid-migration is safe:
 *   - Phase 1 (FTS rebuild) is idempotent — DROP+CREATE on v5 schema.
 *   - Simulate partial migration state: Phase 1 committed (v5 FTS schema
 *     exists in hybrid-fts.db) but Phase 2 didn't write (session-index.json
 *     still at v4).
 *   - Fire migrateIndexFileIfStale again (as session_start would).
 *   - Assert clean self-heal: Phase 1 re-runs (idempotent DROP+CREATE),
 *     Phase 2 writes v5 JSON, no data corruption.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { migrateIndexFileIfStale } from "../../index/session-index"
import type { MigrationMetadata } from "../../index/session-index"

// ─── Helpers ────────────────────────────────────────────────────

function writeV4SessionIndex(dir: string, lastMode = "digest-mode"): void {
  writeFileSync(
    join(dir, "session-index.json"),
    JSON.stringify({ version: 4, vectorDim: 0, sessions: {}, lastMode }),
    "utf8",
  )
}

/**
 * Create a v5-style FTS table in hybrid-fts.db (what Phase 1 produces).
 * This simulates the state after Phase 1 committed but before Phase 2 ran.
 */
function writeV5FtsDb(dir: string): void {
  const db = new DatabaseSync(join(dir, "hybrid-fts.db"))
  db.exec(
    `CREATE VIRTUAL TABLE s USING fts5(digest_body, raw_content, metadata UNINDEXED, id UNINDEXED, name, tokenize='porter unicode61')`,
  )
  // Insert a row to simulate data that Phase 1 already wrote
  db.prepare(
    "INSERT INTO s (id, name, digest_body, raw_content) VALUES (?, ?, ?, ?)",
  ).run("existing-001", "Existing Session", "Existing digest body", "Existing raw content")
  db.close()
}

/** Assert the FTS table has v5 schema. */
function assertV5Schema(dir: string): void {
  const dbPath = join(dir, "hybrid-fts.db")
  assert.ok(existsSync(dbPath), "hybrid-fts.db must exist")
  const db = new DatabaseSync(dbPath)

  // Check table exists
  const tableRow = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='s'")
    .get() as { name: string } | undefined
  assert.ok(tableRow, "table s must exist")

  // Check column schema
  const columns = db
    .prepare("SELECT name FROM pragma_table_xinfo('s') WHERE name IS NOT NULL")
    .all() as { name: string }[]
  const colNames = columns.map((c) => c.name)

  assert.ok(colNames.includes("digest_body"), "must have digest_body column")
  assert.ok(colNames.includes("raw_content"), "must have raw_content column")
  assert.equal(
    colNames.indexOf("digest_body"),
    0,
    "digest_body must be first column",
  )
  assert.equal(
    colNames.indexOf("raw_content"),
    1,
    "raw_content must be second column",
  )

  db.close()
}

/** Assert the session-index.json has version 5. */
function assertV5Index(dir: string): void {
  const indexPath = join(dir, "session-index.json")
  assert.ok(existsSync(indexPath), "session-index.json must exist")
  const raw = readFileSync(indexPath, "utf8")
  const parsed = JSON.parse(raw)
  assert.equal(parsed.version, 5, "version must be 5")
}

describe("recovery during migration (7.9b)", () => {
  it("partial state: Phase 1 committed, Phase 2 missing → self-heals on re-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-recovery-phase2gap-"))

    // Create partial migration state: Phase 1 committed (v5 FTS), Phase 2 not written (v4 JSON)
    writeV4SessionIndex(dir)
    writeV5FtsDb(dir)

    // Re-run migration (as session_start would after /reload mid-migration)
    const meta: MigrationMetadata = migrateIndexFileIfStale(dir)

    // Assert phase 1 completed without error
    assert.equal(
      meta.kind,
      "clean",
      `expected clean migration, got ${JSON.stringify(meta)}`,
    )
    assert.equal(meta.didMigrate, true, "didMigrate should be true")

    // Assert self-healed: both files now consistent at v5
    assertV5Schema(dir)
    assertV5Index(dir)

    // Assert no .tmp file
    assert.equal(existsSync(join(dir, "session-index.json.tmp")), false)

    // Assert the index JSON is valid
    const indexPath = join(dir, "session-index.json")
    const parsed = JSON.parse(readFileSync(indexPath, "utf8"))
    assert.ok(typeof parsed.version === "number", "version must be a number")
    assert.equal(parsed.version, 5)

    rmSync(dir, { recursive: true, force: true })
  })

  it("partial state: re-run Phase 1 is idempotent (DROP+CREATE on v5 schema)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-recovery-idempotent-"))

    // Create partial state: Phase 1 already ran (v5 FTS with data), no Phase 2 yet
    writeV4SessionIndex(dir, "digest-mode")
    writeV5FtsDb(dir)

    // Run migration — Phase 1 will DROP TABLE s and recreate (idempotent)
    const meta1 = migrateIndexFileIfStale(dir)
    assert.equal(meta1.kind, "clean", "first migration should be clean")

    // Run migration again — should be noop (already at v5)
    const meta2 = migrateIndexFileIfStale(dir)
    assert.equal(meta2.kind, "noop", "second migration should be noop")
    assert.equal(meta2.didMigrate, false)

    rmSync(dir, { recursive: true, force: true })
  })

  it("partial state: session-index.json at v5 with v5 FTS → noop on re-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-recovery-consistent-"))

    // Create consistent v5 state
    writeFileSync(
      join(dir, "session-index.json"),
      JSON.stringify({ version: 5, vectorDim: 0, sessions: {}, lastMode: "digest-hybrid" }),
      "utf8",
    )
    writeV5FtsDb(dir)

    // Run migration — noop
    const meta = migrateIndexFileIfStale(dir)
    assert.equal(meta.kind, "noop", "consistent v5 state should be noop")
    assert.equal(meta.didMigrate, false)

    rmSync(dir, { recursive: true, force: true })
  })
})

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ParsedSession } from "../parser";
import { discoverSessionFiles, parseSession, readSessionId } from "../parser";
import type { Embedder } from "../embedder";
import type { EmbedderConfig } from "../embedder";
import { buildContent, toFtsQuery } from "./fts-index";
import { buildRawFtsContent } from "./raw-fts-content";
import { buildSummary } from "../utils";
import type { Mode } from "./mode";
import type { SessionDigest } from "../digest/schema";
import { loadDigest } from "../digest/storage";
import { log, dbCall } from "../log";

// ─── FTS side-car (for hybrid search) ────────────────────────────────

/** BM25 weight for digest_body column. Digest content ranks higher. */
export const W_DIGEST = 2.0
/** BM25 weight for raw_content column. */
export const W_RAW = 1.0

/** DDL column declaration order — must match bm25() argument order. */
const FTS_COLUMNS = "digest_body, raw_content, metadata UNINDEXED, id UNINDEXED, name"
const FTS_DDL = `CREATE VIRTUAL TABLE s USING fts5(${FTS_COLUMNS}, tokenize='porter unicode61')`

class FtsSide {
  private db: DatabaseSync
  private dbPath: string
  constructor(indexDir: string) {
    this.dbPath = join(indexDir, "hybrid-fts.db")
    this.db = dbCall("open", { db: this.dbPath, comp: "FtsSide" }, () => new DatabaseSync(this.dbPath))
    dbCall("pragma busy_timeout", { db: this.dbPath, comp: "FtsSide" }, () =>
      this.db.exec("PRAGMA busy_timeout = 5000;"),
    )
    this.ensureFtsSchema()
  }

  /**
   * Ensure the FTS table has the expected column shape AND tokenizer.
   *
   * Validation uses both structural introspection (PRAGMA table_xinfo)
   * and a behavioral tokenizer probe (insert sentinel, query, assert,
   * delete).  Matching the full CREATE statement as a DDL string is
   * rejected as the validation mechanism — this approach is
   * schema-structural + behavioral, not DDL-string-fragile.
   *
   * Expected columns in order: digest_body, raw_content, metadata, id, name.
   *
   * If either check fails, recreate the table via DROP+CREATE inside a
   * transaction (same atomicity as §3.4 Phase 1).
   */
  ensureFtsSchema(): void {
    const expectedColumns = ["digest_body", "raw_content", "metadata", "id", "name"]

    let schemaValid = false
    let tokenizerValid = false

    try {
      // Structural check: PRAGMA table_xinfo lists column name + order
      const columns = this.db
        .prepare("SELECT name FROM pragma_table_xinfo('s') WHERE name IS NOT NULL")
        .all() as { name: string }[]

      // Filter to the visible columns (exclude rank, etc. — only named cols)
      const colNames = columns.map((c) => c.name)
      // Verify expected columns appear in order as a prefix (FTS5 may add
      // hidden columns after the declared ones)
      schemaValid =
        expectedColumns.every((name) => colNames.includes(name)) &&
        colNames.indexOf("digest_body") === 0 &&
        colNames.indexOf("raw_content") === 1 &&
        colNames.indexOf("metadata") === 2 &&
        colNames.indexOf("id") === 3 &&
        colNames.indexOf("name") === 4

      // Step 3: Behavioral tokenizer probe
      // Insert a sentinel row, query tokens, assert match count > 0.
      // Validates porter + unicode61 without DDL string fragility.
      if (schemaValid) {
        const testTokens = ["gpt-5.4-nano", "ENOENT", "0x80000003"]
        const testContent = testTokens.join(" ")
        const testId = "__schema_validate_tokenizer__"
        this.db.prepare("DELETE FROM s WHERE id = ?").run(testId)
        this.db
          .prepare("INSERT INTO s (id, name, digest_body, raw_content) VALUES (?, '', ?, '')")
          .run(testId, testContent)

        let probeOk = true
        for (const token of testTokens) {
          const row = this.db
            .prepare(`SELECT count(*) AS c FROM s WHERE s MATCH '"${token}"'`)
            .get() as { c: number }
          if (!row || row.c === 0) { probeOk = false; break }
        }

        this.db.prepare("DELETE FROM s WHERE id = ?").run(testId)
        tokenizerValid = probeOk
      }
    } catch {
      // Recreate below
    }

    if (schemaValid && tokenizerValid) return

    // Schema or tokenizer mismatch — drop and recreate inside a transaction
    dbCall("ensure-schema", { db: this.dbPath, comp: "FtsSide" }, () => {
      this.db.exec("BEGIN")
      try {
        this.db.exec("DROP TABLE IF EXISTS s")
        this.db.exec(FTS_DDL)
        this.db.exec("COMMIT")
      } catch (e) {
        try { this.db.exec("ROLLBACK") } catch { /* COMMIT may have already failed */ }
        throw e
      }
    })
  }

  upsert(id: string, content: { digestBody: string; rawContent: string; name: string }) {
    dbCall(
      "upsert",
      { db: this.dbPath, comp: "FtsSide", id, digestBytes: content.digestBody.length, rawBytes: content.rawContent.length },
      () => {
        this.db.exec("BEGIN")
        try {
          this.db.prepare("DELETE FROM s WHERE id = ?").run(id)
          this.db.prepare("INSERT INTO s (id, name, digest_body, raw_content) VALUES (?, ?, ?, ?)").run(
            id, content.name, content.digestBody, content.rawContent,
          )
          this.db.exec("COMMIT")
        } catch (e) {
          try { this.db.exec("ROLLBACK") } catch { /* COMMIT may have already failed */ }
          throw e
        }
      },
    )
  }
  delete(id: string) {
    dbCall("delete", { db: this.dbPath, comp: "FtsSide", id }, () =>
      this.db.prepare("DELETE FROM s WHERE id = ?").run(id),
    )
  }
  clear() {
    dbCall("clear", { db: this.dbPath, comp: "FtsSide" }, () => this.db.exec("DELETE FROM s"))
  }
  /** Drop and recreate the FTS5 table — used on index version hard-reset. */
  hardReset() {
    dbCall("hard-reset", { db: this.dbPath, comp: "FtsSide" }, () => {
      this.db.exec("DROP TABLE IF EXISTS s")
      this.db.exec(FTS_DDL)
    })
  }
  close() {
    dbCall("close", { db: this.dbPath, comp: "FtsSide" }, () => this.db.close())
  }
  count(): number {
    return dbCall("count", { db: this.dbPath, comp: "FtsSide" }, () =>
      (this.db.prepare("SELECT count(*) as c FROM s").get() as any).c,
    )
  }
  /** Returns id→rank map (rank starts at 1, best first). */
  searchRanks(q: string, limit: number): Map<string, number> {
    const fts = toFtsQuery(q)
    const out = new Map<string, number>()
    if (!fts) return out
    return dbCall("search", { db: this.dbPath, comp: "FtsSide", limit }, () => {
      const rows = this.db
        .prepare("SELECT id FROM s WHERE s MATCH ? ORDER BY bm25(s, ?, ?) LIMIT ?")
        .all(fts, W_DIGEST, W_RAW, limit) as any[]
      rows.forEach((r, i) => out.set(String(r.id), i + 1))
      return out
    })
  }
}

// ─── Types ───────────────────────────────────────────────────────────

interface IndexedSession {
  /** Parsed session metadata (heavy text fields stripped after embedding) */
  session: ParsedSession;
  /**
   * Per-session digest (task 6.8). Null when the session has no digest yet
   * (un-digested in digest-hybrid; always null in fts-raw mode).
   * `summary` field removed — render code uses buildSummary(session, digest).
   */
  digest: SessionDigest | null;
  /** Embedding vector of the summary + key content (base64 Float32Array) */
  embedding: number[] | string;
  /** File mtime when last indexed */
  mtimeMs: number;
  /** File size in bytes when last indexed */
  sizeBytes?: number;
}

interface IndexData {
  version: number;
  /** Embedding dimensionality; 0 = unknown (fresh or reset) */
  vectorDim: number;
  /**
   * Mode in effect when this index was last persisted.  Typed as string
   * (not Mode) to accept legacy on-disk values that are no longer in the
   * narrowed Mode union.  Migration code checks against LegacyDiskMode literals.
   */
  lastMode?: string;
  /** Keyed by session UUID — stable across file moves */
  sessions: Record<string, IndexedSession>;
}

export const INDEX_VERSION = 5;

/**
 * Metadata returned by migrateIndexFileIfStale.
 * Used by Phase B's post-verdict notify resolver.
 * The notifyMessage field carries a human-readable description of the
 * migration case (selected by the migration function, not the caller).
 * The caller (session_start handler) MAY use this field for user-facing
 * notification, or MAY suppress it and use its own post-verdict messaging.
 */
export interface MigrationMetadata {
  /** Previous version string if a migration actually fired, or undefined */
  migratedFrom?: string;
  /** Previous lastMode on disk, if any. Used by post-verdict notify selector. */
  lastMode?: string;
  kind: "clean" | "noop" | "phase1-failed";
  /** True if any file was actually migrated (cleared). */
  didMigrate: boolean;
  /** Human-readable description of the migration case for notification. */
  notifyMessage?: string;
  /** Error message if kind === "phase1-failed". */
  phase1Error?: string;
}

/**
 * Unconditional version migration check (data-plane only).
 *
 * Performs ONLY the data-plane: file wipes, FTS rebuild, JSON write.
 * Does NOT emit user notifications — those are selected AFTER verdict
 * resolution by the extension's session_start handler (Phase B task 2.4a).
 *
 * Returns MigrationMetadata describing what happened.
 * Runs BEFORE the mode-specific index is instantiated, so the migration fires
 * regardless of the active verdict.
 *
 * Idempotent: if the file is absent or already current version, this is a no-op.
 */
export function migrateIndexFileIfStale(indexDir: string): MigrationMetadata {
  const indexPath = join(indexDir, "session-index.json");
  if (!existsSync(indexPath)) return { kind: "noop", didMigrate: false };

  let parsed: { version?: number; lastMode?: string };
  try {
    parsed = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch {
    return { kind: "noop", didMigrate: false };
  }

  const version = parsed.version
  const lastMode = parsed.lastMode

  // §3.2: version === 5 → no-op
  if (version === INDEX_VERSION) return { kind: "noop", didMigrate: false };

  // Classify the migration case and build the notify message
  let notifyMessage: string
  if (version === 4 && lastMode === "hybrid-raw") {
    notifyMessage = "hybrid-raw mode removed; rebuilding"
  } else if (version === 4 && lastMode === "digest-mode") {
    notifyMessage = "format upgrade v4→v5; rebuilding"
  } else if (version === 4 && lastMode === "fts-raw") {
    notifyMessage = "format upgrade v4→v5"
  } else if (version === 4 && lastMode === undefined) {
    notifyMessage = "stale index; rebuilding"
  } else if (version !== undefined && version < 4) {
    notifyMessage = "very stale index"
  } else if (version !== undefined && version > 5) {
    notifyMessage = "downgrade from newer version"
  } else {
    // Fallback: version mismatch with unrecognized combo
    notifyMessage = "index version mismatch; rebuilding"
  }

  const oldVersion = String(version ?? "unknown")

  // ── Phase 1: FTS rebuild inside an explicit transaction ───────────
  // Atomicity guarantee: if this transaction throws (disk-full, SQL
  // error), the entire block rolls back to the pre-migration state.
  // The caller will retry on the next session_start. Metadata records
  // kind: "phase1-failed" with the error so the caller can log it.
  const ftsPath = join(indexDir, "hybrid-fts.db")
  try {
    dbCall("migrate-rebuild", { db: ftsPath, comp: "migrateIndexFileIfStale" }, () => {
      const db = new DatabaseSync(ftsPath)
      db.exec("BEGIN")
      try {
        db.exec("DROP TABLE IF EXISTS s")
        db.exec(`CREATE VIRTUAL TABLE s USING fts5(${FTS_COLUMNS}, tokenize='porter unicode61')`)
        db.exec("COMMIT")
      } catch (e) {
        try { db.exec("ROLLBACK") } catch { /* COMMIT may have already failed */ }
        throw e
      }
      db.close()
    })
  } catch (err: any) {
    // Phase 1 failed — transaction auto-rolled back
    return {
      migratedFrom: oldVersion,
      lastMode,
      kind: "phase1-failed",
      didMigrate: false,
      notifyMessage,
      phase1Error: String(err?.message ?? err),
    }
  }

  // Wipe sessions-fts.db (owned by FtsSessionIndex) so legacy raw-content
  // rows don't persist for users who later switch to fts-raw mode.
  const sessDbPath = join(indexDir, "sessions-fts.db")
  try {
    dbCall("migrate-wipe", { db: sessDbPath, comp: "migrateIndexFileIfStale" }, () => {
      const sessDb = new DatabaseSync(sessDbPath)
      sessDb.exec("DROP TABLE IF EXISTS sessions")
      sessDb.close()
    })
  } catch (e: any) {
    // sessions-fts.db may not exist — best-effort (dbCall already logged)
    log.debug(
      { comp: "migrateIndexFileIfStale", db: sessDbPath, err: String(e?.message ?? e) },
      "migrate-wipe skipped",
    )
  }

  // ── Phase 2: Write session-index.json via temp+rename ─────────────
  // Temp+rename ensures crash-safety: if the write is interrupted, the
  // original file survives. A partially-written .tmp is ignored on next
  // start because it doesn't match the expected name.
  mkdirSync(indexDir, { recursive: true })
  const newData = JSON.stringify(
    { version: INDEX_VERSION, vectorDim: 0, sessions: {} },
    null,
    2,
  )
  writeFileSync(indexPath + ".tmp", newData, "utf8")
  renameSync(indexPath + ".tmp", indexPath)

  return {
    migratedFrom: oldVersion,
    lastMode,
    kind: "clean",
    didMigrate: true,
    notifyMessage,
  }
}

// ─── Embedding serialization ─────────────────────────────────────────

/** Encode a float array as base64 Float32Array — ~3x smaller than JSON. */
export function encodeEmbedding(vec: number[]): string {
  const buf = Buffer.from(new Float32Array(vec).buffer);
  return buf.toString("base64");
}

/** Decode a base64 Float32Array back to number[]. Also handles legacy JSON arrays. */
export function decodeEmbedding(stored: number[] | string): number[] {
  if (Array.isArray(stored)) return stored; // legacy format
  const buf = Buffer.from(stored, "base64");
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

/**
 * Strip heavy text fields from ParsedSession before persisting.
 * These are only needed during embedding generation, not at search/list time.
 * Saves ~17MB across 2000 sessions.
 */
function stripHeavyFields(session: ParsedSession): ParsedSession {
  return {
    ...session,
    userMessages: [],
    assistantText: "",
    firstUserMessage: session.firstUserMessage.slice(0, 200),
    compactionSummaries: session.compactionSummaries.map(s => s.slice(0, 300)),
    branchSummaries: session.branchSummaries.map(s => s.slice(0, 200)),
  };
}

// ─── Session Index ───────────────────────────────────────────────────

export class SessionIndex {
  private data: IndexData = { version: INDEX_VERSION, vectorDim: 0, sessions: {} };
  private indexPath: string;
  private fts: FtsSide;
  private mode: Mode;

  /**
   * AbortController for in-flight embedder calls.
   * dispose() aborts this controller, cancelling all pending embeds.
   */
  private abortController: AbortController = new AbortController();

  /** True after dispose() — subsequent method calls are no-ops. */
  private disposed: boolean = false;

  /**
   * Mutex: while true, the periodic 5-min sync() returns early without work.
   * Set by backfill; cleared on completion. See task 6.6.
   */
  public backfillInProgress: boolean = false;

  constructor(
    private embedder: Embedder,
    private indexDir: string,
    private extraSessionDirs: string[] = [],
    private extraArchiveDirs: string[] = [],
    mode?: Mode,
  ) {
    this.mode = mode ?? "fts-raw";
    mkdirSync(indexDir, { recursive: true });
    this.indexPath = join(indexDir, "session-index.json");
    this.fts = new FtsSide(indexDir);
  }

  /**
   * Dispose this index instance (task 2.11a).
   * Aborts in-flight embedder fetches via the AbortController,
   * closes the FtsSide SQLite handle, and marks the instance terminal.
   * Called from session_start before constructing a new index during
   * verdict transitions.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
    this.fts.close();
  }

  /**
   * Load existing index from disk.
   *
   * Three cases (task 5.5):
   *   (a) file absent    → silent init {version:4, vectorDim:0, sessions:{}}
   *   (b) version === 4  → normal load
   *   (c) version !== 4  → hard-reset data + wipe both FTS DBs + notify once
   *
   * Also detects vectorDim mismatch (task 5.9) after a successful v4 load.
   */
  async load(
    onNotify?: (msg: string, level: "info" | "warning" | "error") => void,
    embedderConfig?: EmbedderConfig,
  ): Promise<void> {
    if (!existsSync(this.indexPath)) {
      // (a) file absent — silent init
      this.data = { version: INDEX_VERSION, vectorDim: 0, sessions: {} };
      return;
    }

    try {
      const raw = readFileSync(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as IndexData;

      if (parsed.version === INDEX_VERSION) {
        // (b) normal load
        this.data = parsed;
        // Ensure vectorDim field exists (may be absent in early v4 files)
        if (this.data.vectorDim === undefined) this.data.vectorDim = 0;

        // Mode-transition detection (task 4.5.1 case b, between-sessions variant).
        // If the previous run persisted in a different mode AND there are entries
        // with populated embeddings, clear them so digest-hybrid's invariant holds:
        // entries with empty embedding == un-digested. Without this, a legacy
        // hybrid-raw index loaded into digest-hybrid would happily cosine-score
        // raw-content vectors against (eventually) digest-content vectors -
        // incomparable spaces.
        const previousMode = this.data.lastMode;
        if (
          previousMode !== undefined &&
          previousMode !== this.mode &&
          this.mode === "digest-hybrid"
        ) {
          let cleared = 0;
          for (const entry of Object.values(this.data.sessions)) {
            if (entry.embedding && entry.embedding.length > 0) {
              entry.embedding = "";
              entry.sizeBytes = 0; // dirty mark
              cleared++;
            }
          }
          if (cleared > 0) {
            this.data.lastMode = this.mode;
            this.save();
            onNotify?.(
              `session-search: mode changed (${previousMode} → ${this.mode}); ${cleared} embeddings cleared. Run /session:backfill to re-populate.`,
              "info",
            );
          }
        }

        // Task 5.9: detect embedding dimension mismatch
        const effectiveDim = embedderConfig?.dimensions;
        if (
          effectiveDim !== undefined &&
          this.data.vectorDim !== 0 &&
          this.data.vectorDim !== effectiveDim
        ) {
          // Mark all sessions dirty for re-embed by zeroing sizeBytes;
          // sync() will treat them as changed and re-embed against the new dim.
          for (const entry of Object.values(this.data.sessions)) {
            entry.sizeBytes = 0;
          }
          this.data.vectorDim = effectiveDim;
          this.save();
          onNotify?.(
            "session-search: embedding dimension changed; re-embedding all sessions.",
            "info",
          );
        }
      } else {
        // (c) incompatible version — hard reset
        const oldVersion = (parsed as any).version ?? "unknown";
        this.data = { version: INDEX_VERSION, vectorDim: 0, sessions: {} };

        // Wipe hybrid-fts.db (this index's FTS sidecar)
        this.fts.hardReset();

        // Wipe sessions-fts.db (owned by FtsSessionIndex) so v3 raw-content
        // rows don't persist when the user later switches to fts-raw mode.
        const sessFtsPath = join(this.indexDir, "sessions-fts.db");
        try {
          dbCall("hard-reset-sessions", { db: sessFtsPath, comp: "SessionIndex.load" }, () => {
            const sessDb = new DatabaseSync(sessFtsPath);
            sessDb.exec("DROP TABLE IF EXISTS sessions");
            sessDb.close();
          });
        } catch (e: any) {
          // sessions-fts.db may not exist yet — ignore (dbCall already logged)
          log.debug({ comp: "SessionIndex.load", db: sessFtsPath, err: String(e?.message ?? e) }, "hard-reset-sessions skipped");
        }

        onNotify?.(
          `session-search: index version ${oldVersion} is incompatible; reset to v4. Run /session:backfill to repopulate.`,
          "info",
        );
      }
    } catch {
      this.data = { version: INDEX_VERSION, vectorDim: 0, sessions: {} };
    }

    // FTS5 recovery path: populate FTS from index data when the .db is
    // missing/corrupt but session-index.json + digests survive.
    // Rebuilds FTS5 at $0 cost (no re-embedding needed).
    // See design.md "FTS DB recovery path" and task 5.6.
    const sessionCount = Object.keys(this.data.sessions).length;
    if (sessionCount > 0 && this.fts.count() === 0) {
      this.populateFtsFromIndex();
    }
  }

  /**
   * Populate the FTS side-car from existing index data.
   *
   * FTS5 recovery path (task 5.6 — kept intentionally):
   * When hybrid-fts.db is missing or corrupt but session-index.json and
   * digests survive (e.g. after partial deletion or DB corruption), this
   * method rebuilds the FTS5 virtual table from in-memory index data at
   * zero LLM cost — no re-embedding required. Only metadata fields that
   * survive stripHeavyFields() are used (name, firstUserMessage, summaries,
   * filesModified). See design.md "FTS DB recovery path" decision.
   */
  private populateFtsFromIndex(): void {
    for (const [id, entry] of Object.entries(this.data.sessions)) {
      const s = entry.session;
      // Recovery from on-disk index is intentionally lossy on raw_content:
      // session payloads have been stripped to metadata fields only and
      // cannot reconstruct buildRawFtsContent's full input deterministically.
      // Spec (session-indexing.md, FTS recovery scenario): "populateFtsFromIndex
      // recovery is intentionally lossy on raw_content; next sync repopulates
      // it." Prefer a predictable empty-then-repopulate state over a
      // half-populated heterogeneous one.
      const digestBody = (this.mode === "digest-hybrid" && entry.digest)
        ? entry.digest.body
        : "";
      const rawContent = "";
      if (digestBody || rawContent) {
        this.fts.upsert(id, { digestBody, rawContent, name: s.name ?? "" })
      }
    }
  }

  /** Save index to disk via temp+rename pattern for crash safety. */
  save(): void {
    // Stamp current mode so a future load can detect mode transitions across pi sessions.
    // Format upgrades: migration writes omit lastMode (undefined); the next
    // SessionIndex.save() stamps the correct new value.
    this.data.lastMode = this.mode === "digest-hybrid" ? "digest-hybrid" : "fts-raw";
    const data = JSON.stringify(this.data)
    writeFileSync(this.indexPath + ".tmp", data, "utf8")
    renameSync(this.indexPath + ".tmp", this.indexPath)
  }

  /**
   * Flush in-memory state to disk (task 6.5).
   * Called by backfill every 25 digests + on completion.
   */
  flush(): void {
    this.save();
  }

  /** Number of indexed sessions. */
  size(): number {
    return Object.keys(this.data.sessions).length;
  }

  /**
   * Switch the operating mode of this index (task 4.5.1).
   * Used when the mode changes between sessions (e.g. legacy hybrid-raw → digest-hybrid).
   */
  setMode(mode: Mode): void {
    this.mode = mode;
  }

  /**
   * Sync: discover sessions, parse new/changed ones, handle moves, remove
   * sessions whose files no longer exist anywhere.
   *
   * In digest-hybrid mode (task 6.3): ALL discovered sessions are included in
   * metadata so session_list works pre-backfill. Sessions with no digest
   * are listable but not searchable (embedding + FTS content left empty).
   */
  async sync(
    onProgress?: (msg: string) => void
  ): Promise<{ added: number; updated: number; removed: number; moved: number }> {
    // Task 6.6: while backfill is in progress, skip periodic sync
    if (this.backfillInProgress) {
      return { added: 0, updated: 0, removed: 0, moved: 0 };
    }

    const discovered = discoverSessionFiles(
      this.extraSessionDirs,
      this.extraArchiveDirs,
    );

    let added = 0;
    let updated = 0;
    let removed = 0;
    let moved = 0;

    // ── Phase 1: Build a map of discovered files → session ID ────────
    // We need session IDs to correlate with the index. For files already
    // in the index we can match by scanning existing entries. For unknown
    // files we do a quick header-only read.
    const fileToId = new Map<string, string>();
    const idToFile = new Map<string, { file: string; archived: boolean; mtimeMs: number; sizeBytes: number }>();

    // Build a reverse lookup: sessionId → current indexed file path
    const indexedIdToFile = new Map<string, string>();
    for (const [id, entry] of Object.entries(this.data.sessions)) {
      indexedIdToFile.set(id, entry.session.file);
    }

    for (const { file, archived } of discovered) {
      let mtimeMs: number;
      let sizeBytes: number;
      try {
        const st = statSync(file);
        mtimeMs = st.mtimeMs;
        sizeBytes = st.size;
      } catch {
        continue; // can't stat — skip
      }

      // Try to match by checking if any indexed entry already has this file
      let sessionId: string | null = null;
      for (const [id, entry] of Object.entries(this.data.sessions)) {
        if (entry.session.file === file) {
          sessionId = id;
          break;
        }
      }

      // Not found in index by path — quick-read the header for the UUID
      if (!sessionId) {
        sessionId = readSessionId(file);
      }

      if (!sessionId) continue; // unparseable file

      fileToId.set(file, sessionId);

      // If multiple files claim the same session ID, prefer the newer one
      const existing = idToFile.get(sessionId);
      if (!existing || mtimeMs > existing.mtimeMs) {
        idToFile.set(sessionId, { file, archived, mtimeMs, sizeBytes });
      }
    }

    // ── Phase 2: Remove indexed sessions that no longer exist on disk ─
    const discoveredIds = new Set(idToFile.keys());
    for (const id of Object.keys(this.data.sessions)) {
      if (!discoveredIds.has(id)) {
        delete this.data.sessions[id];
        this.fts.delete(id);
        removed++;
      }
    }

    const toEmbed: { id: string; file: string; archived: boolean; mtimeMs: number; sizeBytes: number }[] = [];

    for (const [id, disc] of idToFile.entries()) {
      const existing = this.data.sessions[id];

      if (existing) {
        // Session already indexed
        const pathChanged = existing.session.file !== disc.file;
        const sizeChanged = (existing.sizeBytes ?? 0) !== disc.sizeBytes;

        if (pathChanged && !sizeChanged) {
          // ── Moved (e.g. sessions/ → sessions-archive/) ──
          // Update file path + archived flag, keep embedding
          existing.session.file = disc.file;
          existing.session.archived = disc.archived;
          existing.mtimeMs = disc.mtimeMs;
          existing.sizeBytes = disc.sizeBytes;
          moved++;
        } else if (sizeChanged) {
          // ── Content changed (file size differs) ──
          // Need full re-parse + re-embed
          toEmbed.push({ id, ...disc });
        }
        // else: unchanged (same size, same path) — skip
      } else {
        // ── Brand new session ──
        toEmbed.push({ id, ...disc });
      }
    }

    if (toEmbed.length === 0) {
      if (moved > 0 || removed > 0) this.save();
      return { added, updated, removed, moved };
    }

    onProgress?.(`Indexing ${toEmbed.length} sessions...`);

    // ── Phase 3: Parse + embed in batches ─────────────────────────────
    const BATCH_SIZE = 20;
    for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
      const batch = toEmbed.slice(i, i + BATCH_SIZE);
      const parsed: { item: (typeof toEmbed)[0]; session: ParsedSession; digest: SessionDigest | null }[] = [];

      for (const item of batch) {
        const session = parseSession(item.file, item.archived);
        if (session && session.userMessageCount > 0) {
          // Task 6.3: in digest-hybrid mode, load digest (may be null for un-digested)
          const digest = this.mode === "digest-hybrid" ? loadDigest(item.id) : null;
          parsed.push({ item, session, digest });
        } else if (session) {
          // Session parsed (valid header) but has no user messages —
          // synthetic/empty/fixture file. Record metadata-only so it's not
          // re-discovered as "new" on every sync (which would loop forever
          // and freeze the status line). Will only be re-attempted if the
          // file's sizeBytes changes.
          this.data.sessions[item.id] = {
            session: stripHeavyFields(session),
            digest: null,
            embedding: [],
            mtimeMs: item.mtimeMs,
            sizeBytes: item.sizeBytes,
          };
        }
        // else (parseSession returned null): file is unparseable; intentionally
        // not persisted so a future fix to parser can rediscover it. These are
        // rare and don't accumulate.
      }

      if (parsed.length === 0) {
        onProgress?.(
          `Indexed ${Math.min(i + BATCH_SIZE, toEmbed.length)}/${toEmbed.length}...`,
        );
        continue;
      }

      if (this.mode === "digest-hybrid") {
        // Task 6.3: digest-hybrid — include ALL sessions in metadata, but only
        // embed + index FTS for sessions that have a digest.
        for (const { item, session, digest } of parsed) {
          const isUpdate = !!this.data.sessions[item.id];

          if (digest) {
            // Has digest — embed and add to FTS
            try {
              const embedding = await this.embedder.embed(digest.body, this.abortController.signal);

              if (this.data.vectorDim === 0 && embedding.length > 0) {
                this.data.vectorDim = embedding.length;
              }

              this.data.sessions[item.id] = {
                session: stripHeavyFields(session),
                digest,
                embedding: encodeEmbedding(embedding),
                mtimeMs: item.mtimeMs,
                sizeBytes: item.sizeBytes,
              };
              this.fts.upsert(item.id, { digestBody: digest.body, rawContent: buildRawFtsContent(session), name: session.name ?? "" })
            } catch (err: any) {
              onProgress?.(`Embedding failed for ${item.id}: ${err.message}`);
              // Still record in metadata, just without embedding
              this.data.sessions[item.id] = {
                session: stripHeavyFields(session),
                digest,
                embedding: [],
                mtimeMs: item.mtimeMs,
                sizeBytes: item.sizeBytes,
              };
            }
          } else {
            // No digest yet — record in metadata AND index raw content for FTS
            // so keyword/BM25 search works over un-digested sessions. digest_body
            // stays empty; both it and the embedding fill in later once a digest
            // is generated. This decouples raw keyword search from the digest
            // pipeline (which may be slow, rate-limited, or provider-broken).
            this.data.sessions[item.id] = {
              session: stripHeavyFields(session),
              digest: null,
              embedding: [],
              mtimeMs: item.mtimeMs,
              sizeBytes: item.sizeBytes,
            };
            this.fts.upsert(item.id, { digestBody: "", rawContent: buildRawFtsContent(session), name: session.name ?? "" })
          }

          if (isUpdate) updated++;
          else added++;
        }
      } else {
        // fts-raw mode: legacy raw-content path (SessionIndex always digest-hybrid;
        // this branch is dead code kept for compilation)
        const texts = parsed.map(({ session }) => session.userMessages?.join("\n") ?? "");

        try {
          const embeddings = await this.embedder.embedBatch(texts, this.abortController.signal);

          for (let j = 0; j < parsed.length; j++) {
            const { item, session } = parsed[j];
            const embedding = embeddings[j];
            if (!embedding) continue; // failed to embed

            // Task 5.9: learn vectorDim from first successful embed if not yet known
            if (this.data.vectorDim === 0 && embedding.length > 0) {
              this.data.vectorDim = embedding.length;
            }

            const isUpdate = !!this.data.sessions[item.id];

            this.data.sessions[item.id] = {
              session: stripHeavyFields(session),
              digest: null,
              embedding: encodeEmbedding(embedding),
              mtimeMs: item.mtimeMs,
              sizeBytes: item.sizeBytes,
            };
            this.fts.upsert(item.id, { digestBody: "", rawContent: buildContent(session), name: session.name ?? "" })

            if (isUpdate) updated++;
            else added++;
          }
        } catch (err: any) {
          onProgress?.(`Embedding batch failed: ${err.message}`);
        }
      }

      onProgress?.(
        `Indexed ${Math.min(i + BATCH_SIZE, toEmbed.length)}/${toEmbed.length}...`
      );
    }

    this.save();
    return { added, updated, removed, moved };
  }

  /** Full rebuild — clear and re-index everything. */
  async rebuild(onProgress?: (msg: string) => void): Promise<void> {
    this.data = { version: INDEX_VERSION, vectorDim: 0, sessions: {} };
    this.fts.clear();
    await this.sync(onProgress);
  }

  /**
   * Add/update a session using its digest (task 6.4).
   * digest-hybrid only — FtsSessionIndex does not receive this.
   *
   * @param sessionId   UUID of the session
   * @param session     Full ParsedSession (heavy fields used for embed text)
   * @param digest      The SessionDigest to store and embed
   * @param opts        batched: true → in-memory only; false (default) → flush to disk
   */
  async addDigested(
    sessionId: string,
    session: ParsedSession,
    digest: SessionDigest,
    opts?: { batched?: boolean },
  ): Promise<void> {
    const embeddingText = digest.body;
    const embedding = await this.embedder.embed(embeddingText, this.abortController.signal);

    if (this.data.vectorDim === 0 && embedding.length > 0) {
      this.data.vectorDim = embedding.length;
    }

    const existing = this.data.sessions[sessionId];
    this.data.sessions[sessionId] = {
      session: stripHeavyFields(session),
      digest,
      embedding: encodeEmbedding(embedding),
      mtimeMs: existing?.mtimeMs ?? Date.now(),
      sizeBytes: existing?.sizeBytes,
    };

    this.fts.upsert(sessionId, { digestBody: digest.body, rawContent: buildRawFtsContent(session), name: session.name ?? "" })

    if (!opts?.batched) {
      this.save();
    }
  }

  /**
   * Get the stored digest for a session (task 6.7).
   * Returns null if not present or not in digest-hybrid mode.
   * FtsSessionIndex does not implement this — the mode router never reaches
   * FtsSessionIndex in digest-hybrid.
   */
  getDigest(sessionId: string): SessionDigest | null {
    return this.data.sessions[sessionId]?.digest ?? null;
  }

  /**
   * Hybrid search: cosine embeddings + FTS5 BM25, fused via Reciprocal Rank
   * Fusion (k=60). Falls back to pure semantic if FTS side-car is empty.
   *
   * Task 6.11: in digest-hybrid, filter out entries with empty embedding BEFORE
   * cosine scoring. Also filters FTS rows with empty content.
   */
  async search(
    query: string,
    limit: number = 10,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    const allEntries = Object.entries(this.data.sessions);
    if (allEntries.length === 0) return [];

    // Task 6.11: in digest-hybrid, cosine scoring runs ONLY over entries that
    // have an embedding (i.e. digested sessions). The FTS/BM25 side below still
    // covers every session (digested or not), so keyword search keeps working
    // even when nothing has been digested yet.
    let embeddedEntries = allEntries;
    if (this.mode === "digest-hybrid") {
      embeddedEntries = allEntries.filter(([, entry]) => {
        const emb = entry.embedding;
        if (Array.isArray(emb)) return emb.length > 0;
        return typeof emb === "string" && emb.length > 0;
      });
    }

    // Pull a larger candidate pool from each side so fusion has room to rank
    const poolSize = Math.max(limit * 5, 100);
    const cosineRanks = new Map<string, number>();

    // Only embed the query + run cosine when there is at least one embedded
    // session; otherwise skip the (potentially failing / rate-limited) embedder
    // call entirely and fall back to pure BM25 keyword search.
    if (embeddedEntries.length > 0) {
      const queryEmbedding = await this.embedder.embed(query, this.abortController.signal);
      if (signal?.aborted) return [];

      const cosineScored = embeddedEntries
        .map(([id, entry]) => ({
          id,
          entry,
          score: cosineSimilarity(queryEmbedding, decodeEmbedding(entry.embedding)),
        }))
        .sort((a, b) => b.score - a.score);

      cosineScored.slice(0, poolSize).forEach((s, i) => {
        cosineRanks.set(s.id, i + 1);
      });
    }

    const ftsRanks = this.fts.searchRanks(query, poolSize);

    // Neither semantic nor keyword side produced a candidate — nothing matches.
    if (cosineRanks.size === 0 && ftsRanks.size === 0) return [];

    // RRF fusion: score = Σ 1 / (k + rank)
    const K = 60;
    const fused = new Map<string, number>();
    for (const [id, r] of cosineRanks) fused.set(id, (fused.get(id) ?? 0) + 1 / (K + r));
    for (const [id, r] of ftsRanks) fused.set(id, (fused.get(id) ?? 0) + 1 / (K + r));

    const sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

    return sorted
      .map(([id, score]) => {
        const entry = this.data.sessions[id];
        if (!entry) return null;
        return {
          session: entry.session,
          summary: buildSummary(entry.session, entry.digest),
          score,
        };
      })
      .filter((r): r is SearchResult => r !== null);
  }

  /**
   * List sessions with optional filters.
   */
  list(filters?: ListFilters): ParsedSession[] {
    let sessions = Object.values(this.data.sessions).map((e) => e.session);

    if (filters?.project) {
      const slug = filters.project.toLowerCase();
      sessions = sessions.filter(
        (s) =>
          s.projectSlug.toLowerCase().includes(slug) ||
          s.cwd.toLowerCase().includes(slug)
      );
    }

    if (filters?.after) {
      sessions = sessions.filter((s) => s.startedAt >= filters.after!);
    }

    if (filters?.before) {
      sessions = sessions.filter((s) => s.startedAt <= filters.before!);
    }

    if (filters?.archived !== undefined) {
      sessions = sessions.filter((s) => s.archived === filters.archived);
    }

    // Sort by start time, newest first
    sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    if (filters?.limit) {
      sessions = sessions.slice(0, filters.limit);
    }

    return sessions;
  }

  /**
   * Get a specific session by file path or session ID.
   */
  get(fileOrId: string): IndexedSession | undefined {
    // Try direct session ID lookup
    if (this.data.sessions[fileOrId]) {
      return this.data.sessions[fileOrId];
    }
    // Try by file path
    return Object.values(this.data.sessions).find(
      (e) => e.session.file === fileOrId
    );
  }

  /** Get all indexed session objects. */
  getAll(): IndexedSession[] {
    return Object.values(this.data.sessions);
  }

  close(): void {
    this.fts.close();
  }
}

// ─── Search types ────────────────────────────────────────────────────

export interface SearchResult {
  session: ParsedSession;
  summary: string;
  score: number;
}

export interface ListFilters {
  project?: string;
  after?: string;
  before?: string;
  archived?: boolean;
  limit?: number;
}

// ─── Utilities ───────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  // (per task 5.10 + 6.11 invariant) reject empty vectors
  if (a.length === 0 || b.length === 0) {
    throw new Error(
      `cosineSimilarity: vectors must be non-empty (got lengths ${a.length}, ${b.length})`,
    );
  }
  // (per task 5.10) equal-length assertion
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: vector length mismatch (${a.length} vs ${b.length}); ` +
      `ensure all embeddings use the same model and dimensions setting`,
    );
  }
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

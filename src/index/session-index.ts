import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ParsedSession } from "../parser";
import { discoverSessionFiles, parseSession, readSessionId } from "../parser";
import type { Embedder } from "../embedder";
import type { EmbedderConfig } from "../embedder";
import { buildContent, toFtsQuery } from "./fts-index";
import { truncate, slugToProject, buildSummary } from "../utils";
import type { Mode } from "./mode";
import type { SessionDigest } from "../digest/schema";
import { loadDigest } from "../digest/storage";

// ─── FTS side-car (for hybrid search) ────────────────────────────────

class FtsSide {
  private db: DatabaseSync;
  constructor(indexDir: string) {
    this.db = new DatabaseSync(join(indexDir, "hybrid-fts.db"));
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS s USING fts5(id UNINDEXED, name, content, tokenize='porter unicode61')",
    );
  }
  upsert(id: string, name: string, content: string) {
    this.db.exec("BEGIN");
    this.db.prepare("DELETE FROM s WHERE id = ?").run(id);
    this.db.prepare("INSERT INTO s (id, name, content) VALUES (?, ?, ?)").run(id, name, content);
    this.db.exec("COMMIT");
  }
  delete(id: string) { this.db.prepare("DELETE FROM s WHERE id = ?").run(id); }
  clear() { this.db.exec("DELETE FROM s"); }
  /** Drop and recreate the FTS5 table — used on index version hard-reset. */
  hardReset() {
    this.db.exec("DROP TABLE IF EXISTS s");
    this.db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS s USING fts5(id UNINDEXED, name, content, tokenize='porter unicode61')",
    );
  }
  close() { this.db.close(); }
  count(): number {
    return (this.db.prepare("SELECT count(*) as c FROM s").get() as any).c;
  }
  /** Returns id→rank map (rank starts at 1, best first). */
  searchRanks(q: string, limit: number): Map<string, number> {
    const fts = toFtsQuery(q);
    const out = new Map<string, number>();
    if (!fts) return out;
    const rows = this.db
      .prepare("SELECT id FROM s WHERE s MATCH ? ORDER BY bm25(s) LIMIT ?")
      .all(fts, limit) as any[];
    rows.forEach((r, i) => out.set(String(r.id), i + 1));
    return out;
  }
}

// ─── Types ───────────────────────────────────────────────────────────

interface IndexedSession {
  /** Parsed session metadata (heavy text fields stripped after embedding) */
  session: ParsedSession;
  /**
   * Per-session digest (task 6.8). Null when the session has no digest yet
   * (un-digested in digest-mode; always null in hybrid-raw mode).
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
   * Mode in effect when this index was last persisted. Tracked so that a mode
   * change between pi sessions (e.g. user adds digest.json so hybrid-raw →
   * digest-mode) triggers an automatic embedding clear on the next load —
   * preventing stale raw-content vectors from being cosine-scored against
   * fresh digest-content vectors. Absent on pre-fix v4 files; treated as the
   * current mode (no clear).
   */
  lastMode?: Mode;
  /** Keyed by session UUID — stable across file moves */
  sessions: Record<string, IndexedSession>;
}

export const INDEX_VERSION = 4;

/**
 * Unconditional v3→v4 (or any-other→v4) migration check.
 *
 * Runs BEFORE the mode-specific index is instantiated, so the migration fires
 * regardless of whether the active mode is fts-raw, hybrid-raw, or digest-mode.
 * Without this, fts-raw mode (which uses FtsSessionIndex and never reads
 * session-index.json) would leave a stale v3 file on disk indefinitely.
 *
 * Idempotent: if the file is absent or already v4, this is a no-op.
 */
export function migrateIndexFileIfStale(
  indexDir: string,
  onNotify?: (msg: string, level: "info" | "warning" | "error") => void,
): boolean {
  const indexPath = join(indexDir, "session-index.json");
  if (!existsSync(indexPath)) return false;

  let parsed: { version?: number };
  try {
    parsed = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch {
    return false; // unreadable file — leave alone, SessionIndex.load() will handle
  }

  if (parsed.version === INDEX_VERSION) return false;

  const oldVersion = parsed.version ?? "unknown";
  // Hard-reset session-index.json to v4 empty
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(
    indexPath,
    JSON.stringify({ version: INDEX_VERSION, vectorDim: 0, sessions: {} }, null, 2),
  );

  // Wipe both FTS DBs so v3 raw-content rows don't coexist with v4 digest rows
  for (const dbName of ["sessions-fts.db", "hybrid-fts.db"]) {
    const dbPath = join(indexDir, dbName);
    if (!existsSync(dbPath)) continue;
    try {
      const db = new DatabaseSync(dbPath);
      db.exec("DROP TABLE IF EXISTS sessions");
      db.exec("DROP TABLE IF EXISTS s");
      db.close();
    } catch {
      // best-effort
    }
  }

  onNotify?.(
    `session-search: index version ${oldVersion} is incompatible; reset to v4. Run /digest:backfill to repopulate.`,
    "info",
  );
  return true;
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
    this.mode = mode ?? "hybrid-raw";
    mkdirSync(indexDir, { recursive: true });
    this.indexPath = join(indexDir, "session-index.json");
    this.fts = new FtsSide(indexDir);
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
        // with populated embeddings, clear them so digest-mode's invariant holds:
        // entries with empty embedding == un-digested. Without this, a hybrid-raw
        // index loaded into digest-mode would happily cosine-score raw-content
        // vectors against (eventually) digest-content vectors — incomparable spaces.
        const previousMode = this.data.lastMode;
        if (
          previousMode !== undefined &&
          previousMode !== this.mode &&
          this.mode === "digest-mode"
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
              `session-search: mode changed (${previousMode} → ${this.mode}); ${cleared} embeddings cleared. Run /digest:backfill to re-populate.`,
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
        try {
          const sessDb = new DatabaseSync(join(this.indexDir, "sessions-fts.db"));
          sessDb.exec("DROP TABLE IF EXISTS sessions");
          sessDb.close();
        } catch {
          // sessions-fts.db may not exist yet — ignore
        }

        onNotify?.(
          `session-search: index version ${oldVersion} is incompatible; reset to v4. Run /digest:backfill to repopulate.`,
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
      // In digest-mode, prefer digest.body for FTS content (task 6.2 / 6.3).
      // In hybrid-raw, reconstruct from stripped metadata fields.
      let content: string;
      if (this.mode === "digest-mode" && entry.digest) {
        content = entry.digest.body;
      } else {
        const parts: string[] = [];
        if (s.name) parts.push(s.name);
        if (s.firstUserMessage) parts.push(s.firstUserMessage);
        if (s.compactionSummaries?.length) parts.push(s.compactionSummaries.join("\n"));
        if (s.branchSummaries?.length) parts.push(s.branchSummaries.join("\n"));
        if (s.filesModified?.length) parts.push(s.filesModified.join(" "));
        content = parts.join("\n\n");
      }
      // Only add to FTS if we have content (skip un-digested in digest-mode)
      if (content) {
        this.fts.upsert(id, s.name ?? "", content);
      }
    }
  }

  /** Save index to disk. */
  save(): void {
    // Stamp current mode so a future load can detect mode transitions across pi sessions.
    this.data.lastMode = this.mode;
    writeFileSync(this.indexPath, JSON.stringify(this.data), "utf8");
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
   * Used when upgrading from hybrid-raw to digest-mode after mode re-evaluation.
   */
  setMode(mode: Mode): void {
    this.mode = mode;
  }

  /**
   * Mark all entries dirty for re-embed and clear their embeddings (task 4.5.1).
   *
   * Called when upgrading from hybrid-raw → digest-mode. Dirty mark: zeroing
   * sizeBytes makes sync() treat entries as changed — same mechanism as the
   * vectorDim mismatch path (task 5.9). Clearing the embedding field ensures
   * the search-filter invariant from task 6.11 holds during the transitional
   * window: entries with an empty embedding are treated as un-digested and
   * skipped by cosine scoring. Never silently mix raw-content and
   * digest-content embeddings in the same vector space.
   *
   * @returns number of entries marked
   */
  markAllDirtyAndClearEmbeddings(): number {
    let count = 0;
    for (const entry of Object.values(this.data.sessions)) {
      entry.sizeBytes = 0; // dirty mark — sync() will re-embed on next run
      entry.embedding = ""; // cleared — task 6.11 invariant (empty = un-digested)
      count++;
    }
    if (count > 0) this.save();
    return count;
  }

  /**
   * Sync: discover sessions, parse new/changed ones, handle moves, remove
   * sessions whose files no longer exist anywhere.
   *
   * In digest-mode (task 6.3): ALL discovered sessions are included in
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
          // Task 6.3: in digest-mode, load digest (may be null for un-digested)
          const digest = this.mode === "digest-mode" ? loadDigest(item.id) : null;
          parsed.push({ item, session, digest });
        }
      }

      if (parsed.length === 0) continue;

      if (this.mode === "digest-mode") {
        // Task 6.3: digest-mode — include ALL sessions in metadata, but only
        // embed + index FTS for sessions that have a digest.
        for (const { item, session, digest } of parsed) {
          const isUpdate = !!this.data.sessions[item.id];

          if (digest) {
            // Has digest — embed and add to FTS
            try {
              const embedding = await this.embedder.embed(buildEmbeddingText(session, this.mode, digest));

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
              this.fts.upsert(item.id, session.name ?? "", buildContent(session, this.mode, digest));
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
            // No digest yet — record in metadata only (listable, not searchable)
            this.data.sessions[item.id] = {
              session: stripHeavyFields(session),
              digest: null,
              embedding: [],
              mtimeMs: item.mtimeMs,
              sizeBytes: item.sizeBytes,
            };
            // Do NOT upsert into FTS — empty content row pollutes BM25
          }

          if (isUpdate) updated++;
          else added++;
        }
      } else {
        // hybrid-raw mode: batch embed the raw content
        const texts = parsed.map(({ session }) => buildEmbeddingText(session, this.mode, null));

        try {
          const embeddings = await this.embedder.embedBatch(texts);

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
            this.fts.upsert(item.id, session.name ?? "", buildContent(session, this.mode, null));

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
   * digest-mode and hybrid-raw only — FtsSessionIndex does not receive this.
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
    const embeddingText = buildEmbeddingText(session, this.mode, digest);
    const embedding = await this.embedder.embed(embeddingText);

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

    const ftsContent = buildContent(session, this.mode, digest);
    this.fts.upsert(sessionId, session.name ?? "", ftsContent);

    if (!opts?.batched) {
      this.save();
    }
  }

  /**
   * Get the stored digest for a session (task 6.7).
   * Returns null if not present or not in digest-mode.
   * FtsSessionIndex does not implement this — the mode router never reaches
   * FtsSessionIndex in digest-mode.
   */
  getDigest(sessionId: string): SessionDigest | null {
    return this.data.sessions[sessionId]?.digest ?? null;
  }

  /**
   * Hybrid search: cosine embeddings + FTS5 BM25, fused via Reciprocal Rank
   * Fusion (k=60). Falls back to pure semantic if FTS side-car is empty.
   *
   * Task 6.11: in digest-mode, filter out entries with empty embedding BEFORE
   * cosine scoring. Also filters FTS rows with empty content.
   */
  async search(
    query: string,
    limit: number = 10,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    let entries = Object.entries(this.data.sessions);
    if (entries.length === 0) return [];

    // Task 6.11: in digest-mode, exclude un-digested entries from cosine scoring
    if (this.mode === "digest-mode") {
      entries = entries.filter(([, entry]) => {
        const emb = entry.embedding;
        if (Array.isArray(emb)) return emb.length > 0;
        return typeof emb === "string" && emb.length > 0;
      });
    }

    if (entries.length === 0) return [];

    const queryEmbedding = await this.embedder.embed(query);
    if (signal?.aborted) return [];

    // Rank by cosine similarity
    const cosineScored = entries
      .map(([id, entry]) => ({
        id,
        entry,
        score: cosineSimilarity(queryEmbedding, decodeEmbedding(entry.embedding)),
      }))
      .sort((a, b) => b.score - a.score);

    // Pull a larger candidate pool from each side so fusion has room to rank
    const poolSize = Math.max(limit * 5, 100);
    const cosineRanks = new Map<string, number>();
    cosineScored.slice(0, poolSize).forEach((s, i) => {
      cosineRanks.set(s.id, i + 1);
    });

    const ftsRanks = this.fts.searchRanks(query, poolSize);

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

/**
 * Build text for embedding — mode-aware (task 6.1).
 *
 * digest-mode + digest present → return digest.body (semantic precision).
 * hybrid-raw (or digest-mode with no digest) → byte-identical to upstream.
 *
 * Regression-pin: mode === "hybrid-raw" MUST produce the same output as
 * the old single-arg buildEmbeddingText(session) for the same ParsedSession.
 */
export function buildEmbeddingText(s: ParsedSession, mode: Mode, digest?: SessionDigest | null): string {
  if (mode === "digest-mode" && digest) return digest.body;

  // hybrid-raw (or digest-mode without a digest): upstream raw-content concat
  const parts: string[] = [];

  if (s.name) parts.push(s.name);

  // User messages are the strongest signal
  const userText = s.userMessages.join("\n").slice(0, 6000);
  parts.push(userText);

  // Assistant text captures analysis, conclusions, and discoveries
  if (s.assistantText) {
    const assistantBudget = 3000;
    const truncatedAssistant = s.assistantText.slice(0, assistantBudget);
    parts.push(`Assistant:\n${truncatedAssistant}`);
  }

  // Compaction summaries are great condensed representations
  if (s.compactionSummaries.length > 0) {
    parts.push(s.compactionSummaries.join("\n").slice(0, 4000));
  }

  // Branch summaries
  if (s.branchSummaries.length > 0) {
    parts.push(s.branchSummaries.join("\n").slice(0, 2000));
  }

  // Project context
  parts.push(`Project: ${slugToProject(s.projectSlug)}`);
  parts.push(`CWD: ${s.cwd}`);

  // Files modified give strong project context
  if (s.filesModified.length > 0) {
    parts.push(`Files modified: ${s.filesModified.join(", ")}`);
  }

  // Limit total embedding text
  return parts.join("\n\n").slice(0, 16000);
}

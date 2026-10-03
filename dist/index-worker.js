// src/index-worker.ts
import { parentPort, workerData } from "node:worker_threads";

// src/utils.ts
import { homedir } from "node:os";
function createYielder(budgetMs = 8) {
  let last = performance.now();
  return {
    due: () => performance.now() - last >= budgetMs,
    async yield() {
      await new Promise((r) => setImmediate(r));
      last = performance.now();
    }
  };
}
function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max) + "\u2026";
}
function slugToProject(slug) {
  if (!slug.startsWith("--") || !slug.endsWith("--")) return slug;
  return slug.slice(2, -2).replace(/-/g, "/");
}
function sessionSearchHome() {
  const override = process.env.PI_SESSION_SEARCH_HOME;
  if (override && override.length > 0) return override;
  return `${homedir()}/.pi/session-search`;
}
function buildSummary(s, digest) {
  const lines = [];
  let name;
  if (digest != null) {
    name = digest.headline;
  } else if (digest === null) {
    name = truncate(s.firstUserMessage, 80) + " (no digest \u2014 run /session:update)";
  } else {
    name = s.name || truncate(s.firstUserMessage, 80);
  }
  const date = s.startedAt.split("T")[0];
  const project = slugToProject(s.projectSlug);
  lines.push(`**${name}** (${date})`);
  lines.push(`Project: ${project} | CWD: ${s.cwd}`);
  lines.push(
    `Messages: ${s.userMessageCount} user, ${s.assistantMessageCount} assistant`
  );
  if (s.models?.length) {
    lines.push(`Models: ${s.models.join(", ")}`);
  }
  if (s.toolCalls?.length) {
    const top = s.toolCalls.slice(0, 5).map((t) => `${t.name}(${t.count})`).join(", ");
    lines.push(`Tools: ${top}`);
  }
  if (s.filesModified?.length) {
    lines.push(`Modified: ${s.filesModified.slice(0, 10).join(", ")}`);
  }
  if (digest != null) {
    lines.push(`
${truncate(digest.body, 500)}`);
    if (digest.outcome) lines.push(`Outcome: ${digest.outcome}`);
    if (digest.topics?.length) lines.push(`Topics: ${digest.topics.join(", ")}`);
  } else if (s.compactionSummaries?.length) {
    lines.push(`
Compaction summaries:`);
    for (const cs of s.compactionSummaries) {
      lines.push(truncate(cs, 500));
    }
  }
  if (s.archived) {
    lines.push(`(archived)`);
  }
  return lines.join("\n");
}

// src/embedder.ts
function createEmbedder(config, notify) {
  const raw = config;
  if (raw.type !== void 0) {
    if (raw.type !== "openai-compatible") {
      notify?.(
        `session-search: legacy embedder type '${raw.type}' is no longer supported. Run /session:embedder to reconfigure with a /v1/embeddings-compatible endpoint (e.g., LiteLLM proxy).`,
        "error"
      );
      return null;
    }
  }
  const key = config.apiKey || (config.apiKeyEnv ? process.env[config.apiKeyEnv] : void 0) || process.env.OPENAI_API_KEY;
  if (!key) {
    notify?.(
      "session-search: embedder configured but no API key resolvable. Set apiKey, apiKeyEnv, or OPENAI_API_KEY in env. Falling back to fts-raw mode.",
      "warning"
    );
    return null;
  }
  return new OpenAICompatibleEmbedder(
    key,
    config.model,
    config.baseUrl,
    config.dimensions,
    config.headers,
    config.sendDimensions ?? false
  );
}
function truncate2(text, maxChars = 12e3) {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
var OpenAICompatibleEmbedder = class {
  constructor(apiKey, model, baseUrl, dimensions, extraHeaders, sendDimensions = false) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    this.extraHeaders = extraHeaders;
    this.sendDimensions = sendDimensions;
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/v1/embeddings`;
  }
  apiKey;
  model;
  dimensions;
  extraHeaders;
  sendDimensions;
  endpoint;
  async embed(text, signal) {
    const [result] = await this.embedBatch([text], signal);
    if (!result) throw new Error("Embedding failed");
    return result;
  }
  async embedBatch(texts, signal) {
    const BATCH = 100;
    const results = new Array(texts.length).fill(null);
    for (let i = 0; i < texts.length; i += BATCH) {
      if (signal?.aborted) throw new Error("Aborted");
      const batch = texts.slice(i, i + BATCH).map((t) => truncate2(t));
      const body = {
        input: batch,
        model: this.model
      };
      if (this.dimensions !== void 0 && this.sendDimensions) {
        body.dimensions = this.dimensions;
      }
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          // Task 1.7: merge custom headers (may override defaults except Authorization)
          ...this.extraHeaders
        },
        body: JSON.stringify(body),
        signal
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(
          `Embeddings API ${res.status}: ${errBody.slice(0, 200)}`
        );
      }
      const json = await res.json();
      for (let k = 0; k < json.data.length; k++) {
        const item = json.data[k];
        results[i + (item.index ?? k)] = item.embedding;
      }
    }
    return results;
  }
};

// src/index/fts-index.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { mkdirSync as mkdirSync2, statSync as statSync2 } from "node:fs";
import { join as join3 } from "node:path";

// src/parser.ts
import { readFileSync, readdirSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join, basename, dirname } from "node:path";
function getDefaultSessionDir() {
  return process.env.PI_SESSION_DIR || join(homedir2(), ".pi", "agent", "sessions");
}
function getDefaultArchiveDir() {
  return process.env.PI_SESSION_ARCHIVE_DIR || join(homedir2(), ".pi", "agent", "sessions-archive");
}
function discoverSessionFiles(extraSessionDirs = [], extraArchiveDirs = [], sessionDir, archiveDir) {
  const sDirs = [sessionDir ?? getDefaultSessionDir(), ...extraSessionDirs];
  const aDirs = [archiveDir ?? getDefaultArchiveDir(), ...extraArchiveDirs];
  const results = [];
  for (const dir of sDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of walkJsonl(dir)) {
      results.push({ file: entry, archived: false });
    }
  }
  for (const dir of aDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of walkJsonl(dir)) {
      results.push({ file: entry, archived: true });
    }
  }
  return results;
}
function walkJsonl(dir) {
  const files = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkJsonl(full));
      } else if (entry.name.endsWith(".jsonl") && entry.name !== "pins.json" && entry.name !== "active-sessions.json") {
        files.push(full);
      }
    }
  } catch {
  }
  return files;
}
function readSessionId(file) {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(1024);
      const bytesRead = readSync(fd, buf, 0, 1024, 0);
      const firstLine = buf.toString("utf8", 0, bytesRead).split("\n")[0];
      if (!firstLine) return null;
      const obj = JSON.parse(firstLine.replace(/^\uFEFF/, "").trim());
      return obj.type === "session" ? obj.id : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
var MAX_ASSISTANT_TEXT = 5e4;
function cleanLine(line) {
  return line.replace(/^\uFEFF/, "").trim();
}
function parseSession(file, archived) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = raw.trim().split("\n");
  if (lines.length === 0) return null;
  let header = null;
  const entries = [];
  for (const line of lines) {
    const cleaned = cleanLine(line);
    if (!cleaned) continue;
    try {
      const obj = JSON.parse(cleaned);
      if (obj.type === "session") {
        header = obj;
      } else {
        entries.push(obj);
      }
    } catch {
    }
  }
  if (!header) return null;
  const parentDir = basename(dirname(file));
  const projectSlug = parentDir.startsWith("--") ? parentDir : "unknown";
  const models = /* @__PURE__ */ new Set();
  const toolCallMap = /* @__PURE__ */ new Map();
  const filesRead = /* @__PURE__ */ new Set();
  const filesModified = /* @__PURE__ */ new Set();
  const userMessages = [];
  const compactionSummaries = [];
  const branchSummaries = [];
  let assistantText = "";
  let name;
  let lastTimestamp = header.timestamp;
  let totalCost = 0;
  let totalTokens = 0;
  let userMsgCount = 0;
  let assistantMsgCount = 0;
  for (const entry of entries) {
    if (entry.timestamp) lastTimestamp = entry.timestamp;
    switch (entry.type) {
      case "message": {
        const msg = entry.message;
        if (!msg) break;
        if (msg.role === "user") {
          userMsgCount++;
          const text = extractTextContent(msg.content);
          if (text) userMessages.push(text);
        }
        if (msg.role === "assistant") {
          assistantMsgCount++;
          if (msg.provider && msg.model) {
            models.add(`${msg.provider}/${msg.model}`);
          }
          if (msg.usage) {
            totalCost += msg.usage.cost?.total ?? 0;
            totalTokens += msg.usage.totalTokens ?? 0;
          }
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "text" && assistantText.length < MAX_ASSISTANT_TEXT) {
                assistantText += block.text + "\n";
              }
              if (block.type === "toolCall") {
                const name2 = block.name;
                toolCallMap.set(name2, (toolCallMap.get(name2) ?? 0) + 1);
              }
            }
          }
        }
        if (msg.role === "toolResult") {
          const tn = msg.toolName;
          if (tn === "read" || tn === "lsp_hover" || tn === "lsp_definition") {
            const path = extractPathFromToolResult(entry, msg);
            if (path) filesRead.add(path);
          }
          if (tn === "write" || tn === "edit") {
            const path = extractPathFromToolResult(entry, msg);
            if (path) filesModified.add(path);
          }
        }
        break;
      }
      case "model_change":
        if (entry.provider && entry.modelId) {
          models.add(`${entry.provider}/${entry.modelId}`);
        }
        break;
      case "compaction":
        if (entry.summary) compactionSummaries.push(entry.summary);
        break;
      case "branch_summary":
        if (entry.summary) branchSummaries.push(entry.summary);
        break;
      case "session_info":
        if (entry.name) name = entry.name;
        break;
    }
  }
  const toolCalls = Array.from(toolCallMap.entries()).map(([name2, count]) => ({ name: name2, count })).sort((a, b) => b.count - a.count);
  return {
    file,
    id: header.id,
    startedAt: header.timestamp,
    endedAt: lastTimestamp,
    cwd: header.cwd,
    name,
    archived,
    projectSlug,
    models: Array.from(models),
    userMessageCount: userMsgCount,
    assistantMessageCount: assistantMsgCount,
    toolCalls,
    filesRead: Array.from(filesRead).slice(0, 100),
    filesModified: Array.from(filesModified).slice(0, 100),
    firstUserMessage: userMessages[0] ?? "",
    userMessages,
    assistantText: assistantText.slice(0, MAX_ASSISTANT_TEXT),
    compactionSummaries,
    branchSummaries,
    totalCost,
    totalTokens
  };
}
function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  return "";
}
function extractPathFromToolResult(_entry, msg) {
  if (msg.details?.path) return msg.details.path;
  if (msg.details?.diff) {
    const match = msg.details.diff?.match?.(/^  \d+ (.*)/m);
    if (match) return match[1];
  }
  if (msg.toolName === "read" && msg.content?.[0]?.text) {
  }
  return null;
}

// src/log.ts
import { homedir as homedir3 } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";
import { mkdirSync } from "node:fs";
import { performance as performance2 } from "node:perf_hooks";
import pino from "pino";
import { createStream } from "rotating-file-stream";
var cachedLogger;
var cachedPath = null;
function buildLogger() {
  const DEBUG = process.env.PI_SESSION_SEARCH_DEBUG !== "0";
  const DEBUG_LOG_PATH = process.env.PI_SESSION_SEARCH_DEBUG_PATH || join2(homedir3(), ".pi", "agent", "session-search.log");
  const DEBUG_MAX_BYTES = Number(process.env.PI_SESSION_SEARCH_DEBUG_MAX_BYTES) || 10 * 1024 * 1024;
  const LEVEL = process.env.PI_SESSION_SEARCH_DEBUG_LEVEL || "debug";
  const SYNC_FILE = process.env.PI_SESSION_SEARCH_LOG_SYNC_FILE;
  let destinationStream;
  let resolvedPath = null;
  if (SYNC_FILE) {
    try {
      mkdirSync(dirname2(SYNC_FILE), { recursive: true });
      destinationStream = pino.destination({ dest: SYNC_FILE, sync: true });
      resolvedPath = SYNC_FILE;
    } catch {
      destinationStream = void 0;
    }
  } else if (DEBUG) {
    try {
      mkdirSync(dirname2(DEBUG_LOG_PATH), { recursive: true });
    } catch {
    }
    try {
      destinationStream = createStream(DEBUG_LOG_PATH, {
        size: `${DEBUG_MAX_BYTES}B`,
        maxFiles: 2
      });
      resolvedPath = DEBUG_LOG_PATH;
    } catch {
      destinationStream = void 0;
    }
  }
  const logger = destinationStream ? pino(
    {
      level: LEVEL,
      timestamp: pino.stdTimeFunctions.isoTime,
      base: { mod: "pi-session-search", pid: process.pid }
    },
    destinationStream
  ) : pino({ level: "silent" });
  return { logger, path: destinationStream ? resolvedPath : null };
}
function getLogger() {
  if (process.env.PI_SESSION_SEARCH_LOG_RESET === "1") {
    cachedLogger = void 0;
    delete process.env.PI_SESSION_SEARCH_LOG_RESET;
  }
  if (!cachedLogger) {
    const built = buildLogger();
    cachedLogger = built.logger;
    cachedPath = built.path;
  }
  return cachedLogger;
}
var log = {
  trace: (obj, msg) => typeof obj === "string" ? getLogger().trace(obj) : getLogger().trace(obj, msg),
  debug: (obj, msg) => typeof obj === "string" ? getLogger().debug(obj) : getLogger().debug(obj, msg),
  info: (obj, msg) => typeof obj === "string" ? getLogger().info(obj) : getLogger().info(obj, msg),
  warn: (obj, msg) => typeof obj === "string" ? getLogger().warn(obj) : getLogger().warn(obj, msg),
  error: (obj, msg) => typeof obj === "string" ? getLogger().error(obj) : getLogger().error(obj, msg),
  child: (bindings) => getLogger().child(bindings)
};
function dbCall(op, fields, fn) {
  const t0 = performance2.now();
  try {
    const out = fn();
    const durationMs = Math.round(performance2.now() - t0);
    if (durationMs >= 50) {
      log.debug({ op, durationMs, ...fields }, "db op");
    } else {
      log.trace({ op, durationMs, ...fields }, "db op");
    }
    return out;
  } catch (e) {
    const durationMs = Math.round(performance2.now() - t0);
    log.error(
      {
        op,
        durationMs,
        code: e?.code,
        errno: e?.errno,
        sqliteCode: e?.sqliteCode,
        ...fields,
        err: String(e?.message ?? e)
      },
      "db error"
    );
    throw e;
  }
}

// src/fts5-probe.ts
import { DatabaseSync } from "node:sqlite";
var cached = null;
function assertFts5Available() {
  if (cached === true) return;
  if (cached === false) throw new Error(fts5ErrorMessage());
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE _fts5_probe USING fts5(x)");
    cached = true;
  } catch {
    cached = false;
    throw new Error(fts5ErrorMessage());
  } finally {
    try {
      db.close();
    } catch {
    }
  }
}
function fts5ErrorMessage() {
  return `SQLite FTS5 is not available in this Node runtime. pi-session-search requires Node 22.19+ or 24+ (where node:sqlite ships with FTS5 compiled in). Current: Node ${process.versions.node}. Upgrade Node and restart pi.`;
}

// src/index/fts-index.ts
var BUSY_TIMEOUT_MS = 5e3;
var HEALED_USER_VERSION = 1;
var FtsSessionIndex = class {
  db;
  dbPath;
  indexDir;
  extraSessionDirs;
  extraArchiveDirs;
  sessionDir;
  archiveDir;
  constructor(indexDir, extraSessionDirs = [], extraArchiveDirs = [], sessionDir, archiveDir) {
    this.indexDir = indexDir;
    this.extraSessionDirs = extraSessionDirs;
    this.extraArchiveDirs = extraArchiveDirs;
    this.sessionDir = sessionDir;
    this.archiveDir = archiveDir;
    mkdirSync2(indexDir, { recursive: true });
    this.dbPath = join3(indexDir, "sessions-fts.db");
  }
  async load() {
    assertFts5Available();
    this.db = dbCall("open", { comp: "FtsSessionIndex", db: this.dbPath }, () => new DatabaseSync2(this.dbPath));
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    let hasSizeBytes = false;
    try {
      this.db.prepare("SELECT sizeBytes FROM sessions LIMIT 0").all();
      hasSizeBytes = true;
    } catch {
    }
    if (!hasSizeBytes) {
      this.db.exec("DROP TABLE IF EXISTS sessions");
    }
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions USING fts5(
        id UNINDEXED,
        file UNINDEXED,
        archived UNINDEXED,
        startedAt UNINDEXED,
        projectSlug UNINDEXED,
        cwd UNINDEXED,
        mtimeMs UNINDEXED,
        sizeBytes UNINDEXED,
        json UNINDEXED,
        summary UNINDEXED,
        name,
        content,
        tokenize='porter unicode61'
      );
    `);
    this.dropOldDuplicatesOnce();
  }
  /**
   * FTS5 has no unique constraint, and releases before 1.6.0 could index one
   * id twice when two pi processes synced at once. Scan for that once per DB;
   * sync() handles later races. Best-effort: while another connection holds
   * the write lock it is skipped, and the next open or adding sync heals.
   */
  dropOldDuplicatesOnce() {
    const { user_version } = this.db.prepare("PRAGMA user_version").get();
    if (user_version >= HEALED_USER_VERSION) return;
    try {
      this.db.exec("PRAGMA busy_timeout = 0");
      try {
        this.db.exec("BEGIN IMMEDIATE");
      } finally {
        this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      }
      dropDuplicateRows(this.db);
      this.db.exec(`PRAGMA user_version = ${HEALED_USER_VERSION}`);
      this.db.exec("COMMIT");
    } catch {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
    }
  }
  save() {
  }
  size() {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM sessions").get();
    return Number(row?.n ?? 0);
  }
  async sync(onProgress, _onError) {
    try {
      return await this.applyChanges(onProgress);
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }
  async applyChanges(onProgress) {
    const discovered = discoverSessionFiles(this.extraSessionDirs, this.extraArchiveDirs, this.sessionDir, this.archiveDir);
    let added = 0, updated = 0, removed = 0, moved = 0;
    const pause = createYielder();
    const idToFile = /* @__PURE__ */ new Map();
    for (const { file, archived } of discovered) {
      if (pause.due()) await pause.yield();
      let mtimeMs;
      let sizeBytes;
      try {
        const st = statSync2(file);
        mtimeMs = st.mtimeMs;
        sizeBytes = st.size;
      } catch {
        continue;
      }
      const id = readSessionId(file);
      if (!id) continue;
      const existing = idToFile.get(id);
      if (!existing || mtimeMs > existing.mtimeMs) {
        idToFile.set(id, { file, archived, mtimeMs, sizeBytes });
      }
    }
    const currentRows = this.db.prepare("SELECT id, file, mtimeMs, sizeBytes FROM sessions").all();
    const currentIds = new Set(currentRows.map((r) => String(r.id)));
    const currentById = /* @__PURE__ */ new Map();
    for (const r of currentRows) {
      currentById.set(String(r.id), {
        file: String(r.file),
        mtimeMs: Number(r.mtimeMs),
        sizeBytes: Number(r.sizeBytes ?? 0)
      });
    }
    const delStmt = this.db.prepare("DELETE FROM sessions WHERE id = ?");
    this.db.exec("BEGIN");
    for (const id of currentIds) {
      if (!idToFile.has(id)) {
        delStmt.run(id);
        removed++;
      }
    }
    this.db.exec("COMMIT");
    const toIngest = [];
    const movedUpdates = [];
    for (const [id, disc] of idToFile.entries()) {
      const cur = currentById.get(id);
      if (!cur) {
        toIngest.push({ id, ...disc });
      } else if (cur.sizeBytes !== disc.sizeBytes) {
        toIngest.push({ id, ...disc });
      } else if (cur.file !== disc.file) {
        movedUpdates.push({ id, ...disc });
      }
    }
    const moveStmt = this.db.prepare(
      "UPDATE sessions SET file = ?, archived = ?, mtimeMs = ?, sizeBytes = ? WHERE id = ?"
    );
    for (const m of movedUpdates) {
      moveStmt.run(m.file, m.archived ? 1 : 0, m.mtimeMs, m.sizeBytes, m.id);
      moved++;
    }
    if (toIngest.length > 0) onProgress?.(`Indexing ${toIngest.length} sessions...`);
    const insertStmt = this.db.prepare(`
      INSERT INTO sessions (id, file, archived, startedAt, projectSlug, cwd, mtimeMs, sizeBytes, json, summary, name, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const replaceDel = this.db.prepare("DELETE FROM sessions WHERE id = ?");
    this.db.exec("BEGIN");
    let done = 0;
    for (const item of toIngest) {
      if (pause.due()) {
        this.db.exec("COMMIT");
        await pause.yield();
        this.db.exec("BEGIN");
      }
      const session = parseSession(item.file, item.archived);
      if (!session || session.userMessageCount === 0) {
        done++;
        continue;
      }
      const content = buildContent(session);
      const summary = buildSummary(session);
      const isUpdate = currentIds.has(item.id);
      if (isUpdate) replaceDel.run(item.id);
      insertStmt.run(
        session.id,
        session.file,
        session.archived ? 1 : 0,
        session.startedAt,
        session.projectSlug,
        session.cwd,
        item.mtimeMs,
        item.sizeBytes,
        JSON.stringify(session),
        summary,
        session.name ?? "",
        content
      );
      if (isUpdate) updated++;
      else added++;
      done++;
      if (done % 25 === 0) onProgress?.(`Indexed ${done}/${toIngest.length}...`);
    }
    if (added > 0) dropDuplicateRows(this.db);
    this.db.exec("COMMIT");
    log.info({ comp: "FtsSessionIndex", db: this.dbPath, added, updated, removed, moved }, "sync complete");
    return { added, updated, removed, moved };
  }
  async rebuild(onProgress, onError) {
    this.db.exec("DELETE FROM sessions");
    await this.sync(onProgress, onError);
  }
  async search(query, limit = 10, _signal, project) {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const clauses = ["sessions MATCH ?"];
    const args = [fts];
    if (project) {
      clauses.push("(lower(projectSlug) LIKE ? OR lower(cwd) LIKE ?)");
      const p = `%${project.toLowerCase()}%`;
      args.push(p, p);
    }
    const sql = `SELECT json, summary, bm25(sessions) AS score FROM sessions WHERE ${clauses.join(" AND ")} ORDER BY score LIMIT ?`;
    const rows = dbCall("query", { comp: "FtsSessionIndex", db: this.dbPath, limit }, () => this.db.prepare(sql).all(...args, limit));
    return rows.map((r) => {
      const session = JSON.parse(String(r.json));
      const raw = Number(r.score);
      const score = 1 / (1 + Math.abs(raw));
      return { session, summary: String(r.summary ?? ""), score };
    });
  }
  list(filters) {
    const clauses = [];
    const args = [];
    if (filters?.project) {
      clauses.push("(lower(projectSlug) LIKE ? OR lower(cwd) LIKE ?)");
      const p = `%${filters.project.toLowerCase()}%`;
      args.push(p, p);
    }
    if (filters?.after) {
      clauses.push("startedAt >= ?");
      args.push(filters.after);
    }
    if (filters?.before) {
      clauses.push("startedAt <= ?");
      args.push(filters.before);
    }
    if (filters?.archived !== void 0) {
      clauses.push("archived = ?");
      args.push(filters.archived ? 1 : 0);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filters?.limit ?? 1e3;
    const sql = `SELECT json FROM sessions ${where} ORDER BY startedAt DESC LIMIT ?`;
    const rows = dbCall("query", { comp: "FtsSessionIndex", db: this.dbPath, limit }, () => this.db.prepare(sql).all(...args, limit));
    return rows.map((r) => JSON.parse(String(r.json)));
  }
  get(fileOrId) {
    const row = this.db.prepare("SELECT json, summary FROM sessions WHERE id = ? OR file = ? LIMIT 1").get(fileOrId, fileOrId);
    if (!row) return void 0;
    return {
      session: JSON.parse(String(row.json)),
      summary: String(row.summary ?? "")
    };
  }
  getAll() {
    const rows = this.db.prepare("SELECT json, summary FROM sessions").all();
    return rows.map((r) => ({
      session: JSON.parse(String(r.json)),
      summary: String(r.summary ?? "")
    }));
  }
  close() {
    dbCall("close", { comp: "FtsSessionIndex", db: this.dbPath }, () => this.db.close());
  }
};
function dropDuplicateRows(db) {
  db.exec(`
    DELETE FROM sessions WHERE rowid IN (
      SELECT rowid FROM (
        SELECT rowid, row_number() OVER (
          PARTITION BY id ORDER BY CAST(mtimeMs AS REAL) DESC, rowid DESC
        ) AS rank FROM sessions
      ) WHERE rank > 1
    )
  `);
}
function buildContent(s) {
  const parts = [];
  if (s.name) parts.push(s.name);
  parts.push(s.userMessages.join("\n"));
  if (s.compactionSummaries?.length) parts.push(s.compactionSummaries.join("\n"));
  if (s.branchSummaries?.length) parts.push(s.branchSummaries.join("\n"));
  if (s.filesModified?.length) parts.push(s.filesModified.join(" "));
  return parts.join("\n\n");
}
function toFtsQuery(q) {
  const terms = q.replace(/[\"^*():{}\[\]]/g, " ").split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0).map((t) => `"${t}"`);
  return terms.join(" OR ");
}

// src/index/session-index.ts
import { readFileSync as readFileSync3, writeFileSync as writeFileSync2, renameSync as renameSync2, existsSync as existsSync3, mkdirSync as mkdirSync4, statSync as statSync3 } from "node:fs";
import { join as join5 } from "node:path";
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";

// src/index/raw-fts-content.ts
function buildRawFtsContent(session) {
  const headline = session.name ?? session.firstUserMessage;
  const userBlock = safeUtf8Truncate(session.userMessages.join("\n"), 6 * 1024);
  const compactionBlock = safeUtf8Truncate(
    session.compactionSummaries.join("\n"),
    4 * 1024
  );
  const branchBlock = safeUtf8Truncate(
    session.branchSummaries.join("\n"),
    2 * 1024
  );
  const filesNormalized = normalizeFilesModified(session.filesModified);
  const parts = [headline, userBlock, compactionBlock, branchBlock, filesNormalized];
  const joined = parts.filter(Boolean).join("\n");
  return safeUtf8Truncate(joined, 12 * 1024);
}
function normalizeFilesModified(files) {
  const cleaned = [];
  for (const f of files) {
    if (/^[A-Za-z0-9+/=]{200,}$/.test(f)) continue;
    const normalized = f.replace(/\//g, " / ");
    cleaned.push(normalized);
  }
  return cleaned.join(" ").replace(/\s+/g, " ").trim();
}
function safeUtf8Truncate(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = lo + hi + 1 >>> 1;
    const slice = text.slice(0, mid);
    if (Buffer.byteLength(slice, "utf8") <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  if (lo > 0) {
    const lastCode = text.charCodeAt(lo - 1);
    if (lastCode >= 55296 && lastCode <= 56319) {
      lo -= 1;
    }
  }
  return text.slice(0, lo);
}

// src/digest/storage.ts
import {
  readFileSync as readFileSync2,
  writeFileSync,
  renameSync,
  readdirSync as readdirSync2,
  existsSync as existsSync2,
  mkdirSync as mkdirSync3
} from "node:fs";
import { join as join4, basename as basename2 } from "node:path";

// src/digest/schema.ts
import { Type } from "typebox";
import { Value } from "typebox/value";
var SessionDigestSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  body: Type.String({ minLength: 1 }),
  headline: Type.String({ minLength: 1, maxLength: 80 }),
  topics: Type.Array(Type.String({ maxLength: 32 }), { minItems: 0, maxItems: 5 }),
  outcome: Type.Optional(Type.String({ maxLength: 200 })),
  generatedAt: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 3 }),
  inputTokenCount: Type.Number({ minimum: 0 }),
  cost: Type.Number({ minimum: 0 })
});
function validateDigest(obj) {
  if (Value.Check(SessionDigestSchema, obj)) {
    return obj;
  }
  return null;
}
var DigestArgs = Type.Object({
  body: Type.String({ minLength: 50 }),
  headline: Type.String({ minLength: 1, maxLength: 80 }),
  topics: Type.Array(Type.String({ maxLength: 32 }), { minItems: 0, maxItems: 5 }),
  outcome: Type.Optional(Type.String({ maxLength: 200 }))
});

// src/digest/storage.ts
function getDigestDir() {
  return join4(sessionSearchHome(), "digests");
}
function digestPath(sessionId) {
  return join4(getDigestDir(), `${sessionId}.json`);
}
function loadDigest(sessionId) {
  const p = digestPath(sessionId);
  if (!existsSync2(p)) return null;
  try {
    const obj = JSON.parse(readFileSync2(p, "utf-8"));
    return validateDigest(obj);
  } catch {
    return null;
  }
}

// src/index/session-index.ts
var W_DIGEST = 2;
var W_RAW = 1;
var FTS_COLUMNS = "digest_body, raw_content, metadata UNINDEXED, id UNINDEXED, name";
var FTS_DDL = `CREATE VIRTUAL TABLE s USING fts5(${FTS_COLUMNS}, tokenize='porter unicode61')`;
var FtsSide = class {
  db;
  dbPath;
  constructor(indexDir) {
    this.dbPath = join5(indexDir, "hybrid-fts.db");
    this.db = dbCall("open", { db: this.dbPath, comp: "FtsSide" }, () => new DatabaseSync3(this.dbPath));
    dbCall(
      "pragma busy_timeout",
      { db: this.dbPath, comp: "FtsSide" },
      () => this.db.exec("PRAGMA busy_timeout = 5000;")
    );
    this.ensureFtsSchema();
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
  ensureFtsSchema() {
    const expectedColumns = ["digest_body", "raw_content", "metadata", "id", "name"];
    let schemaValid = false;
    let tokenizerValid = false;
    try {
      const columns = this.db.prepare("SELECT name FROM pragma_table_xinfo('s') WHERE name IS NOT NULL").all();
      const colNames = columns.map((c) => c.name);
      schemaValid = expectedColumns.every((name) => colNames.includes(name)) && colNames.indexOf("digest_body") === 0 && colNames.indexOf("raw_content") === 1 && colNames.indexOf("metadata") === 2 && colNames.indexOf("id") === 3 && colNames.indexOf("name") === 4;
      if (schemaValid) {
        const testTokens = ["gpt-5.4-nano", "ENOENT", "0x80000003"];
        const testContent = testTokens.join(" ");
        const testId = "__schema_validate_tokenizer__";
        this.db.prepare("DELETE FROM s WHERE id = ?").run(testId);
        this.db.prepare("INSERT INTO s (id, name, digest_body, raw_content) VALUES (?, '', ?, '')").run(testId, testContent);
        let probeOk = true;
        for (const token of testTokens) {
          const row = this.db.prepare(`SELECT count(*) AS c FROM s WHERE s MATCH '"${token}"'`).get();
          if (!row || row.c === 0) {
            probeOk = false;
            break;
          }
        }
        this.db.prepare("DELETE FROM s WHERE id = ?").run(testId);
        tokenizerValid = probeOk;
      }
    } catch {
    }
    if (schemaValid && tokenizerValid) return;
    dbCall("ensure-schema", { db: this.dbPath, comp: "FtsSide" }, () => {
      this.db.exec("BEGIN");
      try {
        this.db.exec("DROP TABLE IF EXISTS s");
        this.db.exec(FTS_DDL);
        this.db.exec("COMMIT");
      } catch (e) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
        }
        throw e;
      }
    });
  }
  upsert(id, content) {
    dbCall(
      "upsert",
      { db: this.dbPath, comp: "FtsSide", id, digestBytes: content.digestBody.length, rawBytes: content.rawContent.length },
      () => {
        this.db.exec("BEGIN");
        try {
          this.db.prepare("DELETE FROM s WHERE id = ?").run(id);
          this.db.prepare("INSERT INTO s (id, name, digest_body, raw_content) VALUES (?, ?, ?, ?)").run(
            id,
            content.name,
            content.digestBody,
            content.rawContent
          );
          this.db.exec("COMMIT");
        } catch (e) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
          }
          throw e;
        }
      }
    );
  }
  delete(id) {
    dbCall(
      "delete",
      { db: this.dbPath, comp: "FtsSide", id },
      () => this.db.prepare("DELETE FROM s WHERE id = ?").run(id)
    );
  }
  clear() {
    dbCall("clear", { db: this.dbPath, comp: "FtsSide" }, () => this.db.exec("DELETE FROM s"));
  }
  /** Drop and recreate the FTS5 table — used on index version hard-reset. */
  hardReset() {
    dbCall("hard-reset", { db: this.dbPath, comp: "FtsSide" }, () => {
      this.db.exec("DROP TABLE IF EXISTS s");
      this.db.exec(FTS_DDL);
    });
  }
  close() {
    dbCall("close", { db: this.dbPath, comp: "FtsSide" }, () => this.db.close());
  }
  count() {
    return dbCall(
      "count",
      { db: this.dbPath, comp: "FtsSide" },
      () => this.db.prepare("SELECT count(*) as c FROM s").get().c
    );
  }
  /** Returns id→rank map (rank starts at 1, best first). */
  searchRanks(q, limit, allowedIds) {
    const fts = toFtsQuery(q);
    const out = /* @__PURE__ */ new Map();
    if (!fts) return out;
    return dbCall("search", { db: this.dbPath, comp: "FtsSide", limit }, () => {
      const rows = this.db.prepare("SELECT id FROM s WHERE s MATCH ? ORDER BY bm25(s, ?, ?) LIMIT ?").all(fts, W_DIGEST, W_RAW, allowedIds ? -1 : limit);
      for (const row of rows) {
        const id = String(row.id);
        if (allowedIds && !allowedIds.has(id)) continue;
        out.set(id, out.size + 1);
        if (out.size >= limit) break;
      }
      return out;
    });
  }
};
var INDEX_VERSION = 5;
function migrateIndexFileIfStale(indexDir) {
  const indexPath = join5(indexDir, "session-index.json");
  if (!existsSync3(indexPath)) return { kind: "noop", didMigrate: false };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync3(indexPath, "utf8"));
  } catch {
    return { kind: "noop", didMigrate: false };
  }
  const version = parsed.version;
  const lastMode = parsed.lastMode;
  if (version === INDEX_VERSION) return { kind: "noop", didMigrate: false };
  let notifyMessage;
  if (version === 4 && lastMode === "hybrid-raw") {
    notifyMessage = "hybrid-raw mode removed; rebuilding";
  } else if (version === 4 && lastMode === "digest-mode") {
    notifyMessage = "format upgrade v4\u2192v5; rebuilding";
  } else if (version === 4 && lastMode === "fts-raw") {
    notifyMessage = "format upgrade v4\u2192v5";
  } else if (version === 4 && lastMode === void 0) {
    notifyMessage = "stale index; rebuilding";
  } else if (version !== void 0 && version < 4) {
    notifyMessage = "very stale index";
  } else if (version !== void 0 && version > 5) {
    notifyMessage = "downgrade from newer version";
  } else {
    notifyMessage = "index version mismatch; rebuilding";
  }
  const oldVersion = String(version ?? "unknown");
  const ftsPath = join5(indexDir, "hybrid-fts.db");
  try {
    dbCall("migrate-rebuild", { db: ftsPath, comp: "migrateIndexFileIfStale" }, () => {
      const db = new DatabaseSync3(ftsPath);
      db.exec("BEGIN");
      try {
        db.exec("DROP TABLE IF EXISTS s");
        db.exec(`CREATE VIRTUAL TABLE s USING fts5(${FTS_COLUMNS}, tokenize='porter unicode61')`);
        db.exec("COMMIT");
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
        }
        throw e;
      }
      db.close();
    });
  } catch (err) {
    return {
      migratedFrom: oldVersion,
      lastMode,
      kind: "phase1-failed",
      didMigrate: false,
      notifyMessage,
      phase1Error: String(err?.message ?? err)
    };
  }
  const sessDbPath = join5(indexDir, "sessions-fts.db");
  try {
    dbCall("migrate-wipe", { db: sessDbPath, comp: "migrateIndexFileIfStale" }, () => {
      const sessDb = new DatabaseSync3(sessDbPath);
      sessDb.exec("DROP TABLE IF EXISTS sessions");
      sessDb.close();
    });
  } catch (e) {
    log.debug(
      { comp: "migrateIndexFileIfStale", db: sessDbPath, err: String(e?.message ?? e) },
      "migrate-wipe skipped"
    );
  }
  mkdirSync4(indexDir, { recursive: true });
  const newData = JSON.stringify(
    { version: INDEX_VERSION, vectorDim: 0, sessions: {} },
    null,
    2
  );
  writeFileSync2(indexPath + ".tmp", newData, "utf8");
  renameSync2(indexPath + ".tmp", indexPath);
  return {
    migratedFrom: oldVersion,
    lastMode,
    kind: "clean",
    didMigrate: true,
    notifyMessage
  };
}
function encodeEmbedding(vec) {
  const buf = Buffer.from(new Float32Array(vec).buffer);
  return buf.toString("base64");
}
function decodeEmbedding(stored) {
  if (Array.isArray(stored)) return stored;
  const buf = Buffer.from(stored, "base64");
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}
function stripHeavyFields(session) {
  return {
    ...session,
    userMessages: [],
    assistantText: "",
    firstUserMessage: session.firstUserMessage.slice(0, 200),
    compactionSummaries: session.compactionSummaries.map((s) => s.slice(0, 300)),
    branchSummaries: session.branchSummaries.map((s) => s.slice(0, 200))
  };
}
var SessionIndex = class {
  constructor(embedder, indexDir, extraSessionDirs = [], extraArchiveDirs = [], mode, sessionDir, archiveDir, fusion = "rrf") {
    this.embedder = embedder;
    this.indexDir = indexDir;
    this.extraSessionDirs = extraSessionDirs;
    this.extraArchiveDirs = extraArchiveDirs;
    this.sessionDir = sessionDir;
    this.archiveDir = archiveDir;
    this.fusion = fusion;
    this.mode = mode ?? "fts-raw";
    mkdirSync4(indexDir, { recursive: true });
    this.indexPath = join5(indexDir, "session-index.json");
    this.fts = new FtsSide(indexDir);
  }
  embedder;
  indexDir;
  extraSessionDirs;
  extraArchiveDirs;
  sessionDir;
  archiveDir;
  fusion;
  data = { version: INDEX_VERSION, vectorDim: 0, sessions: {} };
  indexPath;
  fts;
  mode;
  /**
   * AbortController for in-flight embedder calls.
   * dispose() aborts this controller, cancelling all pending embeds.
   */
  abortController = new AbortController();
  /** True after dispose() — subsequent method calls are no-ops. */
  disposed = false;
  /** mtimeMs of session-index.json at our last read/write — cheap freshness
   *  probe for mergeFromDisk(). undefined until first load/save. */
  lastKnownIndexMtimeMs = void 0;
  /**
   * Mutex: while true, the periodic 5-min sync() returns early without work.
   * Set by backfill; cleared on completion. See task 6.6.
   */
  backfillInProgress = false;
  /**
   * Dispose this index instance (task 2.11a).
   * Aborts in-flight embedder fetches via the AbortController,
   * closes the FtsSide SQLite handle, and marks the instance terminal.
   * Called from session_start before constructing a new index during
   * verdict transitions.
   */
  dispose() {
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
  async load(onNotify, embedderConfig) {
    if (!existsSync3(this.indexPath)) {
      this.data = { version: INDEX_VERSION, vectorDim: 0, sessions: {} };
      return;
    }
    try {
      const raw = readFileSync3(this.indexPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.version === INDEX_VERSION) {
        this.data = parsed;
        this.lastKnownIndexMtimeMs = statSync3(this.indexPath).mtimeMs;
        if (this.data.vectorDim === void 0) this.data.vectorDim = 0;
        const previousMode = this.data.lastMode;
        if (previousMode !== void 0 && previousMode !== this.mode && this.mode === "digest-hybrid") {
          let cleared = 0;
          for (const entry of Object.values(this.data.sessions)) {
            if (entry.embedding && entry.embedding.length > 0) {
              entry.embedding = "";
              entry.sizeBytes = 0;
              cleared++;
            }
          }
          if (cleared > 0) {
            this.data.lastMode = this.mode;
            this.save();
            onNotify?.(
              `session-search: mode changed (${previousMode} \u2192 ${this.mode}); ${cleared} embeddings cleared. Run /session:backfill to re-populate.`,
              "info"
            );
          }
        }
        const effectiveDim = embedderConfig?.dimensions;
        if (effectiveDim !== void 0 && this.data.vectorDim !== 0 && this.data.vectorDim !== effectiveDim) {
          for (const entry of Object.values(this.data.sessions)) {
            entry.sizeBytes = 0;
          }
          this.data.vectorDim = effectiveDim;
          this.save();
          onNotify?.(
            "session-search: embedding dimension changed; re-embedding all sessions.",
            "info"
          );
        }
      } else {
        const oldVersion = parsed.version ?? "unknown";
        this.data = { version: INDEX_VERSION, vectorDim: 0, sessions: {} };
        this.fts.hardReset();
        const sessFtsPath = join5(this.indexDir, "sessions-fts.db");
        try {
          dbCall("hard-reset-sessions", { db: sessFtsPath, comp: "SessionIndex.load" }, () => {
            const sessDb = new DatabaseSync3(sessFtsPath);
            sessDb.exec("DROP TABLE IF EXISTS sessions");
            sessDb.close();
          });
        } catch (e) {
          log.debug({ comp: "SessionIndex.load", db: sessFtsPath, err: String(e?.message ?? e) }, "hard-reset-sessions skipped");
        }
        onNotify?.(
          `session-search: index version ${oldVersion} is incompatible; reset to v4. Run /session:backfill to repopulate.`,
          "info"
        );
      }
    } catch {
      this.data = { version: INDEX_VERSION, vectorDim: 0, sessions: {} };
    }
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
  populateFtsFromIndex() {
    for (const [id, entry] of Object.entries(this.data.sessions)) {
      const s = entry.session;
      const digestBody = this.mode === "digest-hybrid" && entry.digest ? entry.digest.body : "";
      const rawContent = "";
      if (digestBody || rawContent) {
        this.fts.upsert(id, { digestBody, rawContent, name: s.name ?? "" });
      }
    }
  }
  /** Save index to disk via temp+rename pattern for crash safety. */
  save() {
    this.data.lastMode = this.mode === "digest-hybrid" ? "digest-hybrid" : "fts-raw";
    const data = JSON.stringify(this.data);
    writeFileSync2(this.indexPath + ".tmp", data, "utf8");
    renameSync2(this.indexPath + ".tmp", this.indexPath);
    try {
      this.lastKnownIndexMtimeMs = statSync3(this.indexPath).mtimeMs;
    } catch {
    }
  }
  /**
   * Merge the on-disk index into memory so concurrent pi processes converge.
   *
   * Every pi process holds its own in-memory copy of the shared index file.
   * Without this merge, when process A re-embeds a session and saves, every
   * other process still compares against its stale in-memory sizeBytes and
   * re-parses/re-embeds/re-upserts the same content every sync cycle —
   * redundant synchronous SQLite bursts that freeze the TUI.
   *
   * Merge rule: adopt a disk entry when it is missing locally or its
   * sizeBytes is strictly larger (another process embedded newer content).
   * Never revert fresher local work. In-memory-only entries (backfill's
   * batched adds) are preserved; sync() skips merging during backfill anyway.
   *
   * Cheap when nothing changed: a statSync against the mtime recorded at our
   * last load/save short-circuits before any read.
   */
  mergeFromDisk() {
    if (this.disposed) return;
    let mtimeMs;
    try {
      const st = statSync3(this.indexPath);
      if (st.mtimeMs === this.lastKnownIndexMtimeMs) return;
      this.lastKnownIndexMtimeMs = st.mtimeMs;
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync3(this.indexPath, "utf8"));
      if (parsed.version !== INDEX_VERSION || !parsed.sessions) return;
      for (const [id, diskEntry] of Object.entries(parsed.sessions)) {
        const mem = this.data.sessions[id];
        if (!mem || (diskEntry.sizeBytes ?? 0) > (mem.sizeBytes ?? 0)) {
          this.data.sessions[id] = diskEntry;
        }
      }
    } catch {
    }
  }
  /**
   * Flush in-memory state to disk (task 6.5).
   * Called by backfill every 25 digests + on completion.
   */
  flush() {
    this.save();
  }
  /** Number of indexed sessions. */
  size() {
    return Object.keys(this.data.sessions).length;
  }
  /**
   * Switch the operating mode of this index (task 4.5.1).
   * Used when the mode changes between sessions (e.g. legacy hybrid-raw → digest-hybrid).
   */
  setMode(mode) {
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
  async sync(onProgress, onError) {
    if (this.backfillInProgress) {
      return { added: 0, updated: 0, removed: 0, moved: 0 };
    }
    this.mergeFromDisk();
    const discovered = discoverSessionFiles(
      this.extraSessionDirs,
      this.extraArchiveDirs,
      this.sessionDir,
      this.archiveDir
    );
    let added = 0;
    let updated = 0;
    let removed = 0;
    let moved = 0;
    const fileToId = /* @__PURE__ */ new Map();
    const idToFile = /* @__PURE__ */ new Map();
    const indexedFileToId = /* @__PURE__ */ new Map();
    for (const [id, entry] of Object.entries(this.data.sessions)) {
      indexedFileToId.set(entry.session.file, id);
    }
    for (const { file, archived } of discovered) {
      let mtimeMs;
      let sizeBytes;
      try {
        const st = statSync3(file);
        mtimeMs = st.mtimeMs;
        sizeBytes = st.size;
      } catch {
        continue;
      }
      let sessionId = indexedFileToId.get(file) ?? null;
      if (!sessionId) {
        sessionId = readSessionId(file);
      }
      if (!sessionId) continue;
      fileToId.set(file, sessionId);
      const existing = idToFile.get(sessionId);
      if (!existing || mtimeMs > existing.mtimeMs) {
        idToFile.set(sessionId, { file, archived, mtimeMs, sizeBytes });
      }
    }
    const discoveredIds = new Set(idToFile.keys());
    for (const id of Object.keys(this.data.sessions)) {
      if (!discoveredIds.has(id)) {
        delete this.data.sessions[id];
        this.fts.delete(id);
        removed++;
      }
    }
    const toEmbed = [];
    for (const [id, disc] of idToFile.entries()) {
      const existing = this.data.sessions[id];
      if (existing) {
        const pathChanged = existing.session.file !== disc.file;
        const sizeChanged = (existing.sizeBytes ?? 0) !== disc.sizeBytes;
        if (pathChanged && !sizeChanged) {
          existing.session.file = disc.file;
          existing.session.archived = disc.archived;
          existing.mtimeMs = disc.mtimeMs;
          existing.sizeBytes = disc.sizeBytes;
          moved++;
        } else if (sizeChanged) {
          toEmbed.push({ id, ...disc });
        }
      } else {
        toEmbed.push({ id, ...disc });
      }
    }
    if (toEmbed.length === 0) {
      if (moved > 0 || removed > 0) this.save();
      return { added, updated, removed, moved };
    }
    onProgress?.(`Indexing ${toEmbed.length} sessions...`);
    const BATCH_SIZE = 20;
    for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
      const batch = toEmbed.slice(i, i + BATCH_SIZE);
      const parsed = [];
      for (const item of batch) {
        const session = parseSession(item.file, item.archived);
        if (session && session.userMessageCount > 0) {
          const digest = this.mode === "digest-hybrid" ? loadDigest(item.id) : null;
          parsed.push({ item, session, digest });
        } else if (session) {
          this.data.sessions[item.id] = {
            session: stripHeavyFields(session),
            digest: null,
            embedding: [],
            mtimeMs: item.mtimeMs,
            sizeBytes: item.sizeBytes
          };
        }
      }
      if (parsed.length === 0) {
        onProgress?.(
          `Indexed ${Math.min(i + BATCH_SIZE, toEmbed.length)}/${toEmbed.length}...`
        );
        continue;
      }
      if (this.mode === "digest-hybrid") {
        for (const { item, session, digest } of parsed) {
          const isUpdate = !!this.data.sessions[item.id];
          if (digest) {
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
                sizeBytes: item.sizeBytes
              };
              this.fts.upsert(item.id, { digestBody: digest.body, rawContent: buildRawFtsContent(session), name: session.name ?? "" });
            } catch (err) {
              onProgress?.(`Embedding failed for ${item.id}: ${err.message}`);
              this.data.sessions[item.id] = {
                session: stripHeavyFields(session),
                digest,
                embedding: [],
                mtimeMs: item.mtimeMs,
                sizeBytes: item.sizeBytes
              };
            }
          } else {
            this.data.sessions[item.id] = {
              session: stripHeavyFields(session),
              digest: null,
              embedding: [],
              mtimeMs: item.mtimeMs,
              sizeBytes: item.sizeBytes
            };
            this.fts.upsert(item.id, { digestBody: "", rawContent: buildRawFtsContent(session), name: session.name ?? "" });
          }
          if (isUpdate) updated++;
          else added++;
        }
      } else {
        const texts = parsed.map(({ session }) => session.userMessages?.join("\n") ?? "");
        try {
          const embeddings = await this.embedder.embedBatch(texts, this.abortController.signal);
          for (let j = 0; j < parsed.length; j++) {
            const { item, session } = parsed[j];
            const embedding = embeddings[j];
            if (!embedding) continue;
            if (this.data.vectorDim === 0 && embedding.length > 0) {
              this.data.vectorDim = embedding.length;
            }
            const isUpdate = !!this.data.sessions[item.id];
            this.data.sessions[item.id] = {
              session: stripHeavyFields(session),
              digest: null,
              embedding: encodeEmbedding(embedding),
              mtimeMs: item.mtimeMs,
              sizeBytes: item.sizeBytes
            };
            this.fts.upsert(item.id, { digestBody: "", rawContent: buildContent(session), name: session.name ?? "" });
            if (isUpdate) updated++;
            else added++;
          }
        } catch (err) {
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
  async rebuild(onProgress) {
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
  async addDigested(sessionId, session, digest, opts) {
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
      sizeBytes: existing?.sizeBytes
    };
    this.fts.upsert(sessionId, { digestBody: digest.body, rawContent: buildRawFtsContent(session), name: session.name ?? "" });
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
  getDigest(sessionId) {
    return this.data.sessions[sessionId]?.digest ?? null;
  }
  /**
   * Hybrid search: cosine embeddings + FTS5 BM25, fused via Reciprocal Rank
   * Fusion (k=60). Falls back to pure semantic if FTS side-car is empty.
   *
   * Task 6.11: in digest-hybrid, filter out entries with empty embedding BEFORE
   * cosine scoring. Also filters FTS rows with empty content.
   */
  async search(query, limit = 10, signal, project) {
    const slug = project?.toLowerCase();
    const allEntries = Object.entries(this.data.sessions).filter(([, entry]) => !slug || entry.session.projectSlug.toLowerCase().includes(slug) || entry.session.cwd.toLowerCase().includes(slug));
    if (allEntries.length === 0) return [];
    let embeddedEntries = allEntries;
    if (this.mode === "digest-hybrid") {
      embeddedEntries = allEntries.filter(([, entry]) => {
        const emb = entry.embedding;
        if (Array.isArray(emb)) return emb.length > 0;
        return typeof emb === "string" && emb.length > 0;
      });
    }
    const poolSize = Math.max(limit * 5, 100);
    const cosineRanks = /* @__PURE__ */ new Map();
    if (embeddedEntries.length > 0) {
      const queryEmbedding = await this.embedder.embed(query, this.abortController.signal);
      if (signal?.aborted) return [];
      const cosineScored = embeddedEntries.map(([id, entry]) => ({
        id,
        entry,
        score: cosineSimilarity(queryEmbedding, decodeEmbedding(entry.embedding))
      })).sort((a, b) => b.score - a.score);
      cosineScored.slice(0, poolSize).forEach((s, i) => {
        cosineRanks.set(s.id, i + 1);
      });
    }
    const ftsRanks = this.fts.searchRanks(query, poolSize, project ? new Set(allEntries.map(([id]) => id)) : void 0);
    if (cosineRanks.size === 0 && ftsRanks.size === 0) return [];
    const K = 60;
    const fused = /* @__PURE__ */ new Map();
    for (const [id, r] of cosineRanks) fused.set(id, (fused.get(id) ?? 0) + 1 / (K + r));
    for (const [id, r] of ftsRanks) fused.set(id, (fused.get(id) ?? 0) + 1 / (K + r));
    let sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    if (this.fusion === "vector-primary") {
      const ids = [...cosineRanks.keys()].slice(0, limit);
      let appended = 0;
      for (const id of ftsRanks.keys()) {
        if (appended >= 5) break;
        if (!ids.includes(id)) {
          ids.push(id);
          appended++;
        }
      }
      sorted = ids.slice(0, limit).map((id, rank) => [id, 1 / (60 + rank + 1)]);
    }
    return sorted.map(([id, score]) => {
      const entry = this.data.sessions[id];
      if (!entry) return null;
      return {
        session: entry.session,
        summary: buildSummary(entry.session, entry.digest),
        score
      };
    }).filter((r) => r !== null);
  }
  /**
   * List sessions with optional filters.
   */
  list(filters) {
    let sessions = Object.values(this.data.sessions).map((e) => e.session);
    if (filters?.project) {
      const slug = filters.project.toLowerCase();
      sessions = sessions.filter(
        (s) => s.projectSlug.toLowerCase().includes(slug) || s.cwd.toLowerCase().includes(slug)
      );
    }
    if (filters?.after) {
      sessions = sessions.filter((s) => s.startedAt >= filters.after);
    }
    if (filters?.before) {
      sessions = sessions.filter((s) => s.startedAt <= filters.before);
    }
    if (filters?.archived !== void 0) {
      sessions = sessions.filter((s) => s.archived === filters.archived);
    }
    sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (filters?.limit) {
      sessions = sessions.slice(0, filters.limit);
    }
    return sessions;
  }
  /**
   * Get a specific session by file path or session ID.
   */
  get(fileOrId) {
    if (this.data.sessions[fileOrId]) {
      return this.data.sessions[fileOrId];
    }
    return Object.values(this.data.sessions).find(
      (e) => e.session.file === fileOrId
    );
  }
  /** Get all indexed session objects. */
  getAll() {
    return Object.values(this.data.sessions);
  }
  close() {
    this.fts.close();
  }
};
function cosineSimilarity(a, b) {
  if (a.length === 0 || b.length === 0) {
    throw new Error(
      `cosineSimilarity: vectors must be non-empty (got lengths ${a.length}, ${b.length})`
    );
  }
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: vector length mismatch (${a.length} vs ${b.length}); ensure all embeddings use the same model and dimensions setting`
    );
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// src/index-service.ts
function createIndexService(options) {
  let index = null;
  let inflightSync = null;
  let writerTail = Promise.resolve();
  const open = () => {
    if (!index) throw new Error("session index is not loaded");
    return index;
  };
  const exclusive = (fn) => {
    const run = writerTail.then(fn);
    writerTail = run.catch(() => {
    });
    return run;
  };
  return {
    async load(callbacks) {
      const migration = migrateIndexFileIfStale(options.indexDir);
      if (migration.didMigrate) callbacks?.onError?.(`index version ${migration.migratedFrom} is incompatible; reset. Run /session:backfill to repopulate.`);
      const embedder = options.digestHybrid && options.embedder ? createEmbedder(options.embedder) : null;
      index ??= embedder ? new SessionIndex(
        embedder,
        options.indexDir,
        options.extraSessionDirs,
        options.extraArchiveDirs,
        "digest-hybrid",
        options.sessionDir,
        options.archiveDir,
        options.fusion
      ) : new FtsSessionIndex(
        options.indexDir,
        options.extraSessionDirs,
        options.extraArchiveDirs,
        options.sessionDir,
        options.archiveDir
      );
      await index.load((msg) => callbacks?.onError?.(msg), options.embedder);
      return index.size();
    },
    sync(callbacks) {
      inflightSync ??= exclusive(
        () => open().sync(callbacks?.onProgress, callbacks?.onError)
      ).finally(() => {
        inflightSync = null;
      });
      return inflightSync;
    },
    rebuild(callbacks) {
      return exclusive(() => open().rebuild(callbacks?.onProgress, callbacks?.onError));
    },
    // Results drop the raw message text: the tools never show it, and it is
    // the bulk of what would otherwise be cloned across the thread boundary.
    async search(query, limit, project) {
      const results = await open().search(query, limit, void 0, project);
      return results.map((r) => ({ ...r, session: stripHeavyFields(r.session) }));
    },
    async list(filters) {
      return open().list(filters).map(stripHeavyFields);
    },
    async get(fileOrId) {
      const entry = open().get(fileOrId);
      return entry && { session: stripHeavyFields(entry.session), summary: "summary" in entry ? entry.summary : buildSummary(entry.session, entry.digest) };
    },
    async size() {
      return index?.size() ?? 0;
    },
    async getDigest(id) {
      const current = open();
      return current instanceof SessionIndex ? current.getDigest(id) : null;
    },
    addDigested(id, session, digest, opts) {
      return exclusive(async () => {
        const current = open();
        if (current instanceof SessionIndex) await current.addDigested(id, session, digest, opts);
      });
    },
    addDigest(id, digest) {
      return exclusive(async () => {
        const current = open();
        if (!(current instanceof SessionIndex)) return;
        let session = current.get(id)?.session;
        if (!session) {
          const file = discoverSessionFiles(options.extraSessionDirs, options.extraArchiveDirs, options.sessionDir, options.archiveDir).find((entry) => readSessionId(entry.file) === id);
          if (file) session = parseSession(file.file, file.archived) ?? void 0;
        }
        if (session) await current.addDigested(id, session, digest);
      });
    },
    flush() {
      return exclusive(async () => {
        const current = open();
        if (current instanceof SessionIndex) current.flush();
      });
    },
    setBackfillInProgress(value) {
      return exclusive(async () => {
        const current = open();
        if (current instanceof SessionIndex) current.backfillInProgress = value;
      });
    },
    async close() {
      await writerTail;
      if (index instanceof SessionIndex) index.dispose();
      else index?.close();
      index = null;
    }
  };
}
async function handleWorkerRequest(service2, req, post) {
  const callbacks = {
    onProgress: (msg) => post({ id: req.id, type: "progress", msg }),
    onError: (msg) => post({ id: req.id, type: "notice", msg })
  };
  const [a, b, c, d] = req.args;
  try {
    const value = await {
      load: () => service2.load(callbacks),
      sync: () => service2.sync(callbacks),
      rebuild: () => service2.rebuild(callbacks),
      search: () => service2.search(a, b, c),
      list: () => service2.list(a),
      get: () => service2.get(a),
      size: () => service2.size(),
      close: () => service2.close(),
      getDigest: () => service2.getDigest(a),
      addDigested: () => service2.addDigested(a, b, c, d),
      addDigest: () => service2.addDigest(a, b),
      flush: () => service2.flush(),
      setBackfillInProgress: () => service2.setBackfillInProgress(a)
    }[req.op]();
    post({ id: req.id, type: "result", value });
  } catch (err) {
    post({ id: req.id, type: "failure", message: err?.message ?? String(err) });
  }
}

// src/index-worker.ts
var port = parentPort;
if (!port) throw new Error("index-worker must run as a worker thread");
var service = createIndexService(workerData);
port.on("message", (req) => {
  void handleWorkerRequest(service, req, (reply) => port.postMessage(reply));
});
//# sourceMappingURL=index-worker.js.map

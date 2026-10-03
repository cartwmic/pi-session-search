// src/index.ts
import { Type as Type2 } from "typebox";
import { existsSync as existsSync7 } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir as homedir4 } from "node:os";

// src/config.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

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
function formatRelativeDate(iso) {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 6e4);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  if (days < 14) return "last week";
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return months <= 1 ? "last month" : `${months}mo ago`;
}
function sessionSearchHome() {
  const override = process.env.PI_SESSION_SEARCH_HOME;
  if (override && override.length > 0) return override;
  return `${homedir()}/.pi/session-search`;
}
function pathToSlug(cwd) {
  const home = homedir();
  const rel = cwd.startsWith(home) ? cwd.slice(home.length + 1) : cwd;
  return rel.replace(/\//g, "-");
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

// src/config.ts
import { join, dirname } from "node:path";
var DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1e3;
var DEFAULT_INITIAL_DELAY_MS = 0;
function globalConfigDir() {
  return sessionSearchHome();
}
function globalConfigFile() {
  return join(globalConfigDir(), "config.json");
}
function globalIndexDir() {
  return join(globalConfigDir(), "index");
}
function warnUnknownKeys(block, blockName, knownKeys) {
  if (!block || typeof block !== "object") return;
  const unknown = Object.keys(block).filter((k) => !knownKeys.includes(k));
  if (unknown.length === 0) return;
  console.error(
    `pi-session-search: ignoring unknown key(s) in settings.json "${blockName}" block: ${unknown.join(", ")} (expected: ${knownKeys.join(", ")})`
  );
}
var PI_SESSION_SEARCH_SETTINGS_KEYS = ["localPath"];
var PI_TOTAL_RECALL_KNOWN_KEYS = ["localPath"];
function resolveLocalBase(cwd) {
  if (!cwd) return null;
  try {
    const raw = readFileSync(join(cwd, ".pi", "settings.json"), "utf-8");
    const settings = JSON.parse(raw) ?? {};
    const ss = settings["pi-session-search"];
    warnUnknownKeys(ss, "pi-session-search", PI_SESSION_SEARCH_SETTINGS_KEYS);
    if (ss && typeof ss === "object" && typeof ss.localPath === "string" && ss.localPath) {
      return ss.localPath;
    }
    const tr = settings["pi-total-recall"];
    warnUnknownKeys(tr, "pi-total-recall", PI_TOTAL_RECALL_KNOWN_KEYS);
    if (tr && typeof tr === "object" && typeof tr.localPath === "string" && tr.localPath) {
      return join(tr.localPath, "session-search");
    }
  } catch {
  }
  return null;
}
function getConfigPath(cwd) {
  const base = resolveLocalBase(cwd);
  if (base) return join(base, "config.json");
  return globalConfigFile();
}
function getIndexDir(cwd) {
  const base = resolveLocalBase(cwd);
  if (base) return join(base, "index");
  return globalIndexDir();
}
function loadConfig(cwd) {
  const configFile = getConfigPath(cwd);
  if (!existsSync(configFile)) return null;
  const raw = readFileSync(configFile, "utf8");
  let file;
  try {
    file = JSON.parse(raw);
  } catch {
    return null;
  }
  let embedder = file.embedder;
  if (embedder?.type === "openai-compatible") {
    const { type: _type, ...rest } = embedder;
    embedder = rest;
  }
  const rawInterval = file.sync?.interval;
  const rawInitialDelay = file.sync?.initialDelay;
  const rawDisableForChild = file.sync?.disableForChild;
  let syncCfg;
  const syncFields = {};
  if (typeof rawInterval === "number") syncFields.interval = rawInterval;
  if (typeof rawInitialDelay === "number") syncFields.initialDelay = rawInitialDelay;
  if (typeof rawDisableForChild === "boolean") syncFields.disableForChild = rawDisableForChild;
  if (Object.keys(syncFields).length > 0) syncCfg = syncFields;
  return {
    extraSessionDirs: file.extraSessionDirs ?? [],
    extraArchiveDirs: file.extraArchiveDirs ?? [],
    sessionDir: typeof file.sessionDir === "string" && file.sessionDir ? file.sessionDir : void 0,
    archiveDir: typeof file.archiveDir === "string" && file.archiveDir ? file.archiveDir : void 0,
    sync: syncCfg,
    primer: file.primer,
    embedder,
    fusion: file.fusion === "vector-primary" ? "vector-primary" : "rrf"
  };
}
function saveConfig(file, cwd) {
  const configFile = getConfigPath(cwd);
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(file, null, 2), "utf8");
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

// src/index-service.ts
import { Worker } from "node:worker_threads";

// src/index/fts-index.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { mkdirSync as mkdirSync3, statSync as statSync2 } from "node:fs";
import { join as join4 } from "node:path";

// src/parser.ts
import { readFileSync as readFileSync2, readdirSync, existsSync as existsSync2, openSync, readSync, closeSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2, basename, dirname as dirname2 } from "node:path";
function getDefaultSessionDir() {
  return process.env.PI_SESSION_DIR || join2(homedir2(), ".pi", "agent", "sessions");
}
function getDefaultArchiveDir() {
  return process.env.PI_SESSION_ARCHIVE_DIR || join2(homedir2(), ".pi", "agent", "sessions-archive");
}
function discoverSessionFiles(extraSessionDirs = [], extraArchiveDirs = [], sessionDir, archiveDir) {
  const sDirs = [sessionDir ?? getDefaultSessionDir(), ...extraSessionDirs];
  const aDirs = [archiveDir ?? getDefaultArchiveDir(), ...extraArchiveDirs];
  const results = [];
  for (const dir of sDirs) {
    if (!existsSync2(dir)) continue;
    for (const entry of walkJsonl(dir)) {
      results.push({ file: entry, archived: false });
    }
  }
  for (const dir of aDirs) {
    if (!existsSync2(dir)) continue;
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
      const full = join2(dir, entry.name);
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
    raw = readFileSync2(file, "utf8");
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
  const parentDir = basename(dirname2(file));
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
import { dirname as dirname3, join as join3 } from "node:path";
import { mkdirSync as mkdirSync2 } from "node:fs";
import { performance as performance2 } from "node:perf_hooks";
import pino from "pino";
import { createStream } from "rotating-file-stream";
var cachedLogger;
var cachedPath = null;
function buildLogger() {
  const DEBUG = process.env.PI_SESSION_SEARCH_DEBUG !== "0";
  const DEBUG_LOG_PATH = process.env.PI_SESSION_SEARCH_DEBUG_PATH || join3(homedir3(), ".pi", "agent", "session-search.log");
  const DEBUG_MAX_BYTES = Number(process.env.PI_SESSION_SEARCH_DEBUG_MAX_BYTES) || 10 * 1024 * 1024;
  const LEVEL = process.env.PI_SESSION_SEARCH_DEBUG_LEVEL || "debug";
  const SYNC_FILE = process.env.PI_SESSION_SEARCH_LOG_SYNC_FILE;
  let destinationStream;
  let resolvedPath = null;
  if (SYNC_FILE) {
    try {
      mkdirSync2(dirname3(SYNC_FILE), { recursive: true });
      destinationStream = pino.destination({ dest: SYNC_FILE, sync: true });
      resolvedPath = SYNC_FILE;
    } catch {
      destinationStream = void 0;
    }
  } else if (DEBUG) {
    try {
      mkdirSync2(dirname3(DEBUG_LOG_PATH), { recursive: true });
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
function getLogPath() {
  getLogger();
  return cachedPath;
}
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
    mkdirSync3(indexDir, { recursive: true });
    this.dbPath = join4(indexDir, "sessions-fts.db");
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
import { readFileSync as readFileSync4, writeFileSync as writeFileSync3, renameSync as renameSync2, existsSync as existsSync4, mkdirSync as mkdirSync5, statSync as statSync3 } from "node:fs";
import { join as join6 } from "node:path";
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
  readFileSync as readFileSync3,
  writeFileSync as writeFileSync2,
  renameSync,
  readdirSync as readdirSync2,
  existsSync as existsSync3,
  mkdirSync as mkdirSync4
} from "node:fs";
import { join as join5, basename as basename2 } from "node:path";

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
var submitDigestTool = {
  name: "submit_digest",
  description: "Submit a structured digest summarizing the session conversation. Call this tool exactly once with the complete digest. Do not call any other tools or output any other text.",
  parameters: DigestArgs
};

// src/digest/storage.ts
function getDigestDir() {
  return join5(sessionSearchHome(), "digests");
}
function ensureDir() {
  mkdirSync4(getDigestDir(), { recursive: true });
}
function digestPath(sessionId) {
  return join5(getDigestDir(), `${sessionId}.json`);
}
function loadDigest(sessionId) {
  const p = digestPath(sessionId);
  if (!existsSync3(p)) return null;
  try {
    const obj = JSON.parse(readFileSync3(p, "utf-8"));
    return validateDigest(obj);
  } catch {
    return null;
  }
}
function saveDigest(sessionId, digest) {
  ensureDir();
  const p = digestPath(sessionId);
  const tmp = `${p}.tmp`;
  writeFileSync2(tmp, JSON.stringify(digest, null, 2), "utf-8");
  renameSync(tmp, p);
}
function listDigestedSessionIds() {
  const dir = getDigestDir();
  if (!existsSync3(dir)) return [];
  try {
    return readdirSync2(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".state.json")).map((f) => basename2(f, ".json"));
  } catch {
    return [];
  }
}
function statePath(sessionId) {
  return join5(getDigestDir(), `${sessionId}.state.json`);
}
function loadBuilderState(sessionId) {
  const p = statePath(sessionId);
  if (!existsSync3(p)) return null;
  try {
    const obj = JSON.parse(readFileSync3(p, "utf-8"));
    if (obj != null && typeof obj.convTokensAtLastWrite === "number" && typeof obj.lastWrittenMessageIndex === "number" && typeof obj.lastWrittenSummaryIndex === "number") {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}
function saveBuilderState(sessionId, state) {
  ensureDir();
  const p = statePath(sessionId);
  const tmp = `${p}.tmp`;
  writeFileSync2(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, p);
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
    this.dbPath = join6(indexDir, "hybrid-fts.db");
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
  const indexPath = join6(indexDir, "session-index.json");
  if (!existsSync4(indexPath)) return { kind: "noop", didMigrate: false };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync4(indexPath, "utf8"));
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
  const ftsPath = join6(indexDir, "hybrid-fts.db");
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
  const sessDbPath = join6(indexDir, "sessions-fts.db");
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
  mkdirSync5(indexDir, { recursive: true });
  const newData = JSON.stringify(
    { version: INDEX_VERSION, vectorDim: 0, sessions: {} },
    null,
    2
  );
  writeFileSync3(indexPath + ".tmp", newData, "utf8");
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
    mkdirSync5(indexDir, { recursive: true });
    this.indexPath = join6(indexDir, "session-index.json");
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
    if (!existsSync4(this.indexPath)) {
      this.data = { version: INDEX_VERSION, vectorDim: 0, sessions: {} };
      return;
    }
    try {
      const raw = readFileSync4(this.indexPath, "utf8");
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
        const sessFtsPath = join6(this.indexDir, "sessions-fts.db");
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
    writeFileSync3(this.indexPath + ".tmp", data, "utf8");
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
      const parsed = JSON.parse(readFileSync4(this.indexPath, "utf8"));
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
function spawnIndexWorker(workerFile, options, onCrash) {
  const worker = new Worker(workerFile, { workerData: options, stdout: true, stderr: true });
  worker.stdout.resume();
  let stderrTail = "";
  worker.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-1e3);
  });
  let nextId = 1;
  let dead = null;
  let closing = false;
  const pending = /* @__PURE__ */ new Map();
  const die = (err) => {
    if (dead) return;
    dead = err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    if (!closing) onCrash(err);
  };
  worker.on("message", (reply) => {
    const p = pending.get(reply.id);
    if (!p) return;
    if (reply.type === "progress") p.callbacks?.onProgress?.(reply.msg);
    else if (reply.type === "notice") p.callbacks?.onError?.(reply.msg);
    else {
      pending.delete(reply.id);
      if (reply.type === "result") p.resolve(reply.value);
      else p.reject(new Error(reply.message));
    }
  });
  worker.on("error", die);
  worker.on("exit", (code) => {
    const detail = stderrTail.trim().split("\n").filter(Boolean).pop();
    die(new Error(`index worker exited with code ${code}${detail ? `: ${detail}` : ""}`));
  });
  const call = (op, args = [], callbacks) => new Promise((resolve2, reject) => {
    if (dead) return reject(dead);
    const id = nextId++;
    pending.set(id, { resolve: resolve2, reject, callbacks });
    worker.postMessage({ id, op, args });
  });
  return {
    load: (callbacks) => call("load", [], callbacks),
    sync: (callbacks) => call("sync", [], callbacks),
    rebuild: (callbacks) => call("rebuild", [], callbacks),
    search: (query, limit, project) => call("search", [query, limit, project]),
    list: (filters) => call("list", [filters]),
    get: (fileOrId) => call("get", [fileOrId]),
    size: () => call("size"),
    getDigest: (id) => call("getDigest", [id]),
    addDigested: (id, session, digest, opts) => call("addDigested", [id, session, digest, opts]),
    addDigest: (id, digest) => call("addDigest", [id, digest]),
    flush: () => call("flush"),
    setBackfillInProgress: (value) => call("setBackfillInProgress", [value]),
    async close() {
      closing = true;
      await worker.terminate();
    }
  };
}

// src/index/mode.ts
import { existsSync as existsSync5 } from "node:fs";
import { join as join7 } from "node:path";

// src/digest/model-resolver.ts
function resolveModel(config, registry) {
  if (!config.provider || !config.model) return void 0;
  return registry.find(
    (m) => m.provider === config.provider && m.id === config.model || `${m.provider}/${m.id}` === `${config.provider}/${config.model}`
  );
}

// src/index/mode.ts
function missingTitle(missing) {
  switch (missing) {
    case "embedder":
      return "no embedder";
    case "digest":
      return "no digest model";
    case "both":
      return "no embedder, no digest model";
  }
}
function composeRemediation(missing) {
  const statusLine = `session-search: misconfigured (${missingTitle(missing)})`;
  let notifyMessage;
  switch (missing) {
    case "digest":
      notifyMessage = "session-search: misconfigured (no digest model). Configure ~/.pi/session-search/digest.json with provider+model, or remove ~/.pi/session-search/config.json to use fts-raw mode.";
      break;
    case "embedder":
      notifyMessage = "session-search: misconfigured (no embedder). Configure ~/.pi/session-search/config.json with embedder, or remove ~/.pi/session-search/digest.json to use fts-raw mode.";
      break;
    case "both":
      notifyMessage = "session-search: misconfigured (no embedder, no digest model). Configure both ~/.pi/session-search/config.json AND ~/.pi/session-search/digest.json, or remove both files to use fts-raw mode.";
      break;
  }
  return { statusLine, notifyMessage };
}
function digestRequested(config, cwd) {
  const globalFile = join7(sessionSearchHome(), "digest.json");
  const projectFile = join7(cwd, ".pi", "session-search", "digest.json");
  if (existsSync5(globalFile) || existsSync5(projectFile)) return true;
  if (config.provider !== void 0 && config.model !== void 0) return true;
  return false;
}
function computeVerdictSync(input) {
  const { embedderAvailable, digestModelResolved, digestRequested: requested } = input;
  if (!requested) {
    return { kind: "fts-raw" };
  }
  if (embedderAvailable && digestModelResolved) {
    return { kind: "digest-hybrid" };
  }
  const missing = !embedderAvailable && !digestModelResolved ? "both" : !embedderAvailable ? "embedder" : "digest";
  const { statusLine, notifyMessage } = composeRemediation(missing);
  return { kind: "misconfigured", missing, statusLine, notifyMessage };
}
async function resolveModeVerdict(config, registryGetter, opts) {
  const embedderAvailable = opts?.embedderAvailable ?? config?.embedder !== void 0;
  const cwd = opts?.cwd ?? process.cwd();
  const requested = opts?.digestConfig ? digestRequested(opts.digestConfig, cwd) : false;
  const delay = opts?.delay ?? defaultDelay;
  const registry = registryGetter();
  const digestModel = opts?.digestConfig ? resolveModel(opts.digestConfig, registry) : void 0;
  const digestModelResolved = digestModel !== void 0;
  let verdict = computeVerdictSync({
    config,
    embedderAvailable,
    digestModelResolved,
    digestRequested: requested
  });
  if (verdict.kind === "misconfigured" && (verdict.missing === "digest" || verdict.missing === "both") && requested) {
    await delay(1e3);
    const registry2 = registryGetter();
    const digestModel2 = opts?.digestConfig ? resolveModel(opts.digestConfig, registry2) : void 0;
    const digestModelResolved2 = digestModel2 !== void 0;
    verdict = computeVerdictSync({
      config,
      embedderAvailable,
      digestModelResolved: digestModelResolved2,
      digestRequested: requested
    });
  }
  return verdict;
}
var defaultDelay = (ms) => new Promise((resolve2) => setTimeout(resolve2, ms));

// src/digest/config.ts
import { readFileSync as readFileSync5, writeFileSync as writeFileSync4, existsSync as existsSync6, mkdirSync as mkdirSync6, renameSync as renameSync3 } from "node:fs";
import { join as join8 } from "node:path";
import { randomBytes } from "node:crypto";
function globalDigestDir() {
  return sessionSearchHome();
}
function globalDigestFile() {
  return join8(globalDigestDir(), "digest.json");
}
function projectDigestFile(cwd) {
  return join8(cwd, ".pi", "session-search", "digest.json");
}
function getDigestConfigPath() {
  return globalDigestFile();
}
var DEFAULTS = {
  debounceSeconds: 60,
  resummarizeTokenThreshold: 1e4,
  maxTokens: 1500,
  showWidget: false,
  verbose: false
};
function parsePartial(path) {
  if (!existsSync6(path)) return null;
  const raw = readFileSync5(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    log.warn({ comp: "digest-config", path }, "malformed digest config; falling back to defaults");
    return null;
  }
}
function loadDigestConfig(cwd) {
  const global = parsePartial(globalDigestFile()) ?? {};
  const project = parsePartial(projectDigestFile(cwd)) ?? {};
  const merged = { ...DEFAULTS, ...global, ...project };
  return {
    ...merged.provider !== void 0 ? { provider: merged.provider } : {},
    ...merged.model !== void 0 ? { model: merged.model } : {},
    debounceSeconds: merged.debounceSeconds,
    resummarizeTokenThreshold: merged.resummarizeTokenThreshold,
    maxTokens: merged.maxTokens,
    showWidget: merged.showWidget,
    verbose: merged.verbose
  };
}
function saveDigestConfig(config) {
  const dir = globalDigestDir();
  mkdirSync6(dir, { recursive: true });
  const tmp = join8(dir, `.digest-${randomBytes(6).toString("hex")}.json.tmp`);
  writeFileSync4(tmp, JSON.stringify(config, null, 2), "utf8");
  renameSync3(tmp, globalDigestFile());
}

// src/digest/model-picker.ts
import {
  Input,
  SelectList,
  fuzzyFilter
} from "@earendil-works/pi-tui";
var FuzzySelectList = class extends SelectList {
  setFilter(filter) {
    const self = this;
    const trimmed = filter.trim();
    if (!trimmed) {
      self.filteredItems = self.items.slice();
      self.selectedIndex = 0;
      return;
    }
    self.filteredItems = fuzzyFilter(
      self.items,
      trimmed,
      (item) => `${item.label} ${item.description ?? ""}`
    );
    self.selectedIndex = 0;
  }
};
var ModelPickerComponent = class {
  constructor(tui, theme, done, items, prompt, currentModel) {
    this.done = done;
    this.tui = tui;
    this.theme = theme;
    this.prompt = prompt;
    this.list = new FuzzySelectList(
      items,
      Math.min(items.length, 12),
      {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t)
      }
    );
    if (currentModel) {
      const idx = items.findIndex((i) => i.value === currentModel);
      if (idx >= 0) this.list.setSelectedIndex(idx);
    }
    this.list.onSelect = (item) => this.done(item.value);
    this.list.onCancel = () => this.done(void 0);
    this.input = new Input();
    this.input.focused = true;
  }
  done;
  focused = true;
  input;
  list;
  prompt;
  theme;
  tui;
  invalidate() {
    this.input.invalidate();
    this.list.invalidate();
  }
  render(width) {
    const lines = [];
    lines.push(this.theme.fg("accent", this.prompt));
    lines.push(
      this.theme.fg("dim", "filter: ") + (this.input.getValue() || this.theme.fg("dim", "(type to filter)"))
    );
    lines.push(...this.list.render(width));
    return lines;
  }
  handleInput(data) {
    const before = this.input.getValue();
    this.input.handleInput(data);
    const after = this.input.getValue();
    if (before !== after) {
      this.list.setFilter(after);
      this.tui.requestRender();
      return;
    }
    this.list.handleInput(data);
    this.tui.requestRender();
  }
};
async function pickDigestModel(ctx, options) {
  if (!ctx.ui?.custom) return void 0;
  const models = ctx.modelRegistry.getAvailable();
  const items = models.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: m.id,
    description: m.provider
  }));
  return ctx.ui.custom(
    (tui, theme, _kb, done) => new ModelPickerComponent(
      tui,
      theme,
      done,
      items,
      options.prompt,
      options.currentModel
    ),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: 72, maxHeight: "70%" }
    }
  );
}

// src/digest/builder.ts
import { Value as Value2 } from "typebox/value";
function emptyBuilderState() {
  return {
    lastDigest: null,
    convTokensAtLastWrite: 0,
    lastWrittenMessageIndex: 0,
    lastWrittenSummaryIndex: 0,
    lastWriteTime: null,
    pendingCall: false,
    dirty: false
  };
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function extractDelta(view, anchor) {
  return {
    messages: view.messages.slice(anchor),
    compactionSummaries: view.compactionSummaries
  };
}
function serializeView(view) {
  const parts = [
    ...view.compactionSummaries,
    ...view.messages.map((m) => `${m.role}: ${m.text}`)
  ];
  return parts.join("\n\n");
}
function capInput(view, model, includesPrevDigest) {
  const envelope = includesPrevDigest ? 4e3 : 2e3;
  const contextChars = (model.contextWindow ?? 25e3) * 4;
  const maxTokChars = (model.maxTokens ?? 4096) * 4;
  const cap = Math.min(1e5, contextChars - maxTokChars - envelope);
  const serialized = serializeView(view);
  if (serialized.length <= cap) return view;
  const summaryText = view.compactionSummaries.join("\n\n");
  const firstMsg = view.messages[0] ?? null;
  const firstMsgText = firstMsg ? `${firstMsg.role}: ${firstMsg.text}` : "";
  const overhead = summaryText.length + firstMsgText.length + 100;
  let remaining = Math.max(0, cap - overhead);
  const tail = [];
  for (let i = view.messages.length - 1; i >= 1; i--) {
    const msg = view.messages[i];
    const len = `${msg.role}: ${msg.text}

`.length;
    if (len > remaining) break;
    remaining -= len;
    tail.unshift(msg);
  }
  const messages = [];
  if (firstMsg) messages.push(firstMsg);
  messages.push(...tail);
  return { messages, compactionSummaries: view.compactionSummaries };
}
function serializeForPrompt(view) {
  const parts = [];
  for (const s of view.compactionSummaries) {
    parts.push(`[compaction summary]: ${s}`);
  }
  for (const m of view.messages) {
    parts.push(`${m.role === "user" ? "User" : "Assistant"}: ${m.text}`);
  }
  return parts.join("\n\n");
}
var SCHEMA_INSTRUCTIONS = `Produce a JSON object with EXACTLY these fields (other field names will be rejected):
  - body (string, \u226550 chars): 200\u2013400 words of plain prose describing what was worked on
  - headline (string, 1\u201380 chars): a stable title describing the session as a whole \u2014 the through-line or overarching goal, not the latest activity. Treat the headline as sticky: do not rewrite it to track tactical shifts in the work; only change it when the session's overall topic has fundamentally pivoted.
  - topics (array of strings, max 5, each \u226432 chars): main subject tags
  - outcome (optional string, \u2264200 chars): one sentence of what was accomplished

Output ONLY the JSON object. No preamble, no markdown fences, no commentary. Field names MUST be exactly "body", "headline", "topics", "outcome" \u2014 not "summary", "explanation", "title", "topic", "tags", or anything else.`;
var SYSTEM_PROMPT_BASE = `You are a session digest writer. ${SCHEMA_INSTRUCTIONS}`;
var SYSTEM_PROMPT_STRICT = `${SYSTEM_PROMPT_BASE}

IMPORTANT: Your previous response failed validation. Common mistakes: wrong field names, headline >80 chars, body <50 chars, topics not an array, markdown code fences around the JSON. Output the raw JSON object directly.`;
function buildPrompt(state, view, threshold, model) {
  const convTokens = estimateTokens(serializeView(view));
  const tokensSinceLastWrite = convTokens - state.convTokensAtLastWrite;
  const hasLastDigest = state.lastDigest != null;
  const mode = !hasLastDigest || tokensSinceLastWrite >= threshold ? "full" : "incremental";
  let userMessage;
  if (mode === "incremental") {
    const delta = extractDelta(view, state.lastWrittenMessageIndex);
    const capped = capInput(
      delta,
      model,
      /* includesPrevDigest */
      true
    );
    const deltaText = serializeForPrompt(capped);
    userMessage = `Previous headline: ${JSON.stringify(state.lastDigest.headline)}
Previous digest:
${state.lastDigest.body}

New messages since last digest:
${deltaText}

Keep the previous headline verbatim unless the session's overall topic has fundamentally pivoted; the body should track new activity but the headline should not. Update the digest if anything material changed. Otherwise repeat the previous digest verbatim. Call submit_digest now.`;
  } else {
    const capped = capInput(
      view,
      model,
      /* includesPrevDigest */
      false
    );
    const convText = serializeForPrompt(capped);
    userMessage = `Here is the full conversation to digest:

${convText}

Call submit_digest now.`;
  }
  return { mode, systemPrompt: SYSTEM_PROMPT_BASE, userMessage };
}
async function generateDigest(model, view, state, opts = {}) {
  const threshold = opts.resummarizeTokenThreshold ?? 1e4;
  const completeFn = opts.completeFn ?? opts._completeFn;
  if (!completeFn) {
    throw new Error("generateDigest requires a host-bound completeFn");
  }
  const { systemPrompt, userMessage } = buildPrompt(state, view, threshold, model);
  const makeCtx = (sysPrompt, msg) => ({
    systemPrompt: sysPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: msg }],
        timestamp: Date.now()
      }
    ],
    tools: [submitDigestTool]
  });
  function extractDigestArgs(response) {
    const toolCall = response.content.find(
      (c) => c.type === "toolCall" && c.name === "submit_digest"
    );
    return toolCall?.arguments ?? null;
  }
  const attemptCall = async (sysPrompt, msg) => {
    let response;
    try {
      response = await completeFn(model, makeCtx(sysPrompt, msg), {
        signal: opts.signal
      });
    } catch (err) {
      const msg2 = err instanceof Error ? err.message : String(err);
      log.warn({ comp: "digest", provider: model.provider, model: model.id, err: msg2 }, "digest complete() threw");
      return null;
    }
    if (response.stopReason === "error") {
      const errorMessage = response.errorMessage ?? "unknown error";
      log.warn(
        { comp: "digest", provider: model.provider, model: model.id, errorMessage },
        "digest completion returned an error response"
      );
      return null;
    }
    const rawArgs = extractDigestArgs(response);
    if (rawArgs === null) {
      log.warn({ comp: "digest" }, "extractDigestArgs returned null");
      if (process.env.PI_SESSION_SEARCH_DEBUG_DIGEST) {
        log.debug(
          { comp: "digest", responseSlice: JSON.stringify(response, null, 2).slice(0, 2e3) },
          "extractDigestArgs response dump"
        );
      }
      return null;
    }
    if (process.env.PI_SESSION_SEARCH_DEBUG_DIGEST) {
      log.debug({ comp: "digest", rawArgs: JSON.stringify(rawArgs).slice(0, 500) }, "rawArgs");
    }
    if (!Value2.Check(DigestArgs, rawArgs)) {
      return null;
    }
    const args = rawArgs;
    const digest = {
      schemaVersion: 1,
      body: args.body,
      headline: args.headline,
      topics: args.topics,
      ...args.outcome !== void 0 ? { outcome: args.outcome } : {},
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      modelId: `${model.provider}/${model.id}`,
      inputTokenCount: estimateTokens(serializeView(view)),
      cost: response.usage?.cost?.total ?? 0
    };
    return { digest, response };
  };
  const first = await attemptCall(systemPrompt, userMessage);
  if (first) {
    return { digest: first.digest, anchor: view.messages.length };
  }
  const second = await attemptCall(SYSTEM_PROMPT_STRICT, userMessage);
  if (second) {
    return { digest: second.digest, anchor: view.messages.length };
  }
  return null;
}

// src/digest/completion.ts
async function resolveHostCompleteFn(registry, model) {
  if (!registry.getProvider(model.provider)) {
    throw new Error(`No host provider available for: ${model.provider}`);
  }
  return (requestModel, context, options) => registry.stream(requestModel, context, options).result();
}

// src/digest/title.ts
var MAX_TITLE_CHARS = 80;
var MAX_PROMPT_CHARS = 4e3;
var SYSTEM_PROMPT = "You name coding-agent sessions. Reply with only a short title (at most 80 characters) that summarizes the user's request. No quotes, no trailing punctuation, no preamble.";
function cleanTitle(raw) {
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  const unquote = (s) => s.replace(/^["'`*]+|["'`*]+$/g, "").trim();
  let title = unquote(unquote(line).replace(/^(session )?title\s*:\s*/i, "")).replace(/[.\s]+$/, "").trim();
  if (title.length === 0) return null;
  if (title.length > MAX_TITLE_CHARS) title = `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}\u2026`;
  return title;
}
async function generateTitle(model, prompt, completeFn, opts = {}) {
  const text = prompt.trim();
  if (text.length === 0) return null;
  const clipped = text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}\u2026` : text;
  let response;
  try {
    response = await completeFn(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: `Title this request:

${clipped}` }],
            timestamp: Date.now()
          }
        ]
      },
      { signal: opts.signal }
    );
  } catch (err) {
    const emsg = err instanceof Error ? err.message : String(err);
    log.warn({ comp: "digest", provider: model.provider, model: model.id, err: emsg }, "initial title: completion threw");
    return null;
  }
  if (response.stopReason === "error") {
    log.warn(
      { comp: "digest", provider: model.provider, model: model.id, errorMessage: response.errorMessage },
      "initial title: completion returned an error response"
    );
    return null;
  }
  const raw = response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return cleanTitle(raw);
}

// src/digest/conversation-view.ts
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b != null && b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ");
}
function liveConversationView(sm) {
  const entries = sm.getBranch();
  const messages = [];
  const compactionSummaries = [];
  for (const entry of entries) {
    if (entry.type === "compaction") {
      const summary = entry["summary"];
      if (typeof summary === "string" && summary) {
        compactionSummaries.push(summary);
      }
      continue;
    }
    if (entry.type === "message") {
      const msg = entry["message"];
      if (!msg) continue;
      const { role, content } = msg;
      if (role === "user") {
        const text = extractText(content);
        if (text.trim()) messages.push({ role: "user", text });
      } else if (role === "assistant") {
        const text = extractText(content);
        if (text.trim()) messages.push({ role: "assistant", text });
      }
    }
  }
  return { messages, compactionSummaries };
}
function parsedConversationView(parsed) {
  const messages = parsed.userMessages.map((text) => ({
    role: "user",
    text
  }));
  if (parsed.assistantText?.trim()) {
    messages.push({ role: "assistant", text: parsed.assistantText });
  }
  return {
    messages,
    compactionSummaries: parsed.compactionSummaries ?? []
  };
}

// src/digest/lifecycle.ts
function installDigestLifecycle(pi, deps) {
  let disposed = false;
  let sessionId = null;
  let currentModel = void 0;
  let state = emptyBuilderState();
  let lastError = null;
  let debounceTimer = null;
  let currentAbort = null;
  let followUpTimer = null;
  let currentCtx = null;
  let titleAttempted = false;
  let titleAbort = null;
  let config = deps.configLoader();
  function clearDebounceTimer() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }
  function abortTitle() {
    if (titleAbort) {
      titleAbort.abort();
      titleAbort = null;
    }
  }
  async function fireInitialTitle(prompt, ctx) {
    const generateTitle2 = deps.builder.generateTitle;
    if (!generateTitle2 || titleAttempted) return;
    titleAttempted = true;
    if (disposed || !currentModel || !sessionId) return;
    if (deps.isCurrentGeneration && !deps.isCurrentGeneration()) return;
    if (state.lastDigest || pi.getSessionName?.()) return;
    const id = sessionId;
    const model = currentModel;
    const ac = new AbortController();
    titleAbort = ac;
    let title = null;
    try {
      const completeFn = await resolveHostCompleteFn(
        ctx.modelRegistry,
        model
      );
      title = await generateTitle2(model, prompt, completeFn, { signal: ac.signal });
    } catch (err) {
      const emsg = err instanceof Error ? err.message : String(err);
      log.warn({ comp: "digest", provider: model.provider, model: model.id, err: emsg }, "initial title failed");
    } finally {
      if (titleAbort === ac) titleAbort = null;
    }
    if (!title || ac.signal.aborted || disposed || sessionId !== id) return;
    if (deps.isCurrentGeneration && !deps.isCurrentGeneration()) return;
    if (state.lastDigest || pi.getSessionName?.()) return;
    pi.setSessionName(title);
  }
  function clearFollowUpTimer() {
    if (followUpTimer !== null) {
      clearTimeout(followUpTimer);
      followUpTimer = null;
    }
  }
  async function fireDigest() {
    if (disposed) return;
    if (deps.isCurrentGeneration && !deps.isCurrentGeneration()) return;
    if (!currentModel || !sessionId || !currentCtx) return;
    if (state.pendingCall) {
      state.dirty = true;
      return;
    }
    state.pendingCall = true;
    state.dirty = false;
    const ac = new AbortController();
    currentAbort = ac;
    const ctx = currentCtx;
    const id = sessionId;
    const model = currentModel;
    const view = liveConversationView(ctx.sessionManager);
    let result = null;
    try {
      const completeFn = await resolveHostCompleteFn(
        ctx.modelRegistry,
        model
      );
      result = await deps.builder.generateDigest(model, view, state, {
        signal: ac.signal,
        resummarizeTokenThreshold: config.resummarizeTokenThreshold,
        completeFn
      });
    } catch (err) {
      const emsg = err instanceof Error ? err.message : String(err);
      log.warn(
        { comp: "digest", provider: model.provider, model: model.id, err: emsg },
        "live digest: host completion failed"
      );
      result = null;
    } finally {
      if (currentAbort === ac) currentAbort = null;
    }
    state.pendingCall = false;
    if (result !== null) {
      const { digest, anchor } = result;
      if (deps.isCurrentGeneration && !deps.isCurrentGeneration()) {
        return;
      }
      deps.storage.saveDigest(id, digest);
      pi.setSessionName(digest.headline);
      if (process.env.PI_SESSION_SEARCH_DEBUG_DIGEST) {
        const prevHeadline = state.lastDigest?.headline ?? null;
        if (prevHeadline !== null) {
          log.debug(
            {
              comp: "digest",
              sessionId: id,
              prevHeadline,
              newHeadline: digest.headline,
              changed: prevHeadline !== digest.headline
            },
            "headline diff on incremental write"
          );
        }
      }
      state.lastDigest = digest;
      state.lastWriteTime = Date.now();
      state.convTokensAtLastWrite = digest.inputTokenCount;
      state.lastWrittenMessageIndex = anchor;
      state.lastWrittenSummaryIndex = view.compactionSummaries.length;
      lastError = null;
      deps.storage.saveBuilderState(id, {
        convTokensAtLastWrite: state.convTokensAtLastWrite,
        lastWrittenMessageIndex: state.lastWrittenMessageIndex,
        lastWrittenSummaryIndex: state.lastWrittenSummaryIndex
      });
      deps.costTracker.record(digest);
      deps.indexAddDigested(id, digest, { batched: false });
    } else {
      lastError = "digest generation failed (no tool call or validation error after retry)";
    }
    if (!disposed && state.dirty && (!deps.isCurrentGeneration || deps.isCurrentGeneration())) {
      state.dirty = false;
      clearFollowUpTimer();
      followUpTimer = setTimeout(() => {
        followUpTimer = null;
        void fireDigest();
      }, 250);
    }
  }
  function triggerDebounced() {
    if (disposed || !currentModel) return;
    if (state.pendingCall) {
      state.dirty = true;
      return;
    }
    const debounceMs = config.debounceSeconds * 1e3;
    const now = Date.now();
    const lastWrite = state.lastWriteTime ?? 0;
    const elapsed = now - lastWrite;
    if (elapsed >= debounceMs) {
      void fireDigest();
    } else {
      clearDebounceTimer();
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void fireDigest();
      }, debounceMs - elapsed);
    }
  }
  function triggerImmediate() {
    if (disposed || !currentModel) return;
    clearDebounceTimer();
    if (state.pendingCall) {
      state.dirty = true;
      return;
    }
    void fireDigest();
  }
  pi.on("session_start", (_event, ctx) => {
    if (disposed) return;
    deps.onSessionStartCaptureGeneration?.();
    currentCtx = ctx;
    config = deps.configLoader();
    sessionId = ctx.sessionManager.getSessionId();
    const savedDigest = deps.storage.loadDigest(sessionId);
    const savedBuilderState = deps.storage.loadBuilderState(sessionId);
    state = emptyBuilderState();
    state.lastDigest = savedDigest;
    abortTitle();
    titleAttempted = false;
    if (savedBuilderState) {
      state.convTokensAtLastWrite = savedBuilderState.convTokensAtLastWrite;
      state.lastWrittenMessageIndex = savedBuilderState.lastWrittenMessageIndex;
      state.lastWrittenSummaryIndex = savedBuilderState.lastWrittenSummaryIndex;
    }
    currentModel = !deps.isCurrentGeneration || deps.isCurrentGeneration() ? deps.modelResolver(config, ctx.modelRegistry.getAvailable()) : void 0;
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (disposed) return;
    void fireInitialTitle(event.prompt, ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    if (disposed) return;
    currentCtx = ctx;
    triggerDebounced();
  });
  pi.on("session_compact", (_event, ctx) => {
    if (disposed) return;
    currentCtx = ctx;
    triggerImmediate();
  });
  pi.on("session_shutdown", (_event, _ctx) => {
    if (disposed) return;
    if (currentAbort) {
      currentAbort.abort();
      currentAbort = null;
    }
    abortTitle();
    clearDebounceTimer();
    clearFollowUpTimer();
    state.dirty = false;
    state.pendingCall = false;
  });
  function deactivate() {
    if (currentAbort) {
      currentAbort.abort();
      currentAbort = null;
    }
    abortTitle();
    clearDebounceTimer();
    clearFollowUpTimer();
    currentModel = void 0;
    state.pendingCall = false;
    state.dirty = false;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    deactivate();
  }
  async function triggerNow(opts) {
    if (disposed) return null;
    if (state.pendingCall) {
      currentAbort?.abort();
      currentAbort = null;
      state.pendingCall = false;
    }
    if (opts?.forceFull) {
      state.convTokensAtLastWrite = 0;
      state.lastDigest = null;
    }
    await fireDigest();
    return sessionId ? deps.storage.loadDigest(sessionId) : null;
  }
  return {
    deactivate,
    dispose,
    triggerNow,
    // Expose for testing
    get _lastError() {
      return lastError;
    }
  };
}

// src/digest/cost-tracker.ts
function emptyRollup() {
  return {
    calls: 0,
    tokensIn: 0,
    tokensOut: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}
function record(rollup, response) {
  const u = response.usage;
  return {
    calls: rollup.calls + 1,
    tokensIn: rollup.tokensIn + u.input,
    tokensOut: rollup.tokensOut + u.output,
    cost: {
      input: rollup.cost.input + u.cost.input,
      output: rollup.cost.output + u.cost.output,
      cacheRead: rollup.cost.cacheRead + u.cost.cacheRead,
      cacheWrite: rollup.cost.cacheWrite + u.cost.cacheWrite,
      total: rollup.cost.total + u.cost.total
    }
  };
}
function format(rollup, modelName) {
  const total = rollup.cost.total.toFixed(4);
  return `[session:cost] this process \u2014 model: ${modelName} | calls: ${rollup.calls} | tokens in: ${rollup.tokensIn} / out: ${rollup.tokensOut} | cost: $${total}`;
}

// src/digest/backfill.ts
import { statSync as statSync4 } from "node:fs";
async function runBackfill(deps) {
  const {
    files,
    activeSessionId,
    index,
    resolvedModel,
    completeFn,
    digestConfig,
    regenMode,
    setStatus,
    notify
  } = deps;
  const targets = [];
  for (const { file, archived } of files) {
    const id = readSessionId(file);
    if (!id) continue;
    if (id === activeSessionId) continue;
    if (!regenMode && loadDigest(id) !== null) continue;
    targets.push({ file, archived, id });
  }
  const total = targets.length;
  if (total === 0) {
    notify("Backfill: no sessions to process.", "info");
    return;
  }
  setStatus(`Backfilling digests: 0/${total}`);
  if (index.setBackfillInProgress) await index.setBackfillInProgress(true);
  else index.backfillInProgress = true;
  let done = 0;
  let failed = 0;
  let flushCount = 0;
  try {
    for (const { file, archived, id } of targets) {
      try {
        const parsed = parseSession(file, archived);
        if (!parsed) {
          failed++;
          continue;
        }
        const view = parsedConversationView(parsed);
        const state = emptyBuilderState();
        const result = await generateDigest(resolvedModel, view, state, {
          resummarizeTokenThreshold: digestConfig.resummarizeTokenThreshold,
          completeFn
        });
        if (!result) {
          failed++;
          log.warn({ comp: "backfill", sessionId: id }, "backfill: no digest returned");
          continue;
        }
        if (!regenMode && loadDigest(id) !== null) {
          continue;
        }
        const { digest } = result;
        saveDigest(id, digest);
        await index.addDigested(id, parsed, digest, { batched: true });
        done++;
        flushCount++;
        if (flushCount >= 25) {
          await index.flush();
          flushCount = 0;
        }
        setStatus(`Backfilling digests: ${done}/${total}`);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ comp: "backfill", sessionId: id, err: msg }, "backfill error");
      }
    }
    notify(
      `Backfill complete: ${done}/${total} digested${failed > 0 ? `, ${failed} failed` : ""}.`,
      "success"
    );
  } finally {
    await index.flush();
    if (index.setBackfillInProgress) await index.setBackfillInProgress(false);
    else index.backfillInProgress = false;
    setStatus(void 0);
  }
}
function runBackfillDryRun(deps) {
  const { files, activeSessionId, resolvedModel, embedderPricePerInputToken, notify } = deps;
  let inputTokenEstimate = 0;
  let sessionCount = 0;
  for (const { file } of files) {
    const id = readSessionId(file);
    if (!id) continue;
    if (id === activeSessionId) continue;
    if (loadDigest(id) !== null) continue;
    try {
      const { size } = statSync4(file);
      inputTokenEstimate += size / 4;
      sessionCount++;
    } catch {
    }
  }
  if (sessionCount === 0) {
    notify("Dry run: no un-digested sessions found.", "info");
    return;
  }
  const inputRate = (resolvedModel.cost?.input ?? 0) / 1e6;
  const outputRate = (resolvedModel.cost?.output ?? 0) / 1e6;
  const inputCostUsd = inputTokenEstimate * inputRate;
  const outputCostUsd = sessionCount * 700 * outputRate;
  const lines = [
    `Backfill dry run \u2014 ${sessionCount} un-digested session(s)`,
    `  Input tokens est.: ${Math.round(inputTokenEstimate).toLocaleString()}`,
    `  Input cost:        $${inputCostUsd.toFixed(4)}`,
    `  Output cost:       $${outputCostUsd.toFixed(4)} (${sessionCount} \xD7 700 tokens)`
  ];
  if (embedderPricePerInputToken !== void 0) {
    const embedCostUsd = sessionCount * 700 * embedderPricePerInputToken;
    const total = inputCostUsd + outputCostUsd + embedCostUsd;
    lines.push(`  Embed cost:        $${embedCostUsd.toFixed(4)}`);
    lines.push(`  Total est.:        $${total.toFixed(4)}`);
  } else {
    const total = inputCostUsd + outputCostUsd;
    lines.push(
      `  Embed cost:        not estimated (configure embedder.pricePerInputToken to include)`
    );
    lines.push(`  Total est.:        $${total.toFixed(4)} (excl. embedding)`);
  }
  lines.push(`  Note: accuracy may vary \xB130\u201350% depending on session size distribution.`);
  notify(lines.join("\n"), "info");
}

// src/reader.ts
import { readFileSync as readFileSync6 } from "node:fs";
function readSessionConversation(file, options) {
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? 50;
  const includeTools = options?.includeTools ?? false;
  let raw;
  try {
    raw = readFileSync6(file, "utf8");
  } catch (err) {
    return `Error reading session: ${err.message}`;
  }
  const lines = raw.trim().split("\n");
  const entries = [];
  let header = null;
  for (const line of lines) {
    const cleaned = line.replace(/^\uFEFF/, "").trim();
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
  const conversationEntries = entries.filter((e) => {
    if (e.type === "message") {
      const role = e.message?.role;
      if (role === "user") return true;
      if (role === "assistant") return true;
      if (role === "toolResult" && includeTools) return true;
      return false;
    }
    if (e.type === "compaction") return true;
    if (e.type === "branch_summary") return true;
    if (e.type === "session_info") return true;
    if (e.type === "model_change") return true;
    return false;
  });
  const total = conversationEntries.length;
  const page = conversationEntries.slice(offset, offset + limit);
  const output = [];
  if (header) {
    output.push(
      `Session: ${header.id}
Started: ${header.timestamp}
CWD: ${header.cwd}`
    );
    output.push(`Total entries: ${total} (showing ${offset + 1}-${Math.min(offset + limit, total)})`);
    output.push("---");
  }
  for (const entry of page) {
    const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "";
    switch (entry.type) {
      case "message": {
        const msg = entry.message;
        if (msg.role === "user") {
          const text = extractText2(msg.content);
          output.push(`
**User** (${ts}):
${text}`);
        } else if (msg.role === "assistant") {
          const text = extractAssistantText(msg.content);
          const model = msg.model ? ` [${msg.provider}/${msg.model}]` : "";
          output.push(`
**Assistant**${model} (${ts}):
${text}`);
          if (Array.isArray(msg.content)) {
            const calls = msg.content.filter(
              (b) => b.type === "toolCall"
            );
            if (calls.length > 0) {
              const callList = calls.map(
                (c) => `  \u2192 ${c.name}(${summarizeArgs(c.arguments)})`
              ).join("\n");
              output.push(callList);
            }
          }
        } else if (msg.role === "toolResult" && includeTools) {
          const text = extractText2(msg.content);
          const truncated = text.length > 500 ? text.slice(0, 500) + "\u2026" : text;
          const err = msg.isError ? " \u274C" : "";
          output.push(
            `
  **${msg.toolName}** result${err} (${ts}):
  ${truncated}`
          );
        }
        break;
      }
      case "compaction":
        output.push(
          `
--- Compaction (${ts}) ---
${entry.summary?.slice(0, 1e3) ?? "(no summary)"}`
        );
        break;
      case "branch_summary":
        output.push(
          `
--- Branch Summary (${ts}) ---
${entry.summary?.slice(0, 500) ?? "(no summary)"}`
        );
        break;
      case "model_change":
        output.push(
          `
*Model changed to ${entry.provider}/${entry.modelId}* (${ts})`
        );
        break;
      case "session_info":
        output.push(`
*Session renamed to: ${entry.name}* (${ts})`);
        break;
    }
  }
  if (offset + limit < total) {
    output.push(
      `
--- ${total - offset - limit} more entries. Use offset=${offset + limit} to continue. ---`
    );
  }
  return output.join("\n");
}
function extractText2(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  return "";
}
function extractAssistantText(content) {
  if (!Array.isArray(content)) return String(content ?? "");
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
function summarizeArgs(args) {
  if (!args) return "";
  const parts = [];
  for (const [key, val] of Object.entries(args)) {
    if (typeof val === "string") {
      parts.push(`${key}="${val.length > 60 ? val.slice(0, 60) + "\u2026" : val}"`);
    } else {
      parts.push(`${key}=${JSON.stringify(val)?.slice(0, 40)}`);
    }
  }
  return parts.join(", ");
}

// src/search/overlay.ts
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
function truncateToLines(text, width, maxLines) {
  const out = [];
  for (const raw of text.split("\n")) {
    if (out.length >= maxLines) break;
    let remaining = raw;
    while (remaining.length > 0 && out.length < maxLines) {
      out.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
  }
  return out;
}
function padEnd(str, len) {
  if (str.length >= len) return str.slice(0, len);
  return str + " ".repeat(len - str.length);
}
function splitLine(left, right, width, styleLeft = (s) => s) {
  const rightLen = right.length;
  const leftMax = width - rightLen - 1;
  if (leftMax <= 0) return styleLeft("") + " " + right;
  const leftPlain = padEnd(left.slice(0, leftMax), leftMax);
  return styleLeft(leftPlain) + " " + right;
}
function renderCard(result, digest, selected, width, theme) {
  const marker = selected ? "\u25B6 " : "  ";
  const innerWidth = Math.max(width - marker.length, 10);
  const lines = [];
  const headline = digest?.headline ?? result.session.name ?? result.session.id.slice(0, 40);
  const topics = digest ? digest.topics.join(", ") : "";
  const date = formatRelativeDate(result.session.endedAt);
  const body = digest?.body ?? result.summary ?? "";
  const filePath = result.session.file;
  lines.push(
    marker + splitLine(headline, date, innerWidth, (s) => theme.bold(s))
  );
  if (topics) {
    lines.push(marker + theme.fg("dim", topics.slice(0, innerWidth)));
  }
  const bodyLines = truncateToLines(body, innerWidth, 3);
  for (const bl of bodyLines) {
    lines.push(marker + theme.fg("dim", bl));
  }
  lines.push(marker + theme.fg("dim", filePath.slice(-innerWidth)));
  return lines;
}
var SEARCH_DEBOUNCE_MS = 150;
var MAX_VISIBLE_CARDS = 5;
var FindSessionOverlayComponent = class {
  focused = false;
  wantsKeyRelease = false;
  query;
  results = [];
  selectedIndex = 0;
  scrollOffset = 0;
  searching = false;
  tui;
  theme;
  done;
  index;
  debounceMs;
  searchTimeout = null;
  constructor(tui, theme, done, index, initialQuery, debounceMs = SEARCH_DEBOUNCE_MS) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.index = index;
    this.query = initialQuery;
    this.debounceMs = debounceMs;
    if (initialQuery.trim()) {
      Promise.resolve().then(() => this.runSearch());
    }
  }
  invalidate() {
  }
  render(width) {
    const frameOverhead = 4;
    const innerWidth = Math.max(width - frameOverhead, 10);
    const horizontalRun = innerWidth + 2;
    const border = (s) => this.theme.fg("border", s);
    const top = border("\u250C" + "\u2500".repeat(horizontalRun) + "\u2510");
    const sep = border("\u251C" + "\u2500".repeat(horizontalRun) + "\u2524");
    const bottom = border("\u2514" + "\u2500".repeat(horizontalRun) + "\u2518");
    const side = border("\u2502");
    const wrap = (line) => {
      const w = visibleWidth(line);
      let body;
      if (w > innerWidth) {
        body = truncateToWidth(line, innerWidth, "\u2026", false);
        const bw = visibleWidth(body);
        if (bw < innerWidth) body = body + " ".repeat(innerWidth - bw);
      } else {
        body = line + " ".repeat(innerWidth - w);
      }
      return `${side} ${body} ${side}`;
    };
    const content = [];
    const queryPrefix = "> ";
    const queryDisplay = this.query + (this.focused ? CURSOR_MARKER : "");
    content.push(queryPrefix + queryDisplay);
    const SEP_MARKER = "\0__SEP__\0";
    content.push(SEP_MARKER);
    if (this.searching) {
      content.push("  Searching\u2026");
    } else if (this.results.length === 0) {
      if (this.query.trim()) {
        content.push("  No sessions match this query");
      } else {
        content.push("  Type a query to search sessions");
      }
    } else {
      const total = this.results.length;
      const visible = Math.min(MAX_VISIBLE_CARDS, total);
      if (this.selectedIndex < this.scrollOffset) {
        this.scrollOffset = this.selectedIndex;
      } else if (this.selectedIndex >= this.scrollOffset + visible) {
        this.scrollOffset = this.selectedIndex - visible + 1;
      }
      this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, total - visible));
      const start = this.scrollOffset;
      const end = Math.min(start + visible, total);
      if (start > 0) {
        content.push(this.theme.fg("dim", `  \u2191 ${start} more above`));
      }
      for (let i = start; i < end; i++) {
        const result = this.results[i];
        const digest = this.digests.get(result.session.id) ?? null;
        const selected = i === this.selectedIndex;
        const cardLines = renderCard(result, digest, selected, innerWidth, this.theme);
        content.push(...cardLines);
        if (i < end - 1) {
          content.push("");
        }
      }
      if (end < total) {
        content.push(this.theme.fg("dim", `  \u2193 ${total - end} more below`));
      }
    }
    const lines = [];
    lines.push(top);
    for (const c of content) {
      if (c === SEP_MARKER) {
        lines.push(sep);
      } else {
        lines.push(wrap(c));
      }
    }
    lines.push(bottom);
    return lines;
  }
  handleInput(data) {
    if (matchesKey(data, "up")) {
      this.moveUp();
      this.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveDown();
      this.requestRender();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.confirm();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.done(void 0);
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.query = this.query.slice(0, -1);
      this.scheduleSearch();
      this.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.query = "";
      this.scheduleSearch();
      this.requestRender();
      return;
    }
    if (data.length === 1 && data >= " ") {
      this.query += data;
      this.scheduleSearch();
      this.requestRender();
    }
  }
  // ── Private helpers ────────────────────────────────────────────────────────
  requestRender() {
    this.tui.requestRender?.();
  }
  moveUp() {
    if (this.selectedIndex > 0) this.selectedIndex--;
  }
  moveDown() {
    if (this.selectedIndex < this.results.length - 1) this.selectedIndex++;
  }
  resetScroll() {
    this.scrollOffset = 0;
  }
  confirm() {
    if (this.results.length === 0) return;
    const selected = this.results[this.selectedIndex];
    this.done(selected.session.file);
  }
  scheduleSearch() {
    if (this.searchTimeout !== null) clearTimeout(this.searchTimeout);
    this.searchTimeout = setTimeout(() => this.runSearch(), this.debounceMs);
  }
  digests = /* @__PURE__ */ new Map();
  async runSearch() {
    this.searchTimeout = null;
    const q = this.query.trim();
    if (!q) {
      this.results = [];
      this.selectedIndex = 0;
      this.searching = false;
      this.requestRender();
      return;
    }
    this.searching = true;
    this.requestRender();
    try {
      this.results = await this.index.search(q, 25);
      this.digests = new Map(await Promise.all(this.results.map(async (result) => [result.session.id, await this.index.getDigest(result.session.id)])));
      this.selectedIndex = 0;
      this.resetScroll();
    } catch {
      this.results = [];
      this.selectedIndex = 0;
      this.resetScroll();
    }
    this.searching = false;
    this.requestRender();
  }
};
function registerFindSessionCommand(pi, deps) {
  pi.registerCommand("find-session", {
    description: "Search sessions by content and switch to a matching session",
    handler: async (args, ctx) => {
      const verdict = deps.getCurrentVerdict?.();
      if (verdict?.kind === "misconfigured") {
        ctx.ui.notify(verdict.notifyMessage, "error");
        return;
      }
      const initialQuery = args.trim();
      const sessionPath = await ctx.ui.custom(
        (tui, theme, _keybindings, done) => {
          const component = new FindSessionOverlayComponent(
            tui,
            theme,
            done,
            deps.index,
            initialQuery
          );
          return component;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "80%",
            maxHeight: "70%",
            anchor: "top-center",
            offsetY: 2
          }
        }
      );
      if (sessionPath) {
        await ctx.switchSession(sessionPath);
      }
    }
  });
}

// src/index.ts
var INDEX_WORKER_FILE = fileURLToPath(new URL("../dist/index-worker.js", import.meta.url));
var useIndexWorker = true;
var indexWorkerFile = INDEX_WORKER_FILE;
function _setIndexWorkerEnabled(enabled, file = INDEX_WORKER_FILE) {
  useIndexWorker = enabled;
  indexWorkerFile = file;
}
function resolveSyncAction(rawInterval) {
  if (rawInterval === void 0)
    return { disabled: false, intervalMs: DEFAULT_SYNC_INTERVAL_MS };
  if (rawInterval === -1) return { disabled: true };
  if (rawInterval <= 0) {
    return { disabled: false, intervalMs: DEFAULT_SYNC_INTERVAL_MS, fallback: true };
  }
  return { disabled: false, intervalMs: rawInterval };
}
function resolveInitialSyncAction(rawDelay) {
  if (rawDelay === void 0)
    return { skip: false, delayMs: DEFAULT_INITIAL_DELAY_MS };
  if (rawDelay === -1) return { skip: true };
  if (rawDelay < 0) {
    return { skip: false, delayMs: DEFAULT_INITIAL_DELAY_MS, fallback: true };
  }
  return { skip: false, delayMs: rawDelay };
}
function isChildProcess() {
  const depth = Number(process.env.PI_SUBAGENT_DEPTH);
  if (depth > 0) return true;
  if (!process.stdin.isTTY) return true;
  return false;
}
function index_default(pi) {
  log.info({ comp: "extension", logPath: getLogPath() }, "pi-session-search loaded");
  let sessionIndex = null;
  let indexState = "off";
  let indexError = "";
  const pendingTimers = /* @__PURE__ */ new Set();
  function scheduleTimer(fn, ms) {
    const generation = bootGeneration;
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      if (generation === bootGeneration) fn();
    }, ms);
    pendingTimers.add(timer);
    return timer;
  }
  function warmingNote() {
    return indexState === "warming" ? "\n\nNote: session index warming (initial sync still running), so results may be incomplete." : "";
  }
  function unavailable() {
    return indexState === "failed" ? `Session index unavailable: ${indexError}` : "Session index warming (loading the saved index). Try again in a moment.";
  }
  let currentConfig = null;
  let currentVerdict = null;
  let bootGeneration = 0;
  let lifecycleGen = 0;
  let lifecycleHandle = null;
  let currentDigestConfig = loadDigestConfig(process.cwd());
  let currentRollup = emptyRollup();
  let lastCwd = process.cwd();
  let syncTimer = null;
  const SYNC_INTERVAL_MS = 5 * 60 * 1e3;
  const DIGEST_DISABLED_STATUS = "Digest disabled: run /session:summarizer";
  const DIGEST_DISABLED_MESSAGE = "Digest disabled: run /session:summarizer to configure a model. FTS session search remains available.";
  const lifecycleCostTracker = {
    record(digest) {
      currentRollup = {
        calls: currentRollup.calls + 1,
        tokensIn: currentRollup.tokensIn + digest.inputTokenCount,
        tokensOut: currentRollup.tokensOut,
        cost: {
          ...currentRollup.cost,
          total: currentRollup.cost.total + (digest.cost ?? 0)
        }
      };
    }
  };
  function indexAddDigested(sessionId, digest) {
    if (!sessionIndex || currentVerdict?.kind !== "digest-hybrid") return;
    void sessionIndex.addDigest(sessionId, digest).catch((err) => log.error({ comp: "indexAddDigested", sessionId, err: String(err?.message ?? err) }, "addDigested failed"));
  }
  pi.on("before_agent_start", async (event, ctx) => {
    if (currentConfig?.primer?.enabled === false || !sessionIndex || indexState === "failed") return;
    try {
      if (await sessionIndex.size() === 0) return;
      const cwd = ctx.cwd || "";
      const projectSlug = cwd ? pathToSlug(cwd) : void 0;
      let sessions = await sessionIndex.list({ project: projectSlug, limit: 5 });
      if (sessions.length === 0 && projectSlug) {
        sessions = await sessionIndex.list({ limit: 5 });
      }
      if (sessions.length === 0) return;
      const lines = await Promise.all(sessions.map(async (s) => {
        let name;
        if (currentVerdict?.kind === "digest-hybrid") {
          const digest = await sessionIndex.getDigest(s.id);
          name = digest ? digest.headline : truncate(s.firstUserMessage, 80);
        } else {
          name = s.name || truncate(s.firstUserMessage, 80);
        }
        const date = s.startedAt.split("T")[0];
        const rel = formatRelativeDate(s.startedAt);
        const displayCwd = s.cwd.replace(homedir4(), "~").slice(0, 60);
        const msgs = `${s.userMessageCount} user, ${s.assistantMessageCount} assistant`;
        const modelTag = s.models[0] ? ` Mode: ${s.models[0].split("/").pop()}` : "";
        return `- **${rel}**: **${name}** (${date}) Project: ${s.projectSlug} | CWD: ${displayCwd} Messages: ${msgs}${modelTag}`;
      }));
      const primer = `

## Recent Sessions (this project)
${lines.join("\n")}
`;
      const trimmed = primer.length > 1500 ? primer.slice(0, 1500) + "\n" : primer;
      return { systemPrompt: (event.systemPrompt || "") + trimmed };
    } catch {
      return void 0;
    }
  });
  pi.on("session_start", async (_event, ctx) => {
    const myGen = ++bootGeneration;
    const ui = {
      notify: (msg, level) => {
        if (myGen === bootGeneration) ctx.ui.notify(msg, level);
      },
      setStatus: (key, text) => {
        if (myGen === bootGeneration) ctx.ui.setStatus(key, text);
      }
    };
    lastCwd = ctx.cwd || process.cwd();
    try {
      currentConfig = loadConfig(lastCwd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ui.notify(`session-search: ${msg}`, "warning");
    }
    currentDigestConfig = loadDigestConfig(lastCwd);
    const digestConfigured = Boolean(
      currentDigestConfig.provider && currentDigestConfig.model
    );
    ui.setStatus(
      "session-digest",
      digestConfigured ? "" : DIGEST_DISABLED_STATUS
    );
    const embedder = currentConfig?.embedder ? createEmbedder(
      currentConfig.embedder,
      (msg, level) => ui.notify(msg, level)
    ) : null;
    const verdict = await resolveModeVerdict(
      currentConfig,
      () => ctx.modelRegistry.getAvailable(),
      {
        embedderAvailable: embedder !== null,
        digestConfig: currentDigestConfig,
        cwd: lastCwd
      }
    );
    if (myGen !== bootGeneration) return;
    currentVerdict = verdict;
    if (syncTimer) clearInterval(syncTimer);
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    await sessionIndex?.close();
    if (myGen !== bootGeneration) return;
    sessionIndex = null;
    indexState = "loading";
    if (verdict.kind === "misconfigured") {
      ui.setStatus("session-search", verdict.statusLine);
      ui.notify(verdict.notifyMessage, "error");
      console.error(verdict.notifyMessage);
      lifecycleHandle?.deactivate();
      return;
    }
    const options = {
      indexDir: getIndexDir(lastCwd),
      extraSessionDirs: currentConfig?.extraSessionDirs ?? [],
      extraArchiveDirs: currentConfig?.extraArchiveDirs ?? [],
      sessionDir: currentConfig?.sessionDir,
      archiveDir: currentConfig?.archiveDir,
      embedder: currentConfig?.embedder,
      digestHybrid: verdict.kind === "digest-hybrid",
      fusion: currentConfig?.fusion
    };
    const index = useIndexWorker && existsSync7(indexWorkerFile) ? spawnIndexWorker(indexWorkerFile, options, (err) => {
      if (myGen !== bootGeneration) return;
      indexState = "failed";
      indexError = `${err.message.replace(/\.$/, "")}. Run /reload to restart indexing.`;
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = null;
      ui.notify(`session-search: ${indexError}`, "error");
    }) : createIndexService(options);
    sessionIndex = index;
    let syncAction = resolveSyncAction(currentConfig?.sync?.interval);
    let initialAction = resolveInitialSyncAction(currentConfig?.sync?.initialDelay);
    if (currentConfig?.sync?.disableForChild && isChildProcess()) {
      syncAction = { disabled: true };
      initialAction = { skip: true };
    }
    if (syncAction.fallback) ui.notify("session-search: invalid sync.interval; using default", "warning");
    if (initialAction.fallback) ui.notify("session-search: invalid sync.initialDelay; using default", "warning");
    const sync = async () => {
      try {
        await index.sync({
          onProgress: (msg) => ui.setStatus("session-search", msg),
          onError: (msg) => ui.notify(`session-search: ${msg}`, "warning")
        });
        if (myGen !== bootGeneration || indexState === "failed") return;
        indexState = "ready";
        ui.setStatus("session-search", "");
      } catch (err) {
        if (myGen !== bootGeneration || indexState === "failed") return;
        indexState = "ready";
        ui.notify(`session-search: sync failed: ${err.message}`, "warning");
      }
    };
    const loaded = index.load({ onError: (msg) => ui.notify(`session-search: ${msg}`, "warning") }).then(() => {
      if (myGen !== bootGeneration || indexState === "failed") return;
      indexState = initialAction.skip ? "ready" : "warming";
      if (!initialAction.skip) {
        if (initialAction.delayMs) scheduleTimer(() => {
          void sync();
        }, initialAction.delayMs);
        else void sync();
      }
      if (!syncAction.disabled) syncTimer = setInterval(() => {
        void sync();
      }, syncAction.intervalMs ?? SYNC_INTERVAL_MS);
    }).catch((err) => {
      if (myGen !== bootGeneration || indexState === "failed") return;
      indexState = "failed";
      indexError = err.message;
      ui.notify(`session-search init failed: ${indexError}`, "error");
    });
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 1e3).unref())]);
  });
  lifecycleHandle = installDigestLifecycle(pi, {
    storage: { loadDigest, saveDigest, loadBuilderState, saveBuilderState },
    builder: { generateDigest, generateTitle },
    costTracker: lifecycleCostTracker,
    configLoader: () => loadDigestConfig(lastCwd),
    modelResolver: resolveModel,
    indexAddDigested,
    isCurrentGeneration: () => currentVerdict?.kind === "digest-hybrid" && lifecycleGen === bootGeneration,
    onSessionStartCaptureGeneration: () => {
      lifecycleGen = bootGeneration;
    }
  });
  pi.on("session_shutdown", async () => {
    bootGeneration++;
    lifecycleHandle?.dispose();
    lifecycleHandle = null;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    const index = sessionIndex;
    sessionIndex = null;
    indexState = "off";
    await index?.close();
  });
  pi.registerCommand("session:summarizer", {
    description: "Configure session-digest model interactively",
    handler: async (_args, ctx) => {
      const configPath = getDigestConfigPath();
      if (!existsSync7(configPath)) {
        const picked = await pickDigestModel(ctx, { prompt: "Select digest model" });
        if (!picked) {
          ctx.ui.notify("Digest config creation cancelled.", "info");
          return;
        }
        const [provider, ...modelParts] = picked.split("/");
        const model = modelParts.join("/");
        const config = {
          ...loadDigestConfig(lastCwd),
          provider,
          model,
          debounceSeconds: 60,
          resummarizeTokenThreshold: 4e3
        };
        saveDigestConfig(config);
        ctx.ui.notify(
          `Digest config created at ${configPath} with model ${picked}. Run /reload to activate.`,
          "info"
        );
        if (!currentConfig?.embedder) {
          ctx.ui.notify(
            "Warning: digest-hybrid mode also requires an embedder. Run /session:embedder to configure semantic search, or remove digest.json to stay in fts-raw mode.",
            "warning"
          );
        }
      } else {
        const current = loadDigestConfig(ctx.cwd || process.cwd());
        const currentModel = current.provider && current.model ? `${current.provider}/${current.model}` : void 0;
        const picked = await pickDigestModel(ctx, {
          prompt: "Change digest model",
          currentModel
        });
        if (!picked) {
          ctx.ui.notify("Digest config unchanged.", "info");
          return;
        }
        const [provider, ...modelParts] = picked.split("/");
        const model = modelParts.join("/");
        const config = {
          ...current,
          provider,
          model
        };
        saveDigestConfig(config);
        ctx.ui.notify(
          `Digest model updated to ${picked}. Run /reload to activate.`,
          "info"
        );
        if (!currentConfig?.embedder) {
          ctx.ui.notify(
            "Warning: digest-hybrid mode also requires an embedder. Run /session:embedder to configure semantic search, or remove digest.json to stay in fts-raw mode.",
            "warning"
          );
        }
      }
    }
  });
  pi.registerCommand("session:update", {
    description: "Generate/update the digest for the current session immediately (bypasses debounce)",
    handler: async (_args, ctx) => {
      if (currentVerdict?.kind === "misconfigured") {
        ctx.ui.notify(currentVerdict.notifyMessage, "error");
        return;
      }
      if (currentVerdict?.kind !== "digest-hybrid") {
        ctx.ui.notify(DIGEST_DISABLED_MESSAGE, "warning");
        return;
      }
      if (!lifecycleHandle) {
        ctx.ui.notify("Digest lifecycle not installed.", "warning");
        return;
      }
      ctx.ui.notify("Generating digest\u2026", "info");
      try {
        const digest = await lifecycleHandle.triggerNow();
        if (digest) {
          ctx.ui.notify(`Digest updated: "${digest.headline}"`, "info");
        } else {
          ctx.ui.notify(
            "Digest generation failed (LLM returned no valid output).",
            "error"
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Digest generation failed: ${msg}`, "error");
      }
    }
  });
  pi.registerCommand("session:digest", {
    description: "Print the current session's digest",
    handler: async (_args, ctx) => {
      if (currentVerdict?.kind === "misconfigured") {
        ctx.ui.notify(currentVerdict.notifyMessage, "error");
        return;
      }
      if (currentVerdict?.kind !== "digest-hybrid") {
        ctx.ui.notify(DIGEST_DISABLED_MESSAGE, "warning");
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const digest = loadDigest(sessionId);
      if (!digest) {
        ctx.ui.notify("(no digest yet)", "info");
        return;
      }
      const lines = [
        `**${digest.headline}**`,
        digest.topics.length ? `Topics: ${digest.topics.join(", ")}` : "",
        digest.outcome ? `Outcome: ${digest.outcome}` : "",
        "",
        digest.body
      ].filter((l) => l !== "");
      ctx.ui.notify(lines.join("\n"), "info");
    }
  });
  pi.registerCommand("session:rewrite", {
    description: "Force full re-summarize of the current session digest regardless of token threshold",
    handler: async (_args, ctx) => {
      if (currentVerdict?.kind === "misconfigured") {
        ctx.ui.notify(currentVerdict.notifyMessage, "error");
        return;
      }
      if (currentVerdict?.kind !== "digest-hybrid") {
        ctx.ui.notify(DIGEST_DISABLED_MESSAGE, "warning");
        return;
      }
      if (!lifecycleHandle) {
        ctx.ui.notify("Digest lifecycle not installed.", "warning");
        return;
      }
      ctx.ui.notify("Force re-summarizing digest\u2026", "info");
      try {
        const digest = await lifecycleHandle.triggerNow({ forceFull: true });
        if (digest) {
          ctx.ui.notify(`Digest rewritten: "${digest.headline}"`, "info");
        } else {
          ctx.ui.notify("Digest re-summarize failed.", "error");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Digest re-summarize failed: ${msg}`, "error");
      }
    }
  });
  pi.registerCommand("session:backfill", {
    description: "Generate digests for un-digested historical sessions. Flags: --dry-run (cost estimate only), --regen (overwrite all existing digests)",
    handler: async (args, ctx) => {
      const myGen = bootGeneration;
      if (currentVerdict?.kind === "misconfigured") {
        ctx.ui.notify(currentVerdict.notifyMessage, "error");
        return;
      }
      if (currentVerdict?.kind !== "digest-hybrid") {
        ctx.ui.notify(DIGEST_DISABLED_MESSAGE, "warning");
        return;
      }
      const flag = args.trim();
      const isDryRun = flag === "--dry-run";
      const isRegen = flag === "--regen";
      const digestConfig = loadDigestConfig(ctx.cwd || process.cwd());
      const activeSessionId = ctx.sessionManager.getSessionId();
      const files = discoverSessionFiles(
        currentConfig?.extraSessionDirs ?? [],
        currentConfig?.extraArchiveDirs ?? [],
        currentConfig?.sessionDir,
        currentConfig?.archiveDir
      );
      const backfillModel = resolveModel(digestConfig, ctx.modelRegistry.getAvailable());
      if (!backfillModel) {
        ctx.ui.notify("No digest model available for backfill. Run /session:summarizer to configure.", "error");
        return;
      }
      if (isDryRun) {
        const embedderRaw = currentConfig?.embedder;
        runBackfillDryRun({
          files,
          activeSessionId,
          resolvedModel: backfillModel,
          embedderPricePerInputToken: embedderRaw?.pricePerInputToken,
          notify: (msg, level = "info") => {
            if (myGen !== bootGeneration) return;
            ctx.ui.notify(msg, level);
          }
        });
        return;
      }
      if (currentVerdict?.kind !== "digest-hybrid") {
        ctx.ui.notify(
          "Backfill requires a vector index (configure embedder via /session:embedder).",
          "warning"
        );
        return;
      }
      let completeFn;
      try {
        completeFn = await resolveHostCompleteFn(
          ctx.modelRegistry,
          backfillModel
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Backfill: provider resolution failed: ${msg}`, "error");
        return;
      }
      await runBackfill({
        files,
        activeSessionId,
        index: sessionIndex,
        resolvedModel: backfillModel,
        completeFn,
        digestConfig,
        regenMode: isRegen,
        setStatus: (msg) => {
          if (myGen !== bootGeneration) return;
          ctx.ui.setStatus("session-search", msg ?? "");
        },
        notify: (msg, level = "info") => {
          if (myGen !== bootGeneration) return;
          ctx.ui.notify(msg, level);
        }
      });
    }
  });
  pi.registerCommand("session:cost", {
    description: "Show cumulative digest generation cost for this process",
    handler: async (_args, ctx) => {
      if (currentVerdict?.kind === "misconfigured") {
        ctx.ui.notify(currentVerdict.notifyMessage, "error");
        return;
      }
      if (currentVerdict?.kind !== "digest-hybrid") {
        ctx.ui.notify(DIGEST_DISABLED_MESSAGE, "warning");
        return;
      }
      if (currentRollup.calls === 0) {
        ctx.ui.notify("No cost recorded this process.", "info");
        return;
      }
      ctx.ui.notify(format(currentRollup, "digest"), "info");
    }
  });
  pi.registerCommand("session:embedder", {
    description: "Configure semantic embeddings for session search (OpenAI-compatible API)",
    handler: async (_args, ctx) => {
      const baseUrl = await ctx.ui.input(
        "Embeddings API base URL (e.g. https://api.openai.com):",
        "https://api.openai.com"
      );
      if (!baseUrl) {
        ctx.ui.notify("Setup cancelled.", "info");
        return;
      }
      const model = await ctx.ui.input(
        "Model name (e.g. text-embedding-3-small):",
        "text-embedding-3-small"
      );
      if (!model) {
        ctx.ui.notify("Setup cancelled.", "info");
        return;
      }
      const apiKey = await ctx.ui.input(
        "API key (leave blank to use an env var instead):",
        ""
      );
      let apiKeyEnv;
      if (!apiKey) {
        const envVar = await ctx.ui.input(
          "Env var name for API key (e.g. OPENAI_API_KEY):",
          "OPENAI_API_KEY"
        );
        if (envVar) apiKeyEnv = envVar;
      }
      const dimsInput = await ctx.ui.input(
        "Embedding dimensions (leave blank for API default):",
        ""
      );
      const dimensions = dimsInput && !isNaN(parseInt(dimsInput, 10)) ? parseInt(dimsInput, 10) : void 0;
      const extraDirs = await ctx.ui.input(
        "Extra session directories (comma-separated, optional):",
        ""
      );
      const extraArchive = await ctx.ui.input(
        "Extra archive directories (comma-separated, optional):",
        ""
      );
      const embedder = {
        baseUrl: baseUrl.replace(/\/$/, ""),
        model,
        ...apiKey ? { apiKey } : {},
        ...apiKeyEnv ? { apiKeyEnv } : {},
        ...dimensions !== void 0 ? { dimensions, sendDimensions: true } : {}
      };
      saveConfig({
        ...loadConfig(lastCwd),
        embedder,
        extraSessionDirs: extraDirs ? extraDirs.split(",").map((d) => d.trim()).filter(Boolean) : void 0,
        extraArchiveDirs: extraArchive ? extraArchive.split(",").map((d) => d.trim()).filter(Boolean) : void 0
      }, lastCwd);
      ctx.ui.notify(
        `Embeddings config saved to ${getConfigPath(lastCwd)}. Run /reload to activate.`,
        "info"
      );
    }
  });
  pi.registerCommand("session:sync", {
    description: "Force an immediate incremental re-sync of the session index",
    handler: async (_args, ctx) => {
      if (!sessionIndex || indexState === "loading" || indexState === "failed") {
        ctx.ui.notify(unavailable(), "warning");
        return;
      }
      const myGen = bootGeneration;
      try {
        const r = await sessionIndex.sync({ onProgress: (msg) => {
          if (myGen !== bootGeneration) return;
          ctx.ui.setStatus("session-search", msg);
        } });
        if (myGen !== bootGeneration) return;
        const parts = [];
        if (r.added) parts.push(`+${r.added}`);
        if (r.updated) parts.push(`~${r.updated}`);
        if (r.removed) parts.push(`-${r.removed}`);
        if (r.moved) parts.push(`\u2197${r.moved}`);
        ctx.ui.notify(
          `Synced: ${parts.join(" ") || "no changes"} (${await sessionIndex.size()} total)`,
          "info"
        );
        ctx.ui.setStatus("session-search", "");
      } catch (err) {
        if (myGen !== bootGeneration) return;
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Sync failed: ${msg}`, "error");
      }
    }
  });
  pi.registerCommand("session:reindex", {
    description: "Force full re-index of all session files",
    handler: async (_args, ctx) => {
      if (!sessionIndex || indexState === "loading" || indexState === "failed") {
        ctx.ui.notify(unavailable(), "warning");
        return;
      }
      const myGen = bootGeneration;
      ctx.ui.notify("Re-indexing sessions\u2026", "info");
      try {
        await sessionIndex.rebuild({ onProgress: (msg) => {
          if (myGen !== bootGeneration) return;
          ctx.ui.setStatus("session-search", msg);
        } });
        if (myGen !== bootGeneration) return;
        ctx.ui.notify(`Re-indexed: ${await sessionIndex.size()} sessions`, "info");
        ctx.ui.setStatus("session-search", "");
      } catch (err) {
        if (myGen !== bootGeneration) return;
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Re-index failed: ${msg}`, "error");
      }
    }
  });
  registerFindSessionCommand(pi, {
    getCurrentVerdict: () => currentVerdict,
    index: {
      async search(query, limit) {
        if (!sessionIndex) return [];
        return sessionIndex.search(query, limit);
      },
      async getDigest(sessionId) {
        if (currentVerdict?.kind === "digest-hybrid") {
          return sessionIndex?.getDigest(sessionId) ?? null;
        }
        return null;
      }
    }
  });
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description: "Semantic search over past pi sessions. Returns summaries of the most relevant sessions for a natural language query. Use to find previous work, decisions, debugging sessions, or code changes.",
    promptSnippet: "Semantic search over past pi sessions \u2014 find previous work, decisions, and context by topic.",
    promptGuidelines: [
      "Use session_search to find past coding sessions relevant to the current task (e.g. 'when did we refactor the auth module', 'previous work on Lambda timeouts').",
      "Use session_list for browsing by date/project. Use session_read to dive into a specific session."
    ],
    parameters: Type2.Object({
      project: Type2.Optional(Type2.String({ description: "Filter by project slug or cwd" })),
      query: Type2.String({ description: "Natural language search query" }),
      limit: Type2.Optional(
        Type2.Number({
          description: "Max results to return (default 10, max 25)"
        })
      )
    }),
    async execute(_toolCallId, params, signal) {
      try {
        if (currentVerdict?.kind === "misconfigured") {
          return {
            content: [{ type: "text", text: currentVerdict.notifyMessage }],
            details: {}
          };
        }
        if (!sessionIndex || indexState === "loading" || indexState === "failed") {
          return { content: [{ type: "text", text: unavailable() }], details: {} };
        }
        if (await sessionIndex.size() === 0) {
          const msg = currentVerdict?.kind === "digest-hybrid" ? "Session index is empty in digest mode. Run /session:backfill to digest historical sessions, or wait for new sessions to be digested live." : "Session index is empty \u2014 it may still be building. Try again in a moment.";
          return { content: [{ type: "text", text: msg + warmingNote() }], details: {} };
        }
        const limit = Math.min(params.limit ?? 10, 25);
        try {
          const results = await sessionIndex.search(params.query, limit, params.project);
          if (results.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No relevant sessions found for: "${params.query}"${warmingNote()}`
                }
              ],
              details: {}
            };
          }
          const home = homedir4();
          const output = (await Promise.all(results.map(async (r, i) => {
            const score = (r.score * 100).toFixed(1);
            const displayFile = r.session.file.replace(home, "~");
            if (currentVerdict?.kind === "digest-hybrid") {
              const digest = await sessionIndex.getDigest(r.session.id);
              if (digest) {
                const topicsLine = digest.topics.length > 0 ? `Topics: ${digest.topics.join(", ")}` : "";
                const bodyExcerpt = truncate(digest.body, 300);
                return [
                  `### ${i + 1}. ${digest.headline} (${score}% match)`,
                  `File: ${displayFile}`,
                  `ID: ${r.session.id}`,
                  `Date: ${r.session.startedAt.split("T")[0]} | CWD: ${r.session.cwd}`,
                  ...topicsLine ? [topicsLine] : [],
                  bodyExcerpt
                ].join("\n");
              }
            }
            return [
              `### ${i + 1}. ${r.session.name || truncate(r.session.firstUserMessage, 80)} (${score}% match)`,
              `File: ${displayFile}`,
              `ID: ${r.session.id}`,
              `Date: ${r.session.startedAt.split("T")[0]} | CWD: ${r.session.cwd}`,
              r.summary
            ].join("\n");
          }))).join("\n\n---\n\n");
          const header = `Found ${results.length} sessions for "${params.query}" (${await sessionIndex.size()} sessions indexed):

`;
          return {
            content: [{ type: "text", text: header + output + warmingNote() }],
            details: { resultCount: results.length, indexSize: await sessionIndex.size() }
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`session-search failed: ${msg}`);
        }
      } catch (err) {
        if (indexState === "failed") return { content: [{ type: "text", text: unavailable() }], details: {} };
        throw err;
      }
    }
  });
  pi.registerTool({
    name: "session_list",
    label: "Session List",
    description: "List past pi sessions with optional filters by project, date range, or archive status. Returns session metadata and summaries.",
    promptSnippet: "List/filter past pi sessions by project, date, or archive status.",
    parameters: Type2.Object({
      project: Type2.Optional(
        Type2.String({ description: "Filter by project name or path substring" })
      ),
      after: Type2.Optional(
        Type2.String({
          description: "Only sessions after this date (ISO format, e.g. 2026-03-01)"
        })
      ),
      before: Type2.Optional(
        Type2.String({
          description: "Only sessions before this date (ISO format)"
        })
      ),
      archived: Type2.Optional(
        Type2.Boolean({ description: "Filter by archived status" })
      ),
      limit: Type2.Optional(
        Type2.Number({ description: "Max results (default 20, max 50)" })
      )
    }),
    async execute(_toolCallId, params) {
      try {
        if (currentVerdict?.kind === "misconfigured") {
          return {
            content: [{ type: "text", text: currentVerdict.notifyMessage }],
            details: {}
          };
        }
        if (!sessionIndex || indexState === "loading" || indexState === "failed") {
          return { content: [{ type: "text", text: unavailable() }], details: {} };
        }
        if (await sessionIndex.size() === 0) {
          const msg = !sessionIndex ? unavailable() : "Session index is empty.";
          return { content: [{ type: "text", text: msg + warmingNote() }], details: {} };
        }
        const limit = Math.min(params.limit ?? 20, 50);
        const sessions = await sessionIndex.list({
          project: params.project,
          after: params.after,
          before: params.before,
          archived: params.archived,
          limit
        });
        if (sessions.length === 0) {
          return {
            content: [{ type: "text", text: `No sessions match the filters.${warmingNote()}` }],
            details: {}
          };
        }
        const home = homedir4();
        const output = (await Promise.all(sessions.map(async (s, i) => {
          let name;
          if (currentVerdict?.kind === "digest-hybrid") {
            const digest = await sessionIndex.getDigest(s.id);
            if (digest) {
              name = digest.headline;
            } else {
              name = truncate(s.firstUserMessage, 60) + " (no digest \u2014 run /session:update)";
            }
          } else {
            name = s.name || truncate(s.firstUserMessage, 60);
          }
          const date = s.startedAt.split("T")[0];
          const tools = s.toolCalls.slice(0, 3).map((t) => t.name).join(", ");
          const arch = s.archived ? " (archived)" : "";
          const displayFile = s.file.replace(home, "~");
          return `${i + 1}. **${name}** \u2014 ${date}${arch}
   CWD: ${s.cwd} | ${s.userMessageCount} msgs | Tools: ${tools}
   File: ${displayFile}`;
        }))).join("\n\n");
        const header = `${sessions.length} sessions (${await sessionIndex.size()} total indexed):

`;
        return {
          content: [{ type: "text", text: header + output + warmingNote() }],
          details: { resultCount: sessions.length }
        };
      } catch (err) {
        if (indexState === "failed") return { content: [{ type: "text", text: unavailable() }], details: {} };
        throw err;
      }
    }
  });
  pi.registerTool({
    name: "session_read",
    label: "Session Read",
    description: "Read the full conversation from a past pi session. Provide the session file path or session ID. Supports pagination for large sessions.",
    promptSnippet: "Read the full conversation from a specific past pi session by file path or ID.",
    parameters: Type2.Object({
      session: Type2.String({
        description: "Session file path (from session_search/session_list results) or session UUID"
      }),
      offset: Type2.Optional(
        Type2.Number({
          description: "Start from this entry index (for pagination, default 0)"
        })
      ),
      limit: Type2.Optional(
        Type2.Number({
          description: "Max entries to return (default 50, max 100)"
        })
      ),
      include_tools: Type2.Optional(
        Type2.Boolean({
          description: "Include tool results in output (default false, verbose)"
        })
      )
    }),
    async execute(_toolCallId, params) {
      try {
        if (currentVerdict?.kind === "misconfigured") {
          return {
            content: [{ type: "text", text: currentVerdict.notifyMessage }],
            details: {}
          };
        }
        let filePath = params.session;
        if (sessionIndex && !filePath.endsWith(".jsonl") && !filePath.includes("/")) {
          const entry = await sessionIndex.get(filePath);
          if (entry) {
            filePath = entry.session.file;
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: `Session not found: "${params.session}". Use session_search or session_list to find the session file path.${warmingNote()}`
                }
              ],
              details: {}
            };
          }
        }
        if (filePath.startsWith("~")) {
          filePath = filePath.replace("~", process.env.HOME || "");
        }
        const home = homedir4();
        const allowedRoots = [
          resolve(home, ".pi", "agent", "sessions"),
          resolve(home, ".pi", "agent", "sessions-archive"),
          ...(currentConfig?.extraSessionDirs ?? []).map((d) => resolve(d)),
          ...(currentConfig?.extraArchiveDirs ?? []).map((d) => resolve(d))
        ];
        const resolvedPath = resolve(filePath);
        if (!allowedRoots.some(
          (root) => resolvedPath.startsWith(root + "/") || resolvedPath === root
        )) {
          return {
            content: [
              {
                type: "text",
                text: `Access denied: path "${filePath}" is outside the allowed session directories.`
              }
            ],
            details: {}
          };
        }
        const limit = Math.min(params.limit ?? 50, 100);
        const output = readSessionConversation(filePath, {
          offset: params.offset ?? 0,
          limit,
          includeTools: params.include_tools ?? false
        });
        return {
          content: [{ type: "text", text: output }],
          details: { file: filePath }
        };
      } catch (err) {
        if (indexState === "failed") return { content: [{ type: "text", text: unavailable() }], details: {} };
        throw err;
      }
    }
  });
}
export {
  _setIndexWorkerEnabled,
  buildContent,
  buildPrompt,
  buildSummary,
  capInput,
  decodeEmbedding,
  index_default as default,
  digestPath,
  discoverSessionFiles,
  emptyBuilderState,
  emptyRollup,
  encodeEmbedding,
  estimateTokens,
  extractDelta,
  format as formatCost,
  formatRelativeDate,
  generateDigest,
  getConfigPath,
  getDigestConfigPath,
  getIndexDir,
  installDigestLifecycle,
  isChildProcess,
  listDigestedSessionIds,
  liveConversationView,
  loadBuilderState,
  loadConfig,
  loadDigest,
  loadDigestConfig,
  parseSession,
  parsedConversationView,
  pathToSlug,
  readSessionId,
  record as recordCost,
  registerFindSessionCommand,
  resolveInitialSyncAction,
  resolveModel,
  resolveSyncAction,
  runBackfill,
  runBackfillDryRun,
  saveBuilderState,
  saveConfig,
  saveDigest,
  saveDigestConfig,
  slugToProject,
  statePath,
  toFtsQuery,
  truncate,
  validateDigest
};
//# sourceMappingURL=index.js.map

/**
 * The session index behind an async API, so it can live on a worker thread.
 *
 * `createIndexService` runs the index in the calling thread (used inside the
 * worker, and as the fallback when the worker bundle is missing).
 * `spawnIndexWorker` returns the same API backed by `dist/index-worker.js`,
 * which keeps discovery, JSONL parsing, JSON index loading and SQLite work off
 * pi's main (UI) thread. See issue #16.
 */
import { Worker } from "node:worker_threads";
import { buildSummary } from "./utils";
import { createEmbedder } from "./embedder";
import type { EmbedderConfig } from "./embedder";
import { FtsSessionIndex } from "./index/fts-index";
import type { ParsedSession } from "./parser";
import { SessionIndex, stripHeavyFields, migrateIndexFileIfStale } from "./index/session-index";
import { discoverSessionFiles, parseSession, readSessionId } from "./parser";
import type { SessionDigest } from "./digest/schema";
import type { ListFilters, SearchResult } from "./index/session-index";

/** Structured-clonable index settings (crosses the worker boundary). */
export interface IndexOptions {
  indexDir: string;
  extraSessionDirs: string[];
  extraArchiveDirs: string[];
  sessionDir?: string;
  archiveDir?: string;
  embedder?: EmbedderConfig;
  digestHybrid?: boolean;
  fusion?: "rrf" | "vector-primary";
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  moved: number;
}

export interface IndexEntry {
  session: ParsedSession;
  summary: string;
}

export interface SyncCallbacks {
  onProgress?: (msg: string) => void;
  onError?: (msg: string) => void;
}

export interface IndexService {
  /** Open the index and load persisted state. Resolves to the session count. */
  load(callbacks?: SyncCallbacks): Promise<number>;
  sync(callbacks?: SyncCallbacks): Promise<SyncResult>;
  rebuild(callbacks?: SyncCallbacks): Promise<void>;
  search(query: string, limit: number, project?: string): Promise<SearchResult[]>;
  list(filters?: ListFilters): Promise<ParsedSession[]>;
  get(fileOrId: string): Promise<IndexEntry | undefined>;
  size(): Promise<number>;
  close(): Promise<void>;
  getDigest(id: string): Promise<SessionDigest | null>;
  addDigested(id: string, session: ParsedSession, digest: SessionDigest, opts?: { batched: boolean }): Promise<void>;
  addDigest(id: string, digest: SessionDigest): Promise<void>;
  flush(): Promise<void>;
  setBackfillInProgress(value: boolean): Promise<void>;
}

type Op = "load" | "sync" | "rebuild" | "search" | "list" | "get" | "size" | "close" | "getDigest" | "addDigested" | "addDigest" | "flush" | "setBackfillInProgress";

export interface WorkerRequest {
  id: number;
  op: Op;
  args: unknown[];
}

export type WorkerReply =
  | { id: number; type: "progress"; msg: string }
  | { id: number; type: "notice"; msg: string }
  | { id: number; type: "result"; value: unknown }
  | { id: number; type: "failure"; message: string };

// ─── In-thread service ───────────────────────────────────────────────

export function createIndexService(options: IndexOptions): IndexService {
  let index: SessionIndex | FtsSessionIndex | null = null;
  let inflightSync: Promise<SyncResult> | null = null;
  // Serializes writers: sync and rebuild must not interleave on one index.
  let writerTail: Promise<unknown> = Promise.resolve();

  const open = (): SessionIndex | FtsSessionIndex => {
    if (!index) throw new Error("session index is not loaded");
    return index;
  };
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writerTail.then(fn);
    writerTail = run.catch(() => {});
    return run;
  };

  return {
    async load(callbacks) {
      const migration = migrateIndexFileIfStale(options.indexDir);
      if (migration.didMigrate) callbacks?.onError?.(`index version ${migration.migratedFrom} is incompatible; reset. Run /session:backfill to repopulate.`);
      const embedder = options.digestHybrid && options.embedder ? createEmbedder(options.embedder) : null;
      index ??= embedder
        ? new SessionIndex(
            embedder,
            options.indexDir,
            options.extraSessionDirs,
            options.extraArchiveDirs,
            "digest-hybrid",
            options.sessionDir,
            options.archiveDir,
            options.fusion,
          )
        : new FtsSessionIndex(
            options.indexDir,
            options.extraSessionDirs,
            options.extraArchiveDirs,
            options.sessionDir,
            options.archiveDir,
          );
      await index.load((msg) => callbacks?.onError?.(msg), options.embedder);
      return index.size();
    },
    sync(callbacks) {
      // Concurrent callers (initial sync, periodic timer, /session-sync) share one run.
      inflightSync ??= exclusive(() =>
        open().sync(callbacks?.onProgress, callbacks?.onError),
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
      const results = await open().search(query, limit, undefined, project);
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
          const file = discoverSessionFiles(options.extraSessionDirs, options.extraArchiveDirs, options.sessionDir, options.archiveDir)
            .find((entry) => readSessionId(entry.file) === id);
          if (file) session = parseSession(file.file, file.archived) ?? undefined;
        }
        if (session) await current.addDigested(id, session, digest);
      });
    },
    flush() {
      return exclusive(async () => { const current = open(); if (current instanceof SessionIndex) current.flush(); });
    },
    setBackfillInProgress(value) {
      return exclusive(async () => { const current = open(); if (current instanceof SessionIndex) current.backfillInProgress = value; });
    },
    async close() {
      await writerTail;
      if (index instanceof SessionIndex) index.dispose();
      else index?.close();
      index = null;
    },
  };
}

// ─── Worker-thread proxy ─────────────────────────────────────────────

/**
 * Run the index on a worker thread. `onCrash` fires once if the worker dies
 * unexpectedly; every pending and later call then rejects with that error.
 */
export function spawnIndexWorker(
  workerFile: string,
  options: IndexOptions,
  onCrash: (err: Error) => void,
): IndexService {
  // stdout/stderr: true keeps worker output (e.g. node:sqlite's
  // ExperimentalWarning on Node 22) from painting over pi's TUI.
  const worker = new Worker(workerFile, { workerData: options, stdout: true, stderr: true });
  // No worker.unref(): reading stdout/stderr and the "message" listener
  // re-reference the worker, so it would do nothing. session_shutdown ends
  // the worker through close().
  worker.stdout.resume();
  let stderrTail = "";
  worker.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-1000);
  });

  let nextId = 1;
  let dead: Error | null = null;
  let closing = false;
  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; callbacks?: SyncCallbacks }
  >();

  const die = (err: Error) => {
    if (dead) return;
    dead = err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    if (!closing) onCrash(err);
  };

  worker.on("message", (reply: WorkerReply) => {
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

  const call = <T>(op: Op, args: unknown[] = [], callbacks?: SyncCallbacks): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (dead) return reject(dead);
      const id = nextId++;
      pending.set(id, { resolve, reject, callbacks });
      worker.postMessage({ id, op, args } satisfies WorkerRequest);
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
      // No graceful DB close: SQLite rolls back an unfinished chunk on next
      // open, and the JSON index is written with an atomic rename.
      closing = true;
      await worker.terminate();
    },
  };
}

/** Dispatch one worker request against an in-thread service. */
export async function handleWorkerRequest(
  service: IndexService,
  req: WorkerRequest,
  post: (reply: WorkerReply) => void,
): Promise<void> {
  const callbacks: SyncCallbacks = {
    onProgress: (msg) => post({ id: req.id, type: "progress", msg }),
    onError: (msg) => post({ id: req.id, type: "notice", msg }),
  };
  const [a, b, c, d] = req.args as any[];
  try {
    const value = await {
      load: () => service.load(callbacks),
      sync: () => service.sync(callbacks),
      rebuild: () => service.rebuild(callbacks),
      search: () => service.search(a, b, c),
      list: () => service.list(a),
      get: () => service.get(a),
      size: () => service.size(),
      close: () => service.close(),
      getDigest: () => service.getDigest(a),
      addDigested: () => service.addDigested(a, b, c, d),
      addDigest: () => service.addDigest(a, b),
      flush: () => service.flush(),
      setBackfillInProgress: () => service.setBackfillInProgress(a),
    }[req.op]();
    post({ id: req.id, type: "result", value });
  } catch (err: any) {
    post({ id: req.id, type: "failure", message: err?.message ?? String(err) });
  }
}

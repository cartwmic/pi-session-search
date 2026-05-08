/**
 * Structured logging for pi-session-search.
 *
 * Pino + rotating-file-stream, mirroring pi-claude-bridge so users can grep
 * across both logs uniformly. On by default — flip off via env when noise
 * outweighs the diagnostic value.
 *
 * Env vars:
 *   PI_SESSION_SEARCH_DEBUG=0           Disable file logging entirely
 *   PI_SESSION_SEARCH_DEBUG_PATH=...    Override log file path
 *                                       (default: ~/.pi/agent/session-search.log)
 *   PI_SESSION_SEARCH_DEBUG_MAX_BYTES   Per-file rotation size in bytes
 *                                       (default 10 MiB; 2 backups kept →
 *                                       ~30 MiB on-disk ceiling)
 *   PI_SESSION_SEARCH_DEBUG_LEVEL       Pino level: trace|debug|info|warn|error
 *                                       (default "debug")
 *   PI_SESSION_SEARCH_LOG_SYNC_FILE     Test-only override: write log records
 *                                       synchronously to this absolute file
 *                                       path (no rotation, no buffering).
 *                                       Used by unit tests so the test can
 *                                       readFileSync() right after the call
 *                                       under test. Should NOT be set in
 *                                       production — sync writes block the
 *                                       event loop on every record.
 *
 * Output format: JSON-per-line. Every record carries `level`, `time` (ISO),
 * `msg`, `mod` ("pi-session-search"), plus structured fields the call site
 * attached. SQLite call sites attach `op` (operation label), `db` (file path),
 * `durationMs`, and on error `code`/`errno`/`sqliteCode` so SQLITE_BUSY and
 * "database is locked" patterns are greppable without touching JSON parsers.
 *
 * Rotation: rotating-file-stream keeps the live file at the configured path
 * and moves filled segments to numbered backups (`session-search.log.1`,
 * `.log.2`). When backup count exceeds `maxFiles`, oldest is dropped.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import pino from "pino";
import { createStream } from "rotating-file-stream";

// ---------------------------------------------------------------------------
// Lazy logger construction
// ---------------------------------------------------------------------------
//
// The logger is constructed on first use rather than at module load so that:
//   1. PI_SESSION_SEARCH_LOG_SYNC_FILE can be set per-test even though the
//      log module is module-cached across imports.
//   2. PI_SESSION_SEARCH_LOG_RESET=1 can force a one-shot rebuild after
//      tests rotate env vars.
// In production the env is set once before pi spawns, so the lazy path is
// hit exactly once per process and has zero ongoing cost.

let cachedLogger: pino.Logger | undefined;
let cachedPath: string | null = null;

function buildLogger(): { logger: pino.Logger; path: string | null } {
	const DEBUG = process.env.PI_SESSION_SEARCH_DEBUG !== "0";
	const DEBUG_LOG_PATH =
		process.env.PI_SESSION_SEARCH_DEBUG_PATH ||
		join(homedir(), ".pi", "agent", "session-search.log");
	const DEBUG_MAX_BYTES =
		Number(process.env.PI_SESSION_SEARCH_DEBUG_MAX_BYTES) || 10 * 1024 * 1024;
	const LEVEL = process.env.PI_SESSION_SEARCH_DEBUG_LEVEL || "debug";
	const SYNC_FILE = process.env.PI_SESSION_SEARCH_LOG_SYNC_FILE;

	let destinationStream: NodeJS.WritableStream | undefined;
	let resolvedPath: string | null = null;

	if (SYNC_FILE) {
		// Test-only: bypass rotation and buffering entirely so unit tests can
		// read records back synchronously.
		try {
			mkdirSync(dirname(SYNC_FILE), { recursive: true });
			destinationStream = pino.destination({ dest: SYNC_FILE, sync: true });
			resolvedPath = SYNC_FILE;
		} catch {
			destinationStream = undefined;
		}
	} else if (DEBUG) {
		try {
			mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
		} catch {
			/* ignore — falls back to silent if stream construction fails below */
		}
		try {
			destinationStream = createStream(DEBUG_LOG_PATH, {
				size: `${DEBUG_MAX_BYTES}B`,
				maxFiles: 2,
			});
			resolvedPath = DEBUG_LOG_PATH;
		} catch {
			destinationStream = undefined;
		}
	}

	const logger = destinationStream
		? pino(
				{
					level: LEVEL,
					timestamp: pino.stdTimeFunctions.isoTime,
					base: { mod: "pi-session-search", pid: process.pid },
				},
				destinationStream,
			)
		: pino({ level: "silent" });

	return { logger, path: destinationStream ? resolvedPath : null };
}

function getLogger(): pino.Logger {
	if (process.env.PI_SESSION_SEARCH_LOG_RESET === "1") {
		cachedLogger = undefined;
		delete process.env.PI_SESSION_SEARCH_LOG_RESET;
	}
	if (!cachedLogger) {
		const built = buildLogger();
		cachedLogger = built.logger;
		cachedPath = built.path;
	}
	return cachedLogger;
}

/**
 * Process-wide logger. Use `.child(bindings)` to attach context for a
 * specific subsystem (e.g. `log.child({ comp: "fts-index" })`).
 *
 * Implemented as a thin proxy so that the underlying pino instance is
 * resolved on first use (see `getLogger`).
 */
export const log = {
	trace: (obj: unknown, msg?: string) =>
		typeof obj === "string" ? getLogger().trace(obj) : getLogger().trace(obj as object, msg),
	debug: (obj: unknown, msg?: string) =>
		typeof obj === "string" ? getLogger().debug(obj) : getLogger().debug(obj as object, msg),
	info: (obj: unknown, msg?: string) =>
		typeof obj === "string" ? getLogger().info(obj) : getLogger().info(obj as object, msg),
	warn: (obj: unknown, msg?: string) =>
		typeof obj === "string" ? getLogger().warn(obj) : getLogger().warn(obj as object, msg),
	error: (obj: unknown, msg?: string) =>
		typeof obj === "string" ? getLogger().error(obj) : getLogger().error(obj as object, msg),
	child: (bindings: Record<string, unknown>) => getLogger().child(bindings),
};

/**
 * Resolved log file path (null when logging is disabled). Exposed so the
 * extension can surface the location in `/find-session` diagnostics or the
 * README without re-deriving the env logic.
 *
 * Resolves on first access (mirrors `log` lazy init).
 */
export function getLogPath(): string | null {
	getLogger();
	return cachedPath;
}



/**
 * Wrap a synchronous SQLite call so op + duration are captured on success
 * and the SqliteError details (code/errno/sqliteCode) are captured on
 * failure. Rethrows unchanged so existing control flow is preserved.
 *
 * Use for:
 *   - Transaction boundaries (BEGIN / COMMIT / ROLLBACK)
 *   - Statements that historically have triggered SQLITE_BUSY in the wild
 *   - Schema operations (CREATE / DROP / migrations)
 *
 * Cheap row-level operations (a single SELECT, a single INSERT inside a
 * larger wrapped block) generally don't need this — the surrounding
 * transaction wrap captures them via duration roll-up.
 *
 * Threshold: success records below 50 ms are emitted at trace level so the
 * default "debug" level only captures notable ops. Tune via
 * `PI_SESSION_SEARCH_DEBUG_LEVEL=trace` when chasing a hot path.
 */
export function dbCall<T>(
	op: string,
	fields: Record<string, unknown>,
	fn: () => T,
): T {
	const t0 = performance.now();
	try {
		const out = fn();
		const durationMs = Math.round(performance.now() - t0);
		if (durationMs >= 50) {
			log.debug({ op, durationMs, ...fields }, "db op");
		} else {
			log.trace({ op, durationMs, ...fields }, "db op");
		}
		return out;
	} catch (e: any) {
		const durationMs = Math.round(performance.now() - t0);
		log.error(
			{
				op,
				durationMs,
				code: e?.code,
				errno: e?.errno,
				sqliteCode: e?.sqliteCode,
				...fields,
				err: String(e?.message ?? e),
			},
			"db error",
		);
		throw e;
	}
}

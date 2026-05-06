import {
	readFileSync,
	writeFileSync,
	renameSync,
	readdirSync,
	existsSync,
	mkdirSync,
} from "node:fs";
import { join, basename } from "node:path";
import { validateDigest, type SessionDigest } from "./schema";
import { sessionSearchHome } from "../utils";

// ─── Paths ───────────────────────────────────────────────────────────────────
//
// DIGEST_DIR is computed lazily so tests can override process.env.HOME (or
// PI_SESSION_SEARCH_HOME) before calling any storage function and get an
// isolated temp directory.

function getDigestDir(): string {
	return join(sessionSearchHome(), "digests");
}

function ensureDir(): void {
	mkdirSync(getDigestDir(), { recursive: true });
}

/** Absolute path to the digest file for a session. */
export function digestPath(sessionId: string): string {
	return join(getDigestDir(), `${sessionId}.json`);
}

// ─── Digest I/O ──────────────────────────────────────────────────────────────

/** Load and validate a digest. Returns null if missing or invalid. */
export function loadDigest(sessionId: string): SessionDigest | null {
	const p = digestPath(sessionId); // digestPath calls getDigestDir() lazily
	if (!existsSync(p)) return null;
	try {
		const obj = JSON.parse(readFileSync(p, "utf-8"));
		return validateDigest(obj);
	} catch {
		return null;
	}
}

/**
 * Atomically save a digest (write to .tmp, then rename).
 * Creates the digests directory if it doesn't exist.
 */
export function saveDigest(sessionId: string, digest: SessionDigest): void {
	ensureDir();
	const p = digestPath(sessionId);
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, JSON.stringify(digest, null, 2), "utf-8");
	renameSync(tmp, p);
}

/** List all session IDs that have a stored digest. */
export function listDigestedSessionIds(): string[] {
	const dir = getDigestDir();
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json") && !f.endsWith(".state.json"))
			.map((f) => basename(f, ".json"));
	} catch {
		return [];
	}
}

// ─── Builder state persistence ────────────────────────────────────────────────
//
// The builder tracks incremental-prompt anchors in memory (BuilderState in
// builder.ts).  To survive process restarts, the anchors are persisted as a
// sibling <id>.state.json file.  On session_start, the lifecycle reloads the
// state so the next agent_end doesn't treat everything as a fresh session.

export interface BuilderStateOnDisk {
	convTokensAtLastWrite: number;
	lastWrittenMessageIndex: number;
	lastWrittenSummaryIndex: number;
}

/** Absolute path to the builder-state file for a session. */
export function statePath(sessionId: string): string {
	return join(getDigestDir(), `${sessionId}.state.json`);
}

/** Load persisted builder state. Returns null if missing or malformed. */
export function loadBuilderState(sessionId: string): BuilderStateOnDisk | null {
	const p = statePath(sessionId);
	if (!existsSync(p)) return null;
	try {
		const obj = JSON.parse(readFileSync(p, "utf-8"));
		if (
			obj != null &&
			typeof obj.convTokensAtLastWrite === "number" &&
			typeof obj.lastWrittenMessageIndex === "number" &&
			typeof obj.lastWrittenSummaryIndex === "number"
		) {
			return obj as BuilderStateOnDisk;
		}
		return null;
	} catch {
		return null;
	}
}

/** Atomically save builder state (write to .tmp, then rename). */
export function saveBuilderState(
	sessionId: string,
	state: BuilderStateOnDisk,
): void {
	ensureDir();
	const p = statePath(sessionId);
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
	renameSync(tmp, p);
}

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Test isolation ───────────────────────────────────────────────────────────
//
// storage.ts computes DIGEST_DIR lazily from process.env.HOME, so overriding
// HOME before calling any storage function redirects all I/O to a temp dir.
// Static imports are fine here — no top-level await required.

import {
	digestPath,
	loadDigest,
	saveDigest,
	listDigestedSessionIds,
	statePath,
	loadBuilderState,
	saveBuilderState,
} from "../../digest/storage";

const testHome = join(tmpdir(), `pi-storage-test-${process.pid}`);
const testDigestDir = join(testHome, ".pi", "session-search", "digests");

let originalHome: string | undefined;

before(() => {
	originalHome = process.env.HOME;
	process.env.HOME = testHome;
	mkdirSync(testDigestDir, { recursive: true });
});

after(() => {
	process.env.HOME = originalHome;
	rmSync(testHome, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDigest(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1 as const,
		body: "Session body text with enough content to be valid.",
		headline: "Test session",
		topics: ["test"],
		generatedAt: "2026-04-29T10:00:00Z",
		modelId: "openai/gpt-5.4-mini",
		inputTokenCount: 100,
		cost: 0.0005,
		...overrides,
	};
}

// ─── digestPath ───────────────────────────────────────────────────────────────

describe("digestPath", () => {
	it("returns a path ending in <id>.json", () => {
		const p = digestPath("abc-123");
		assert.ok(p.endsWith("abc-123.json"));
	});

	it("is inside the digests directory under HOME", () => {
		const p = digestPath("some-id");
		assert.ok(p.startsWith(testHome), `expected ${p} to start with ${testHome}`);
		assert.ok(p.includes("session-search"));
		assert.ok(p.includes("digests"));
	});
});

// ─── loadDigest / saveDigest ──────────────────────────────────────────────────

describe("loadDigest", () => {
	it("returns null for a missing file", () => {
		assert.equal(loadDigest("nonexistent-id-xyz"), null);
	});

	it("returns null for a corrupt JSON file", () => {
		const p = digestPath("corrupt-id");
		writeFileSync(p, "not json {{{", "utf-8");
		assert.equal(loadDigest("corrupt-id"), null);
	});

	it("returns null for a file with invalid schema", () => {
		const p = digestPath("invalid-schema-id");
		writeFileSync(p, JSON.stringify({ schemaVersion: 99, body: "" }), "utf-8");
		assert.equal(loadDigest("invalid-schema-id"), null);
	});
});

describe("saveDigest + loadDigest roundtrip", () => {
	it("round-trips a valid digest", () => {
		const digest = makeDigest();
		saveDigest("roundtrip-id", digest as any);
		const loaded = loadDigest("roundtrip-id");
		assert.ok(loaded !== null);
		assert.equal(loaded!.headline, "Test session");
		assert.equal(loaded!.schemaVersion, 1);
	});

	it("atomic write: no leftover .tmp file on success", () => {
		const p = digestPath("atomic-id");
		saveDigest("atomic-id", makeDigest() as any);
		assert.ok(!existsSync(`${p}.tmp`));
		assert.ok(existsSync(p));
	});

	it("overwrites an existing digest", () => {
		saveDigest("overwrite-id", makeDigest({ headline: "First" }) as any);
		saveDigest("overwrite-id", makeDigest({ headline: "Second" }) as any);
		const loaded = loadDigest("overwrite-id");
		assert.equal(loaded!.headline, "Second");
	});
});

// ─── listDigestedSessionIds ───────────────────────────────────────────────────

describe("listDigestedSessionIds", () => {
	it("returns an empty array when the digests directory does not exist", () => {
		const savedHome = process.env.HOME;
		const emptyHome = join(tmpdir(), `pi-list-empty-${Date.now()}`);
		process.env.HOME = emptyHome;
		// Don't create the directory — must handle gracefully
		const ids = listDigestedSessionIds();
		process.env.HOME = savedHome;
		assert.deepEqual(ids, []);
	});

	it("excludes .state.json files from the list", () => {
		// Write a state file — it must not appear in digest IDs
		const stateP = statePath("state-only-id");
		writeFileSync(
			stateP,
			JSON.stringify({ convTokensAtLastWrite: 0, lastWrittenMessageIndex: 0, lastWrittenSummaryIndex: 0 }),
			"utf-8",
		);
		const ids = listDigestedSessionIds();
		assert.ok(!ids.includes("state-only-id"));
	});

	it("includes session IDs that have .json files", () => {
		saveDigest("listed-session-id", makeDigest() as any);
		const ids = listDigestedSessionIds();
		assert.ok(ids.includes("listed-session-id"), `expected listed-session-id in: ${ids}`);
	});
});

// ─── Builder state persistence ────────────────────────────────────────────────

describe("loadBuilderState", () => {
	it("returns null for missing file", () => {
		assert.equal(loadBuilderState("missing-state-id"), null);
	});

	it("returns null for corrupt file", () => {
		const p = statePath("corrupt-state-id");
		writeFileSync(p, "!!!bad json", "utf-8");
		assert.equal(loadBuilderState("corrupt-state-id"), null);
	});

	it("returns null for file with wrong field types", () => {
		const p = statePath("wrong-types-id");
		writeFileSync(
			p,
			JSON.stringify({ convTokensAtLastWrite: "nope", lastWrittenMessageIndex: 0, lastWrittenSummaryIndex: 0 }),
			"utf-8",
		);
		assert.equal(loadBuilderState("wrong-types-id"), null);
	});
});

describe("saveBuilderState + loadBuilderState roundtrip", () => {
	it("round-trips a valid state", () => {
		const state = {
			convTokensAtLastWrite: 1234,
			lastWrittenMessageIndex: 7,
			lastWrittenSummaryIndex: 2,
		};
		saveBuilderState("state-rt-id", state);
		const loaded = loadBuilderState("state-rt-id");
		assert.ok(loaded !== null);
		assert.equal(loaded!.convTokensAtLastWrite, 1234);
		assert.equal(loaded!.lastWrittenMessageIndex, 7);
		assert.equal(loaded!.lastWrittenSummaryIndex, 2);
	});

	it("atomic write: no leftover .tmp on success", () => {
		const p = statePath("atomic-state-id");
		saveBuilderState("atomic-state-id", {
			convTokensAtLastWrite: 0,
			lastWrittenMessageIndex: 0,
			lastWrittenSummaryIndex: 0,
		});
		assert.ok(!existsSync(`${p}.tmp`));
		assert.ok(existsSync(p));
	});
});

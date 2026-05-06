/**
 * Task 6.10: Fixture-pinned regression tests for raw modes.
 *
 * These tests lock the byte-identical output of buildContent(session, "fts-raw")
 * and buildEmbeddingText(session, "hybrid-raw") so that future digest-mode
 * changes cannot silently regress the raw-content paths.
 *
 * Baselines were captured by running the functions on the synthetic fixture
 * below and recording the exact output strings.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSession } from "../parser";
import { buildContent } from "../index/fts-index";
import { buildEmbeddingText } from "../index/session-index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = join(
	__dirname,
	"fixtures/raw-mode-fixtures/fixture-session-001.jsonl",
);

// ─── Captured baselines ───────────────────────────────────────────────────────
//
// To update: delete these strings, run the functions on the fixture, and paste
// the output back. Any change to these baselines requires an explicit decision
// to accept the regression.

const EXPECTED_FTS_CONTENT =
	"JWT Auth Refactor\n\n" +
	"Refactor the authentication module to use JWT tokens\n" +
	"Also update the middleware to validate the tokens properly\n" +
	"Can you also add unit tests for the new JWT validation logic?\n" +
	"Run the test suite and fix any failures\n\n" +
	"Refactored auth module to use JWT tokens, updated middleware validation, and added unit tests covering expiry, signature, and claims validation.";

const EXPECTED_EMB_TEXT =
	"JWT Auth Refactor\n\n" +
	"Refactor the authentication module to use JWT tokens\n" +
	"Also update the middleware to validate the tokens properly\n" +
	"Can you also add unit tests for the new JWT validation logic?\n" +
	"Run the test suite and fix any failures\n\n" +
	"Assistant:\n" +
	"I'll start by examining the current auth module.\n" +
	"I'll update the middleware now.\n" +
	"Added comprehensive unit tests for the JWT validation. The tests cover token expiry, invalid signatures, and missing claims.\n" +
	"All 24 tests pass. The JWT auth module is complete.\n\n" +
	"\n" +
	"Refactored auth module to use JWT tokens, updated middleware validation, and added unit tests covering expiry, signature, and claims validation.\n\n" +
	"Project: unknown\n\n" +
	"CWD: /home/user/myproject";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("raw-mode regression (task 6.10)", () => {
	it("parses fixture cleanly", () => {
		const session = parseSession(FIXTURE_FILE, false);
		assert.ok(session, "fixture-session-001.jsonl must parse successfully");
		assert.equal(session.id, "fixture-session-001");
		assert.equal(session.name, "JWT Auth Refactor");
		assert.equal(session.userMessageCount, 4);
		assert.equal(session.compactionSummaries.length, 1);
	});

	it("buildContent(session, 'fts-raw') is byte-identical to baseline", () => {
		const session = parseSession(FIXTURE_FILE, false)!;
		const result = buildContent(session, "fts-raw");
		assert.equal(
			result,
			EXPECTED_FTS_CONTENT,
			"fts-raw content must be byte-identical to captured baseline",
		);
	});

	it("buildContent(session) [no mode arg] is byte-identical to fts-raw baseline", () => {
		// Backward-compat: calling without mode should behave like fts-raw
		const session = parseSession(FIXTURE_FILE, false)!;
		const result = buildContent(session);
		assert.equal(
			result,
			EXPECTED_FTS_CONTENT,
			"no-mode call must match fts-raw baseline",
		);
	});

	it("buildEmbeddingText(session, 'hybrid-raw') is byte-identical to baseline", () => {
		const session = parseSession(FIXTURE_FILE, false)!;
		const result = buildEmbeddingText(session, "hybrid-raw", null);
		assert.equal(
			result,
			EXPECTED_EMB_TEXT,
			"hybrid-raw embedding text must be byte-identical to captured baseline",
		);
	});

	it("buildContent returns digest.body in digest-mode", () => {
		const session = parseSession(FIXTURE_FILE, false)!;
		const fakeDigest = {
			schemaVersion: 1 as const,
			body: "This is the digest body.",
			headline: "Digest Headline",
			topics: ["auth", "jwt"],
			generatedAt: "2026-01-15T10:00:00Z",
			modelId: "test/model",
			inputTokenCount: 100,
			cost: 0.001,
		};
		const result = buildContent(session, "digest-mode", fakeDigest);
		assert.equal(result, "This is the digest body.");
	});

	it("buildEmbeddingText returns digest.body in digest-mode", () => {
		const session = parseSession(FIXTURE_FILE, false)!;
		const fakeDigest = {
			schemaVersion: 1 as const,
			body: "Embedding body from digest.",
			headline: "Headline",
			topics: [],
			generatedAt: "2026-01-15T10:00:00Z",
			modelId: "test/model",
			inputTokenCount: 50,
			cost: 0.0005,
		};
		const result = buildEmbeddingText(session, "digest-mode", fakeDigest);
		assert.equal(result, "Embedding body from digest.");
	});

	it("buildEmbeddingText falls back to raw in digest-mode with no digest", () => {
		const session = parseSession(FIXTURE_FILE, false)!;
		const result = buildEmbeddingText(session, "digest-mode", null);
		// Should match hybrid-raw baseline (falls back to raw concat)
		assert.equal(
			result,
			EXPECTED_EMB_TEXT,
			"digest-mode with null digest must fall back to raw concat",
		);
	});
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateDigest, submitDigestTool, DigestArgs } from "../../digest/schema";
import { Value } from "@sinclair/typebox/value";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validDigest(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1 as const,
		body: "This session involved refactoring the authentication module.",
		headline: "Auth module refactor",
		topics: ["auth", "refactor"],
		generatedAt: "2026-04-29T12:00:00Z",
		modelId: "openai/gpt-5.4-mini",
		inputTokenCount: 500,
		cost: 0.001,
		...overrides,
	};
}

// ─── validateDigest ───────────────────────────────────────────────────────────

describe("validateDigest", () => {
	it("accepts a minimal valid digest", () => {
		const result = validateDigest(validDigest());
		assert.ok(result !== null);
		assert.equal(result!.schemaVersion, 1);
		assert.equal(result!.headline, "Auth module refactor");
	});

	it("accepts digest with optional outcome", () => {
		const d = validDigest({ outcome: "Refactoring complete." });
		assert.ok(validateDigest(d) !== null);
	});

	it("accepts digest without outcome (optional)", () => {
		const d = validDigest();
		delete (d as any).outcome;
		assert.ok(validateDigest(d) !== null);
	});

	it("accepts headline at exactly 80 chars", () => {
		const headline = "A".repeat(80);
		assert.ok(validateDigest(validDigest({ headline })) !== null);
	});

	it("rejects headline longer than 80 chars", () => {
		const headline = "A".repeat(81);
		assert.equal(validateDigest(validDigest({ headline })), null);
	});

	it("rejects empty headline", () => {
		assert.equal(validateDigest(validDigest({ headline: "" })), null);
	});

	it("rejects empty body", () => {
		assert.equal(validateDigest(validDigest({ body: "" })), null);
	});

	it("rejects wrong schemaVersion", () => {
		assert.equal(validateDigest(validDigest({ schemaVersion: 2 })), null);
	});

	it("rejects missing schemaVersion", () => {
		const d = validDigest();
		delete (d as any).schemaVersion;
		assert.equal(validateDigest(d), null);
	});

	it("rejects topics array with more than 5 items", () => {
		const topics = ["a", "b", "c", "d", "e", "f"];
		assert.equal(validateDigest(validDigest({ topics })), null);
	});

	it("accepts topics array with exactly 5 items", () => {
		const topics = ["a", "b", "c", "d", "e"];
		assert.ok(validateDigest(validDigest({ topics })) !== null);
	});

	it("accepts empty topics array", () => {
		assert.ok(validateDigest(validDigest({ topics: [] })) !== null);
	});

	it("rejects a topic tag longer than 32 chars", () => {
		const topics = ["a".repeat(33)];
		assert.equal(validateDigest(validDigest({ topics })), null);
	});

	it("rejects negative cost", () => {
		assert.equal(validateDigest(validDigest({ cost: -0.001 })), null);
	});

	it("rejects negative inputTokenCount", () => {
		assert.equal(validateDigest(validDigest({ inputTokenCount: -1 })), null);
	});

	it("rejects null", () => {
		assert.equal(validateDigest(null), null);
	});

	it("rejects a plain string", () => {
		assert.equal(validateDigest("not an object"), null);
	});

	it("rejects outcome longer than 200 chars", () => {
		const outcome = "x".repeat(201);
		assert.equal(validateDigest(validDigest({ outcome })), null);
	});

	it("accepts outcome at exactly 200 chars", () => {
		const outcome = "x".repeat(200);
		assert.ok(validateDigest(validDigest({ outcome })) !== null);
	});
});

// ─── submitDigestTool ──────────────────────────────────────────────────────────

describe("submitDigestTool", () => {
	it("has name 'submit_digest'", () => {
		assert.equal(submitDigestTool.name, "submit_digest");
	});

	it("has a non-empty description", () => {
		assert.ok(submitDigestTool.description.length > 0);
	});

	it("accepts valid tool arguments", () => {
		const args = {
			body: "x".repeat(50),
			headline: "Test headline",
			topics: ["test"],
		};
		assert.ok(Value.Check(DigestArgs, args));
	});

	it("rejects body shorter than 50 chars", () => {
		const args = { body: "short", headline: "H", topics: [] };
		assert.ok(!Value.Check(DigestArgs, args));
	});

	it("rejects headline over 80 chars", () => {
		const args = { body: "x".repeat(50), headline: "H".repeat(81), topics: [] };
		assert.ok(!Value.Check(DigestArgs, args));
	});

	it("rejects more than 5 topics", () => {
		const args = {
			body: "x".repeat(50),
			headline: "H",
			topics: ["a", "b", "c", "d", "e", "f"],
		};
		assert.ok(!Value.Check(DigestArgs, args));
	});
});

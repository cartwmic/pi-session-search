import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";

// ─── Setup: redirect HOME so real ~/.pi is untouched ─────────────────

const TMP_ROOT = join(import.meta.dirname ?? __dirname, "__tmp_digest_config__");
const FAKE_HOME = join(TMP_ROOT, "home");
const FAKE_CWD = join(TMP_ROOT, "project");
const GLOBAL_DIGEST_DIR = join(FAKE_HOME, ".pi", "session-search");
const GLOBAL_DIGEST_FILE = join(GLOBAL_DIGEST_DIR, "digest.json");
const PROJECT_DIGEST_DIR = join(FAKE_CWD, ".pi", "session-search");
const PROJECT_DIGEST_FILE = join(PROJECT_DIGEST_DIR, "digest.json");

let originalHome: string | undefined;

before(() => {
	originalHome = process.env.HOME;
	mkdirSync(FAKE_HOME, { recursive: true });
	mkdirSync(FAKE_CWD, { recursive: true });
	process.env.HOME = FAKE_HOME;
});

after(() => {
	process.env.HOME = originalHome;
	rmSync(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
	// Clean slate: remove any config files written by a prior test
	rmSync(GLOBAL_DIGEST_DIR, { recursive: true, force: true });
	rmSync(PROJECT_DIGEST_DIR, { recursive: true, force: true });
});

// Lazy-load so HOME override is in place before the module resolves its path constant.
async function load() {
	// Use a unique query-string timestamp to bust the module cache on repeated imports
	// (node:test runs in the same process, so we need cache-busting).
	const ts = Date.now() + Math.random();
	const { loadDigestConfig, saveDigestConfig, getDigestConfigPath } = await import(
		`../../digest/config.ts?t=${ts}`
	);
	return { loadDigestConfig, saveDigestConfig, getDigestConfigPath } as {
		loadDigestConfig: (cwd: string) => import("../../digest/config.ts").DigestConfig;
		saveDigestConfig: (config: import("../../digest/config.ts").DigestConfig) => void;
		getDigestConfigPath: () => string;
	};
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("loadDigestConfig", () => {
	it("returns defaults when no config files exist", async () => {
		const { loadDigestConfig } = await load();
		const cfg = loadDigestConfig(FAKE_CWD);

		assert.equal(cfg.debounceSeconds, 60);
		assert.equal(cfg.resummarizeTokenThreshold, 10000);
		assert.equal(cfg.maxTokens, 1500);
		assert.equal(cfg.showWidget, false);
		assert.equal(cfg.verbose, false);
		assert.equal(cfg.provider, undefined);
		assert.equal(cfg.model, undefined);
	});

	it("applies global config over defaults", async () => {
		mkdirSync(GLOBAL_DIGEST_DIR, { recursive: true });
		writeFileSync(GLOBAL_DIGEST_FILE, JSON.stringify({ debounceSeconds: 120, verbose: true }), "utf8");

		const { loadDigestConfig } = await load();
		const cfg = loadDigestConfig(FAKE_CWD);

		assert.equal(cfg.debounceSeconds, 120);
		assert.equal(cfg.verbose, true);
		// Untouched defaults
		assert.equal(cfg.maxTokens, 1500);
		assert.equal(cfg.showWidget, false);
	});

	it("merges project config on top of global config", async () => {
		mkdirSync(GLOBAL_DIGEST_DIR, { recursive: true });
		writeFileSync(GLOBAL_DIGEST_FILE, JSON.stringify({ debounceSeconds: 60, verbose: false }), "utf8");

		mkdirSync(PROJECT_DIGEST_DIR, { recursive: true });
		writeFileSync(PROJECT_DIGEST_FILE, JSON.stringify({ debounceSeconds: 30, model: "gpt-5.4-mini" }), "utf8");

		const { loadDigestConfig } = await load();
		const cfg = loadDigestConfig(FAKE_CWD);

		// Project overrides global
		assert.equal(cfg.debounceSeconds, 30);
		assert.equal(cfg.model, "gpt-5.4-mini");
		// Global value preserved where project doesn't override
		assert.equal(cfg.verbose, false);
		// Default still applies where neither overrides
		assert.equal(cfg.maxTokens, 1500);
	});

	it("project-only field override: global absent", async () => {
		mkdirSync(PROJECT_DIGEST_DIR, { recursive: true });
		writeFileSync(PROJECT_DIGEST_FILE, JSON.stringify({ resummarizeTokenThreshold: 5000 }), "utf8");

		const { loadDigestConfig } = await load();
		const cfg = loadDigestConfig(FAKE_CWD);

		assert.equal(cfg.resummarizeTokenThreshold, 5000);
		assert.equal(cfg.debounceSeconds, 60); // default
	});

	/**
	 * Capture warnings emitted by src/log.ts during a fresh module load.
	 *
	 * The logger constructs its destination at import time from
	 * PI_SESSION_SEARCH_LOG_SYNC_FILE (test-only sync sink, no rotation, no
	 * buffering). We point it at a per-test file, force a cache-busting reload
	 * of `loadDigestConfig`, then read records back synchronously.
	 */
	async function loadAndCaptureLogs(): Promise<{
		loadDigestConfig: typeof import("../../digest/config").loadDigestConfig;
		readLog: () => string;
	}> {
		const logFile = join(TMP_ROOT, `log-${Date.now()}-${Math.random()}.jsonl`);
		process.env.PI_SESSION_SEARCH_LOG_SYNC_FILE = logFile;
		// Force log.ts to rebuild its destination on next emit so this test gets
		// a fresh sync sink rather than the cached production rotating-file sink.
		process.env.PI_SESSION_SEARCH_LOG_RESET = "1";
		const mod = await load();
		return {
			loadDigestConfig: mod.loadDigestConfig,
			readLog: () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : ""),
		};
	}

	it("malformed global JSON falls back to defaults and warns", async () => {
		mkdirSync(GLOBAL_DIGEST_DIR, { recursive: true });
		writeFileSync(GLOBAL_DIGEST_FILE, "{ this is not json }", "utf8");

		const { loadDigestConfig, readLog } = await loadAndCaptureLogs();
		const cfg = loadDigestConfig(FAKE_CWD);

		assert.equal(cfg.debounceSeconds, 60);
		assert.equal(cfg.maxTokens, 1500);
		assert.ok(
			readLog().includes("malformed"),
			"expected a malformed-config warning in session-search log",
		);
	});

	it("malformed project JSON falls back to defaults (global only) and warns", async () => {
		mkdirSync(GLOBAL_DIGEST_DIR, { recursive: true });
		writeFileSync(GLOBAL_DIGEST_FILE, JSON.stringify({ debounceSeconds: 90 }), "utf8");

		mkdirSync(PROJECT_DIGEST_DIR, { recursive: true });
		writeFileSync(PROJECT_DIGEST_FILE, "not-valid-json", "utf8");

		const { loadDigestConfig, readLog } = await loadAndCaptureLogs();
		const cfg = loadDigestConfig(FAKE_CWD);

		// Global still applies; project malformed = ignored
		assert.equal(cfg.debounceSeconds, 90);
		assert.equal(cfg.maxTokens, 1500);
		assert.ok(readLog().includes("malformed"));
	});
});

describe("saveDigestConfig", () => {
	it("writes the global file atomically and reads back correctly", async () => {
		const { saveDigestConfig, loadDigestConfig } = await load();

		const config = {
			debounceSeconds: 45,
			resummarizeTokenThreshold: 8000,
			maxTokens: 2000,
			showWidget: true,
			verbose: true,
			provider: "anthropic",
			model: "claude-haiku-4-5",
		};

		saveDigestConfig(config);
		assert.ok(existsSync(GLOBAL_DIGEST_FILE), "global file should exist after save");

		const cfg = loadDigestConfig(FAKE_CWD);
		assert.equal(cfg.debounceSeconds, 45);
		assert.equal(cfg.resummarizeTokenThreshold, 8000);
		assert.equal(cfg.maxTokens, 2000);
		assert.equal(cfg.showWidget, true);
		assert.equal(cfg.verbose, true);
		assert.equal(cfg.provider, "anthropic");
		assert.equal(cfg.model, "claude-haiku-4-5");
	});

	it("creates the parent directory if it does not exist", async () => {
		const { saveDigestConfig } = await load();

		assert.ok(!existsSync(GLOBAL_DIGEST_DIR), "dir should not exist before save");

		saveDigestConfig({
			debounceSeconds: 60,
			resummarizeTokenThreshold: 10000,
			maxTokens: 1500,
			showWidget: false,
			verbose: false,
		});

		assert.ok(existsSync(GLOBAL_DIGEST_FILE), "global file should exist after save");
	});
});

describe("getDigestConfigPath", () => {
	it("returns a path under HOME/.pi/session-search", async () => {
		const { getDigestConfigPath } = await load();
		const p = getDigestConfigPath();
		assert.ok(p.includes(".pi"), "path should include .pi");
		assert.ok(p.endsWith("digest.json"), "path should end with digest.json");
	});
});

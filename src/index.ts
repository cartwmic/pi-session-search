import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Config / index infrastructure ──────────────────────────────────────────
import { loadConfig, saveConfig, getConfigPath, getIndexDir } from "./config";
import type { Config } from "./config";
import type { EmbedderConfig } from "./embedder";
import { createEmbedder } from "./embedder";
import { SessionIndex, migrateIndexFileIfStale } from "./index/session-index";
import type { MigrationMetadata } from "./index/session-index";
import { FtsSessionIndex } from "./index/fts-index";
import { resolveModeVerdict } from "./index/mode";
import type { Verdict } from "./index/mode";

// ── Digest modules ──────────────────────────────────────────────────────────
import {
	loadDigestConfig,
	saveDigestConfig,
	getDigestConfigPath,
} from "./digest/config";
import type { DigestConfig } from "./digest/config";
import { resolveModel } from "./digest/model-resolver";
import { pickDigestModel } from "./digest/model-picker";
import { loadDigest, saveDigest, loadBuilderState, saveBuilderState } from "./digest/storage";
import type { SessionDigest } from "./digest/schema";
import {
	generateDigest,
	emptyBuilderState,
} from "./digest/builder";
import { resolveHostCompleteFn } from "./digest/completion";
import type { CompleteFn, HostModelRegistry } from "./digest/completion";
import {
	liveConversationView,
	parsedConversationView,
} from "./digest/conversation-view";
import { installDigestLifecycle } from "./digest/lifecycle";
import type { LifecycleHandle } from "./digest/lifecycle";
import { emptyRollup, format as formatCost } from "./digest/cost-tracker";
import type { CostRollup } from "./digest/cost-tracker";
import { runBackfill, runBackfillDryRun } from "./digest/backfill";

// ── Parser / reader ──────────────────────────────────────────────────────────
import {
	discoverSessionFiles,
	parseSession,
	readSessionId,
} from "./parser";
import { readSessionConversation } from "./reader";

// ── Search overlay ────────────────────────────────────────────────────────────
import { registerFindSessionCommand } from "./search/overlay";

// ── Utilities ──────────────────────────────────────────────────────────────
import { truncate, pathToSlug, formatRelativeDate } from "./utils";
import { log, getLogPath } from "./log";

type AnyIndex = SessionIndex | FtsSessionIndex;

export default function (pi: ExtensionAPI) {
	// One-time startup log so users can confirm the logger is alive and find
	// the active log file. Extension load happens once per pi process.
	log.info({ comp: "extension", logPath: getLogPath() }, "pi-session-search loaded");

	// ── Module-level state (tasks 2.3, 2.6) ─────────────────────────────────
	let sessionIndex: AnyIndex | null = null;
	let currentConfig: Config | null = null;
	let currentVerdict: Verdict | null = null;
	let bootGeneration = 0;
let lifecycleGen = 0;
	let lifecycleHandle: LifecycleHandle | null = null;
	let currentDigestConfig: DigestConfig = loadDigestConfig(process.cwd());
let currentRollup: CostRollup = emptyRollup();
	let lastCwd: string = process.cwd();
	let syncTimer: ReturnType<typeof setInterval> | null = null;

	const SYNC_INTERVAL_MS = 5 * 60 * 1000;
	const DIGEST_DISABLED_STATUS = "Digest disabled: run /session:summarizer";
	const DIGEST_DISABLED_MESSAGE =
		"Digest disabled: run /session:summarizer to configure a model. FTS session search remains available.";

	// ── Cost tracker adapter for lifecycle ────────────────────────────────────
	const lifecycleCostTracker = {
		record(digest: SessionDigest): void {
			currentRollup = {
				calls: currentRollup.calls + 1,
				tokensIn: currentRollup.tokensIn + digest.inputTokenCount,
				tokensOut: currentRollup.tokensOut,
				cost: {
					...currentRollup.cost,
					total: currentRollup.cost.total + (digest.cost ?? 0),
				},
			};
		},
	};

	// ── indexAddDigested: lifecycle → SessionIndex bridge ─────────────────────
	function indexAddDigested(
		sessionId: string,
		digest: SessionDigest,
		opts?: { batched: boolean },
	): void {
		if (!(sessionIndex instanceof SessionIndex)) return;
		const stored = sessionIndex.get(sessionId);
		if (stored) {
			void sessionIndex
				.addDigested(sessionId, stored.session, digest, opts)
				.catch((err) =>
					log.error({ comp: "indexAddDigested", sessionId, err: String(err?.message ?? err) }, "addDigested failed"),
				);
			return;
		}
		const files = discoverSessionFiles(
			currentConfig?.extraSessionDirs ?? [],
			currentConfig?.extraArchiveDirs ?? [],
		);
		for (const { file, archived } of files) {
			if (readSessionId(file) === sessionId) {
				const parsed = parseSession(file, archived);
				if (parsed) {
					void sessionIndex
						.addDigested(sessionId, parsed, digest, opts)
						.catch((err) =>
							log.error({ comp: "indexAddDigested", sessionId, err: String(err?.message ?? err) }, "addDigested failed (post-scan)"),
						);
				}
				break;
			}
		}
	}


	// ── Session primer (task 2.9) — no longer uses currentMode ────────────────
	pi.on("before_agent_start", async (event, ctx) => {
		if (!sessionIndex || sessionIndex.size() === 0) return;

		try {
			const cwd = ctx.cwd || "";
			const projectSlug = cwd ? pathToSlug(cwd) : undefined;

			let sessions = sessionIndex.list({ project: projectSlug, limit: 5 });
			if (sessions.length === 0 && projectSlug) {
				sessions = sessionIndex.list({ limit: 5 });
			}
			if (sessions.length === 0) return;

			const lines = sessions.map((s) => {
				let name: string;
				if (currentVerdict?.kind === "digest-hybrid" && sessionIndex instanceof SessionIndex) {
					const digest = sessionIndex.getDigest(s.id);
					name = digest ? digest.headline : truncate(s.firstUserMessage, 80);
				} else {
					name = s.name || truncate(s.firstUserMessage, 80);
				}
				const date = s.startedAt.split("T")[0];
				const rel = formatRelativeDate(s.startedAt);
				const displayCwd = s.cwd.replace(process.env.HOME || "", "~").slice(0, 60);
				const msgs = `${s.userMessageCount} user, ${s.assistantMessageCount} assistant`;
				const modelTag = s.models[0] ? ` Mode: ${s.models[0].split("/").pop()}` : "";
				return `- **${rel}**: **${name}** (${date}) Project: ${s.projectSlug} | CWD: ${displayCwd} Messages: ${msgs}${modelTag}`;
			});

			const primer = `\n\n## Recent Sessions (this project)\n${lines.join("\n")}\n`;
			const trimmed = primer.length > 1500 ? primer.slice(0, 1500) + "\n" : primer;
			return { systemPrompt: (event.systemPrompt || "") + trimmed };
		} catch {
			return undefined;
		}
	});

	// ── session_start (task 2.4 — 10-step procedure) ─────────────────────────
	// Registered BEFORE lifecycle so verdict resolution runs first (task 2.5).

	pi.on("session_start", async (_event, ctx) => {
		const myGen = ++bootGeneration;
		lastCwd = ctx.cwd || process.cwd();

		// Step 1: load config
		try {
			currentConfig = loadConfig();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`session-search: ${msg}`, "warning");
		}

		// Step 2: migration (data-plane only — task 2.4a)
		let migrationMeta: MigrationMetadata = { kind: "noop", didMigrate: false };
		try {
			migrationMeta = migrateIndexFileIfStale(getIndexDir());
		} catch {
			// migration failures are internal; index construction will handle
		}

		// Step 3: create embedder (synchronous; legacy-rejection notify fires inside)
		currentDigestConfig = loadDigestConfig(lastCwd);
		const digestConfigured = Boolean(
			currentDigestConfig.provider && currentDigestConfig.model,
		);
		ctx.ui.setStatus(
			"session-digest",
			digestConfigured ? "" : DIGEST_DISABLED_STATUS,
		);
		const embedder = currentConfig?.embedder
			? createEmbedder(currentConfig.embedder, (msg, level) =>
					ctx.ui.notify(msg, level as any),
				)
			: null;

		// Step 4: resolve verdict (may take ~1000ms for registry-retry path)
		const verdict = await resolveModeVerdict(currentConfig, () =>
			ctx.modelRegistry.getAvailable(),
			{
				embedderAvailable: embedder !== null,
				digestConfig: currentDigestConfig,
				cwd: lastCwd,
			},
		);

		// Step 5: generation guard — a newer session_start overtook this one
		if (myGen !== bootGeneration) return;

		// Step 6: assign verdict
		currentVerdict = verdict;

		// Step 7: dispose prior index (abort in-flight embedder + close FtsSide)
		if (sessionIndex) {
			if (sessionIndex instanceof SessionIndex) {
				sessionIndex.dispose();
			} else {
				sessionIndex.close();
			}
			sessionIndex = null;
		}

		// Step 8: migration notify resolver (post-verdict — task 2.4a)
		if (migrationMeta.didMigrate) {
			ctx.ui.notify(
				`session-search: index version ${migrationMeta.migratedFrom} is incompatible; reset to v4. Run /session:backfill to repopulate.`,
				"info",
			);
		}

		// Step 9: misconfigured → setStatus + notify + console.error, return
		if (verdict.kind === "misconfigured") {
			ctx.ui.setStatus("session-search", verdict.statusLine);
			ctx.ui.notify(verdict.notifyMessage, "error");
			console.error(verdict.notifyMessage);
			lifecycleHandle?.deactivate();
			return;
		}

		// Step 10: construct new index + kick sync with generation guard
		if (verdict.kind === "digest-hybrid" && embedder) {
			sessionIndex = new SessionIndex(
				embedder,
				getIndexDir(),
				currentConfig?.extraSessionDirs ?? [],
				currentConfig?.extraArchiveDirs ?? [],
				"digest-hybrid",
			);
		} else {
			sessionIndex = new FtsSessionIndex(
				getIndexDir(),
				currentConfig?.extraSessionDirs ?? [],
				currentConfig?.extraArchiveDirs ?? [],
			);
		}

		await sessionIndex.load(
			verdict.kind === "digest-hybrid" // only SessionIndex needs notify for mode transitions
				? (msg, level) => ctx.ui.notify(msg, level as any)
				: undefined,
			currentConfig?.embedder,
		);

		// Fire-and-forget initial sync with generation guard (task 2.6)
		const syncGen = bootGeneration;
		const SYNC_TIMEOUT_MS = 600_000;
		Promise.race([
			sessionIndex.sync((msg) => ctx.ui.setStatus("session-search", msg)),
			new Promise<null>((r) => setTimeout(() => r(null), SYNC_TIMEOUT_MS)),
		])
			.then((syncResult) => {
				if (syncGen !== bootGeneration) return; // stale — task 2.6
				if (syncResult === null) {
					ctx.ui.notify(
						"session-search: sync timed out (index may be stale)",
						"warning",
					);
					ctx.ui.setStatus("session-search", "");
				} else {
					const { added, updated, removed, moved } = syncResult;
					const changes = added + updated + removed + moved;
					if (changes > 0) {
						const parts: string[] = [];
						if (added) parts.push(`+${added}`);
						if (updated) parts.push(`~${updated}`);
						if (removed) parts.push(`-${removed}`);
						if (moved) parts.push(`↗${moved} moved`);
						ctx.ui.setStatus(
							"session-search",
							`Sessions: ${parts.join(" ")} (${sessionIndex!.size()} total)`,
						);
						if (syncGen === bootGeneration) {
							setTimeout(() => {
								if (syncGen !== bootGeneration) return; // stale guard
								ctx.ui.setStatus("session-search", "");
							}, 5000);
						}
					} else {
						if (syncGen === bootGeneration) {
							ctx.ui.setStatus("session-search", "");
						}
					}
				}
			})
			.catch((err: unknown) => {
				if (syncGen !== bootGeneration) return; // stale
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`session-search: initial sync failed: ${msg}`, "warning");
				ctx.ui.setStatus("session-search", "");
			});

		// Periodic sync with generation guard (task 2.10)
		if (syncTimer) clearInterval(syncTimer);
		syncTimer = setInterval(async () => {
			if (!sessionIndex || currentVerdict?.kind === "misconfigured") return; // task 2.10

			const syncGen = bootGeneration;
			try {
				const result = await sessionIndex.sync();
				if (syncGen !== bootGeneration) return; // stale — task 2.6
				const changes =
					result.added + result.updated + result.removed + result.moved;
				if (changes > 0) {
					const parts: string[] = [];
					if (result.added) parts.push(`+${result.added}`);
					if (result.updated) parts.push(`~${result.updated}`);
					if (result.removed) parts.push(`-${result.removed}`);
					if (result.moved) parts.push(`↗${result.moved}`);
					ctx.ui.setStatus(
						"session-search",
						`Sessions synced: ${parts.join(" ")} (${sessionIndex.size()} total)`,
					);
					if (syncGen === bootGeneration) {
						setTimeout(() => {
							if (syncGen !== bootGeneration) return; // stale guard
							ctx.ui.setStatus("session-search", "");
						}, 5000);
					}
				}
			} catch {
				// Silent
			}
		}, SYNC_INTERVAL_MS);
	});

	// ── Install lifecycle AFTER primary session_start (task 2.5) ────────────
	// The lifecycle's session_start handler reads currentVerdict from closure
	// and resolves its own model. Installed after the primary handler so
	// verdict resolution runs first.

	lifecycleHandle = installDigestLifecycle(pi, {
		storage: { loadDigest, saveDigest, loadBuilderState, saveBuilderState },
		builder: { generateDigest },
		costTracker: lifecycleCostTracker,
		configLoader: () => loadDigestConfig(lastCwd),
		modelResolver: resolveModel,
		indexAddDigested,
		isCurrentGeneration: () =>
			currentVerdict?.kind === "digest-hybrid" && lifecycleGen === bootGeneration,
		onSessionStartCaptureGeneration: () => {
			lifecycleGen = bootGeneration;
		},
	});

	// ── session_shutdown (task 2.11) — calls lifecycleHandle.dispose() ──────
	pi.on("session_shutdown", async () => {
		lifecycleHandle?.dispose();
		lifecycleHandle = null;

		if (syncTimer) {
			clearInterval(syncTimer);
			syncTimer = null;
		}
		if (sessionIndex && "close" in sessionIndex) {
			(sessionIndex as any).close();
		}
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Slash commands — /session:*
	// ──────────────────────────────────────────────────────────────────────────

	// ── 8.1 /session:summarizer (task 2.8 — recovery command, no short-circuit) ──
	pi.registerCommand("session:summarizer", {
		description:
			"Configure session-digest model interactively",
		handler: async (_args, ctx) => {
			const configPath = getDigestConfigPath();
			if (!existsSync(configPath)) {
				const picked = await pickDigestModel(ctx, { prompt: "Select digest model" });
				if (!picked) {
					ctx.ui.notify("Digest config creation cancelled.", "info");
					return;
				}
				const [provider, ...modelParts] = picked.split("/");
				const model = modelParts.join("/");
				const config: DigestConfig = {
					provider,
					model,
					debounceSeconds: 60,
					resummarizeTokenThreshold: 4000,
				};
				saveDigestConfig(config);
				ctx.ui.notify(
					`Digest config created at ${configPath} with model ${picked}. Run /reload to activate.`,
					"success",
				);
				if (!currentConfig?.embedder) {
					ctx.ui.notify(
						"Warning: digest-hybrid mode also requires an embedder. " +
							"Run /session:embedder to configure semantic search, " +
							"or remove digest.json to stay in fts-raw mode.",
						"warning",
					);
				}
			} else {
				const current = loadDigestConfig(ctx.cwd || process.cwd());
				const currentModel =
					current.provider && current.model
						? `${current.provider}/${current.model}`
						: undefined;

				const picked = await pickDigestModel(ctx, {
					prompt: "Change digest model",
					currentModel,
				});
				if (!picked) {
					ctx.ui.notify("Digest config unchanged.", "info");
					return;
				}

				const [provider, ...modelParts] = picked.split("/");
				const model = modelParts.join("/");
				const config: DigestConfig = {
					...current,
					provider,
					model,
				};
				saveDigestConfig(config);
				ctx.ui.notify(
					`Digest model updated to ${picked}. Run /reload to activate.`,
					"success",
				);
				if (!currentConfig?.embedder) {
					ctx.ui.notify(
						"Warning: digest-hybrid mode also requires an embedder. " +
							"Run /session:embedder to configure semantic search, " +
							"or remove digest.json to stay in fts-raw mode.",
						"warning",
					);
				}
			}
		},
	});

	// ── 8.2 /session:update (task 2.7 — check verdict) ───────────────────────
	pi.registerCommand("session:update", {
		description:
			"Generate/update the digest for the current session immediately (bypasses debounce)",
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

			ctx.ui.notify("Generating digest…", "info");

			try {
				const digest = await lifecycleHandle.triggerNow();
				if (digest) {
					ctx.ui.notify(`Digest updated: "${digest.headline}"`, "success");
				} else {
					ctx.ui.notify(
						"Digest generation failed (LLM returned no valid output).",
						"error",
					);
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Digest generation failed: ${msg}`, "error");
			}
		},
	});

	// ── 8.3 /session:digest (task 2.7 — check verdict) ─────────────────────────
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
				digest.body,
			].filter((l) => l !== "");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── 8.4 /session:rewrite (task 2.7 — check verdict) ──────────────────────
	pi.registerCommand("session:rewrite", {
		description:
			"Force full re-summarize of the current session digest regardless of token threshold",
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

			ctx.ui.notify("Force re-summarizing digest…", "info");

			try {
				const digest = await lifecycleHandle.triggerNow({ forceFull: true });
				if (digest) {
					ctx.ui.notify(`Digest rewritten: "${digest.headline}"`, "success");
				} else {
					ctx.ui.notify("Digest re-summarize failed.", "error");
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Digest re-summarize failed: ${msg}`, "error");
			}
		},
	});

	// ── 8.5 / 8.6 / 8.7 /session:backfill [--dry-run | --regen] (task 2.7) ──
	// Also task 2.6: generation guard for long-running commands.
	pi.registerCommand("session:backfill", {
		description:
			"Generate digests for un-digested historical sessions. " +
			"Flags: --dry-run (cost estimate only), --regen (overwrite all existing digests)",
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
			);

			// Resolve digest model for backfill
			const backfillModel = resolveModel(digestConfig, ctx.modelRegistry.getAvailable());
			if (!backfillModel) {
				ctx.ui.notify("No digest model available for backfill. Run /session:summarizer to configure.", "error");
				return;
			}

			// ── 8.6 Dry run ────────────────────────────────────────────────────
			if (isDryRun) {
				const embedderRaw = currentConfig?.embedder as
					| (EmbedderConfig & { pricePerInputToken?: number })
					| undefined;
				runBackfillDryRun({
					files,
					activeSessionId,
					resolvedModel: backfillModel,
					embedderPricePerInputToken: embedderRaw?.pricePerInputToken,
					notify: (msg, level = "info") => {
						if (myGen !== bootGeneration) return; // task 2.6
						ctx.ui.notify(msg, level as any);
					},
				});
				return;
			}

			// ── 8.5 / 8.7 Full / regen backfill ──────────────────────────────
			if (!(sessionIndex instanceof SessionIndex)) {
				ctx.ui.notify(
					"Backfill requires a vector index (configure embedder via /session:embedder).",
					"warning",
				);
				return;
			}

			let completeFn: CompleteFn;
			try {
				completeFn = await resolveHostCompleteFn(
					ctx.modelRegistry as unknown as HostModelRegistry,
					backfillModel,
				);
			} catch (err: unknown) {
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
					if (myGen !== bootGeneration) return; // task 2.6
					ctx.ui.setStatus("session-search", msg ?? "");
				},
				notify: (msg, level = "info") => {
					if (myGen !== bootGeneration) return; // task 2.6
					ctx.ui.notify(msg, level as any);
				},
			});
		},
	});

	// ── 8.8 /session:cost (task 2.7 — check verdict) ─────────────────────────
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
			ctx.ui.notify(formatCost(currentRollup, "digest"), "info");
		},
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Setup command (8.9) — /session:embedder
	// Task 2.8: recovery command — does NOT short-circuit on misconfigured.
	// ──────────────────────────────────────────────────────────────────────────

	pi.registerCommand("session:embedder", {
		description:
			"Configure semantic embeddings for session search (OpenAI-compatible API)",
		handler: async (_args, ctx) => {
			// Required: base URL
			const baseUrl = await ctx.ui.input(
				"Embeddings API base URL (e.g. https://api.openai.com):",
				"https://api.openai.com",
			);
			if (!baseUrl) {
				ctx.ui.notify("Setup cancelled.", "info");
				return;
			}

			// Required: model name
			const model = await ctx.ui.input(
				"Model name (e.g. text-embedding-3-small):",
				"text-embedding-3-small",
			);
			if (!model) {
				ctx.ui.notify("Setup cancelled.", "info");
				return;
			}

			// Auth: apiKey OR apiKeyEnv
			const apiKey = await ctx.ui.input(
				"API key (leave blank to use an env var instead):",
				"",
			);

			let apiKeyEnv: string | undefined;
			if (!apiKey) {
				const envVar = await ctx.ui.input(
					"Env var name for API key (e.g. OPENAI_API_KEY):",
					"OPENAI_API_KEY",
				);
				if (envVar) apiKeyEnv = envVar;
			}

			// Optional: dimensions
			const dimsInput = await ctx.ui.input(
				"Embedding dimensions (leave blank for API default):",
				"",
			);
			const dimensions =
				dimsInput && !isNaN(parseInt(dimsInput, 10))
					? parseInt(dimsInput, 10)
					: undefined;

			// Optional: extra directories
			const extraDirs = await ctx.ui.input(
				"Extra session directories (comma-separated, optional):",
				"",
			);
			const extraArchive = await ctx.ui.input(
				"Extra archive directories (comma-separated, optional):",
				"",
			);

			const embedder: EmbedderConfig = {
				baseUrl: baseUrl.replace(/\/$/, ""),
				model,
				...(apiKey ? { apiKey } : {}),
				...(apiKeyEnv ? { apiKeyEnv } : {}),
				...(dimensions !== undefined ? { dimensions } : {}),
			};

			saveConfig({
				embedder,
				extraSessionDirs: extraDirs
					? extraDirs
							.split(",")
							.map((d: string) => d.trim())
							.filter(Boolean)
					: undefined,
				extraArchiveDirs: extraArchive
					? extraArchive
							.split(",")
							.map((d: string) => d.trim())
							.filter(Boolean)
					: undefined,
			});

			ctx.ui.notify(
				`Embeddings config saved to ${getConfigPath()}. Run /reload to activate.`,
				"success",
			);
		},
	});

	// ──────────────────────────────────────────────────────────────────────────
	// 8.10 /session:sync and /session:reindex (task 2.6 generation guard)
	// ──────────────────────────────────────────────────────────────────────────

	pi.registerCommand("session:sync", {
		description: "Force an immediate incremental re-sync of the session index",
		handler: async (_args, ctx) => {
			if (!sessionIndex) {
				ctx.ui.notify("Session index not ready yet.", "warning");
				return;
			}
			const myGen = bootGeneration;
			try {
				const r = await sessionIndex.sync((msg) => {
					if (myGen !== bootGeneration) return; // task 2.6
					ctx.ui.setStatus("session-search", msg);
				});
				if (myGen !== bootGeneration) return; // task 2.6
				const parts: string[] = [];
				if (r.added) parts.push(`+${r.added}`);
				if (r.updated) parts.push(`~${r.updated}`);
				if (r.removed) parts.push(`-${r.removed}`);
				if (r.moved) parts.push(`↗${r.moved}`);
				ctx.ui.notify(
					`Synced: ${parts.join(" ") || "no changes"} (${sessionIndex.size()} total)`,
					"success",
				);
				ctx.ui.setStatus("session-search", "");
			} catch (err: unknown) {
				if (myGen !== bootGeneration) return; // task 2.6
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Sync failed: ${msg}`, "error");
			}
		},
	});

	pi.registerCommand("session:reindex", {
		description: "Force full re-index of all session files",
		handler: async (_args, ctx) => {
			if (!sessionIndex) {
				ctx.ui.notify("Session index not ready yet.", "warning");
				return;
			}
			const myGen = bootGeneration;
			ctx.ui.notify("Re-indexing sessions…", "info");
			try {
				await sessionIndex.rebuild((msg) => {
					if (myGen !== bootGeneration) return; // task 2.6
					ctx.ui.setStatus("session-search", msg);
				});
				if (myGen !== bootGeneration) return; // task 2.6
				ctx.ui.notify(`Re-indexed: ${sessionIndex.size()} sessions`, "success");
				ctx.ui.setStatus("session-search", "");
			} catch (err: unknown) {
				if (myGen !== bootGeneration) return; // task 2.6
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Re-index failed: ${msg}`, "error");
			}
		},
	});

	// ──────────────────────────────────────────────────────────────────────────
	// 10.5 /find-session overlay
	// ──────────────────────────────────────────────────────────────────────────

	registerFindSessionCommand(pi, {
		getCurrentVerdict: () => currentVerdict,
		index: {
			async search(query: string, limit: number) {
				if (!sessionIndex) return [];
				return sessionIndex.search(query, limit);
			},
			getDigest(sessionId: string) {
				if (sessionIndex instanceof SessionIndex) {
					return sessionIndex.getDigest(sessionId);
				}
				return null;
			},
		},
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Tools: session_search, session_list, session_read
	// Task 2.7: check verdict — return notifyMessage if misconfigured
	// ──────────────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "session_search",
		label: "Session Search",
		description:
			"Semantic search over past pi sessions. Returns summaries of the most relevant sessions for a natural language query. Use to find previous work, decisions, debugging sessions, or code changes.",
		promptSnippet:
			"Semantic search over past pi sessions — find previous work, decisions, and context by topic.",
		promptGuidelines: [
			"Use session_search to find past coding sessions relevant to the current task (e.g. 'when did we refactor the auth module', 'previous work on Lambda timeouts').",
			"Use session_list for browsing by date/project. Use session_read to dive into a specific session.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Natural language search query" }),
			limit: Type.Optional(
				Type.Number({
					description: "Max results to return (default 10, max 25)",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			if (currentVerdict?.kind === "misconfigured") {
				return {
					content: [{ type: "text", text: currentVerdict.notifyMessage }],
					details: {},
				};
			}
			if (!sessionIndex || sessionIndex.size() === 0) {
				if (!sessionIndex) {
					return {
						content: [{ type: "text", text: "Session index not ready yet." }],
						details: {},
					};
				}
				const msg =
					currentVerdict?.kind === "digest-hybrid"
						? "Session index is empty in digest mode. Run /session:backfill to digest historical sessions, or wait for new sessions to be digested live."
						: "Session index is empty — it may still be building. Try again in a moment.";
				return { content: [{ type: "text", text: msg }], details: {} };
			}

			const limit = Math.min(params.limit ?? 10, 25);

			try {
				const results = await sessionIndex.search(params.query, limit, signal);

				if (results.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `No relevant sessions found for: "${params.query}"`,
							},
						],
						details: {},
					};
				}

				const home = process.env.HOME || "";
				const output = results
					.map((r, i) => {
						const score = (r.score * 100).toFixed(1);
						const displayFile = r.session.file.replace(home, "~");

						if (
							currentVerdict?.kind === "digest-hybrid" &&
							sessionIndex instanceof SessionIndex
						) {
							const digest = sessionIndex.getDigest(r.session.id);
							if (digest) {
								const topicsLine =
									digest.topics.length > 0
										? `Topics: ${digest.topics.join(", ")}`
										: "";
								const bodyExcerpt = truncate(digest.body, 300);
								return [
									`### ${i + 1}. ${digest.headline} (${score}% match)`,
									`File: ${displayFile}`,
									`ID: ${r.session.id}`,
									`Date: ${r.session.startedAt.split("T")[0]} | CWD: ${r.session.cwd}`,
									...(topicsLine ? [topicsLine] : []),
									bodyExcerpt,
								].join("\n");
							}
						}

						return [
							`### ${i + 1}. ${r.session.name || truncate(r.session.firstUserMessage, 80)} (${score}% match)`,
							`File: ${displayFile}`,
							`ID: ${r.session.id}`,
							`Date: ${r.session.startedAt.split("T")[0]} | CWD: ${r.session.cwd}`,
							r.summary,
						].join("\n");
					})
					.join("\n\n---\n\n");

				const header = `Found ${results.length} sessions for "${params.query}" (${sessionIndex.size()} sessions indexed):\n\n`;

				return {
					content: [{ type: "text", text: header + output }],
					details: { resultCount: results.length, indexSize: sessionIndex.size() },
				};
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`session-search failed: ${msg}`);
			}
		},
	});

	pi.registerTool({
		name: "session_list",
		label: "Session List",
		description:
			"List past pi sessions with optional filters by project, date range, or archive status. Returns session metadata and summaries.",
		promptSnippet: "List/filter past pi sessions by project, date, or archive status.",
		parameters: Type.Object({
			project: Type.Optional(
				Type.String({ description: "Filter by project name or path substring" }),
			),
			after: Type.Optional(
				Type.String({
					description:
						"Only sessions after this date (ISO format, e.g. 2026-03-01)",
				}),
			),
			before: Type.Optional(
				Type.String({
					description: "Only sessions before this date (ISO format)",
				}),
			),
			archived: Type.Optional(
				Type.Boolean({ description: "Filter by archived status" }),
			),
			limit: Type.Optional(
				Type.Number({ description: "Max results (default 20, max 50)" }),
			),
		}),
		async execute(_toolCallId, params) {
			if (currentVerdict?.kind === "misconfigured") {
				return {
					content: [{ type: "text", text: currentVerdict.notifyMessage }],
					details: {},
				};
			}
			if (!sessionIndex || sessionIndex.size() === 0) {
				const msg = !sessionIndex
					? "Session index not ready yet."
					: "Session index is empty.";
				return { content: [{ type: "text", text: msg }], details: {} };
			}

			const limit = Math.min(params.limit ?? 20, 50);
			const sessions = sessionIndex.list({
				project: params.project,
				after: params.after,
				before: params.before,
				archived: params.archived,
				limit,
			});

			if (sessions.length === 0) {
				return {
					content: [{ type: "text", text: "No sessions match the filters." }],
					details: {},
				};
			}

			const home = process.env.HOME || "";
			const output = sessions
				.map((s, i) => {
					let name: string;
					if (currentVerdict?.kind === "digest-hybrid" && sessionIndex instanceof SessionIndex) {
						const digest = sessionIndex.getDigest(s.id);
						if (digest) {
							name = digest.headline;
						} else {
							name =
								truncate(s.firstUserMessage, 60) +
								" (no digest — run /session:update)";
						}
					} else {
						name = s.name || truncate(s.firstUserMessage, 60);
					}
					const date = s.startedAt.split("T")[0];
					const tools = s.toolCalls
						.slice(0, 3)
						.map((t) => t.name)
						.join(", ");
					const arch = s.archived ? " (archived)" : "";
					const displayFile = s.file.replace(home, "~");
					return `${i + 1}. **${name}** — ${date}${arch}\n   CWD: ${s.cwd} | ${s.userMessageCount} msgs | Tools: ${tools}\n   File: ${displayFile}`;
				})
				.join("\n\n");

			const header = `${sessions.length} sessions (${sessionIndex.size()} total indexed):\n\n`;

			return {
				content: [{ type: "text", text: header + output }],
				details: { resultCount: sessions.length },
			};
		},
	});

	pi.registerTool({
		name: "session_read",
		label: "Session Read",
		description:
			"Read the full conversation from a past pi session. Provide the session file path or session ID. Supports pagination for large sessions.",
		promptSnippet:
			"Read the full conversation from a specific past pi session by file path or ID.",
		parameters: Type.Object({
			session: Type.String({
				description:
					"Session file path (from session_search/session_list results) or session UUID",
			}),
			offset: Type.Optional(
				Type.Number({
					description:
						"Start from this entry index (for pagination, default 0)",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Max entries to return (default 50, max 100)",
				}),
			),
			include_tools: Type.Optional(
				Type.Boolean({
					description: "Include tool results in output (default false, verbose)",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			if (currentVerdict?.kind === "misconfigured") {
				return {
					content: [{ type: "text", text: currentVerdict.notifyMessage }],
					details: {},
				};
			}

			let filePath = params.session;

			if (
				sessionIndex &&
				!filePath.endsWith(".jsonl") &&
				!filePath.includes("/")
			) {
				const entry = sessionIndex.get(filePath);
				if (entry) {
					filePath = entry.session.file;
				} else {
					return {
						content: [
							{
								type: "text",
								text: `Session not found: "${params.session}". Use session_search or session_list to find the session file path.`,
							},
						],
						details: {},
					};
				}
			}

			if (filePath.startsWith("~")) {
				filePath = filePath.replace("~", process.env.HOME || "");
			}

			const home = process.env.HOME || "";
			const allowedRoots = [
				resolve(home, ".pi", "agent", "sessions"),
				resolve(home, ".pi", "agent", "sessions-archive"),
				...(currentConfig?.extraSessionDirs ?? []).map((d) => resolve(d)),
				...(currentConfig?.extraArchiveDirs ?? []).map((d) => resolve(d)),
			];
			const resolvedPath = resolve(filePath);
			if (
				!allowedRoots.some(
					(root) =>
						resolvedPath.startsWith(root + "/") || resolvedPath === root,
				)
			) {
				return {
					content: [
						{
							type: "text",
							text: `Access denied: path "${filePath}" is outside the allowed session directories.`,
						},
					],
					details: {},
				};
			}

			const limit = Math.min(params.limit ?? 50, 100);
			const output = readSessionConversation(filePath, {
				offset: params.offset ?? 0,
				limit,
				includeTools: params.include_tools ?? false,
			});

			return {
				content: [{ type: "text", text: output }],
				details: { file: filePath },
			};
		},
	});
}

// ──────────────────────────────────────────────────────────────────────────────
// 10.6 Exported helper API

export { truncate, pathToSlug, formatRelativeDate, slugToProject, buildSummary } from "./utils";
export { toFtsQuery, buildContent } from "./index/fts-index";
export { encodeEmbedding, decodeEmbedding } from "./index/session-index";
export type { SearchResult, ListFilters } from "./index/session-index";
export { parseSession, discoverSessionFiles, readSessionId } from "./parser";
export { loadConfig, saveConfig, getConfigPath, getIndexDir } from "./config";
export type { SessionDigest } from "./digest/schema";
export { validateDigest } from "./digest/schema";
export {
	digestPath,
	loadDigest,
	saveDigest,
	listDigestedSessionIds,
	statePath,
	loadBuilderState,
	saveBuilderState,
} from "./digest/storage";
export {
	loadDigestConfig,
	saveDigestConfig,
	getDigestConfigPath,
} from "./digest/config";
export type { DigestConfig } from "./digest/config";
export { resolveModel } from "./digest/model-resolver";
export { emptyRollup, record as recordCost, format as formatCost } from "./digest/cost-tracker";
export type { CostRollup } from "./digest/cost-tracker";
export {
	generateDigest,
	estimateTokens,
	extractDelta,
	capInput,
	buildPrompt,
	emptyBuilderState,
} from "./digest/builder";
export type { BuilderState, GenerateOpts } from "./digest/builder";
export {
	liveConversationView,
	parsedConversationView,
} from "./digest/conversation-view";
export type { ConversationView, ConversationMessage } from "./digest/conversation-view";
export { installDigestLifecycle } from "./digest/lifecycle";
export type { LifecycleHandle, LifecycleDeps } from "./digest/lifecycle";
export { runBackfill, runBackfillDryRun } from "./digest/backfill";
export { registerFindSessionCommand } from "./search/overlay";
export type { SearchableIndex } from "./search/overlay";

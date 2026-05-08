/**
 * Backfill helpers for /digest:backfill and /digest:backfill --dry-run.
 *
 * Extracted from src/index.ts to keep command handler code readable.
 * Called by Phase-8 slash commands; NOT a lifecycle module.
 */

import { statSync } from "node:fs";
import type { Model, Api } from "@mariozechner/pi-ai";
import { discoverSessionFiles, parseSession, readSessionId } from "../parser";
import type { SessionDigest } from "./schema";
import { loadDigest, saveDigest } from "./storage";
import { parsedConversationView } from "./conversation-view";
import { generateDigest, emptyBuilderState } from "./builder";
import type { DigestConfig } from "./config";
import type { SessionIndex } from "../index/session-index";

// ─── Run backfill ─────────────────────────────────────────────────────────────

export interface BackfillRunDeps {
	/** All session files to consider (from discoverSessionFiles). */
	files: { file: string; archived: boolean }[];
	/** Active session ID — always skipped (owned by live lifecycle). */
	activeSessionId: string;
	/** The vector index to update. */
	index: SessionIndex;
	/** Resolved digest LLM model. */
	resolvedModel: Model<Api>;
	/** Merged digest config. */
	digestConfig: DigestConfig;
	/**
	 * If true, re-process ALL sessions (overwrite existing digests).
	 * If false, skip sessions that already have a digest.
	 */
	regenMode: boolean;
	/** Update status bar; pass undefined to clear. */
	setStatus: (msg: string | undefined) => void;
	/** Terminal notification. */
	notify: (msg: string, level?: string) => void;
}

/**
 * Run the backfill loop.
 *
 * Sets `index.backfillInProgress = true` for the duration.
 * Flushes the index every 25 digests and unconditionally in the finally block.
 * Per-file errors are logged and skipped; they do NOT abort the run.
 */
export async function runBackfill(deps: BackfillRunDeps): Promise<void> {
	const {
		files,
		activeSessionId,
		index,
		resolvedModel,
		digestConfig,
		regenMode,
		setStatus,
		notify,
	} = deps;

	// ── Pre-scan (cheap): find targets using header-only reads ───────────────
	// readSessionId reads only the first 1 KB of each file, so this is fast.
	const targets: { file: string; archived: boolean; id: string }[] = [];
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
	index.backfillInProgress = true;

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
				// Always use a fresh state for backfill (full re-summarize path).
				const state = emptyBuilderState();

				const result = await generateDigest(resolvedModel, view, state, {
					resummarizeTokenThreshold: digestConfig.resummarizeTokenThreshold,
				});

				if (!result) {
					failed++;
					console.warn(`session-search: backfill: no digest returned for ${id}`);
					continue;
				}

				// ── Race guard ──────────────────────────────────────────────────
				// The live lifecycle may have written a digest during our LLM call.
				// Re-check immediately before saving to avoid overwriting it.
				if (!regenMode && loadDigest(id) !== null) {
					// Skip — live lifecycle already handled this session.
					continue;
				}

				const { digest } = result;
				saveDigest(id, digest);
				await index.addDigested(id, parsed, digest, { batched: true });
				done++;
				flushCount++;

				if (flushCount >= 25) {
					index.flush();
					flushCount = 0;
				}

				setStatus(`Backfilling digests: ${done}/${total}`);
			} catch (err: unknown) {
				failed++;
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`session-search: backfill error for ${id}: ${msg}`);
			}
		}

		notify(
			`Backfill complete: ${done}/${total} digested${failed > 0 ? `, ${failed} failed` : ""}.`,
			"success",
		);
	} finally {
		index.flush();
		index.backfillInProgress = false;
		setStatus(undefined);
	}
}

// ─── Dry-run estimate ─────────────────────────────────────────────────────────

export interface BackfillDryRunDeps {
	files: { file: string; archived: boolean }[];
	activeSessionId: string;
	resolvedModel: Model<Api>;
	/** Optional per-token embed price from embedder config. */
	embedderPricePerInputToken?: number;
	notify: (msg: string, level?: string) => void;
}

/**
 * Enumerate un-digested files and print a cost estimate without making any
 * LLM calls.
 *
 * Formula (per task 8.6):
 *   inputTokenEstimate  = Σ(file.sizeBytes / 4)
 *   inputCostUsd        = inputTokenEstimate × model.cost.input  / 1_000_000
 *   outputCostUsd       = sessionCount × 700 × model.cost.output / 1_000_000   (700 = typical output)
 *   embedCostUsd        = sessionCount × 700 × pricePerInputToken             (if configured)
 *
 * Note: pi-ai's `Model<Api>.cost.{input,output}` is denominated in USD per 1M
 * tokens (see `@mariozechner/pi-ai/dist/models.js` `applyCost`). The /1_000_000
 * divisor here matches that convention. `embedder.pricePerInputToken` keeps
 * its literal name — USD per single token — for backward compatibility.
 */
export function runBackfillDryRun(deps: BackfillDryRunDeps): void {
	const { files, activeSessionId, resolvedModel, embedderPricePerInputToken, notify } = deps;

	let inputTokenEstimate = 0;
	let sessionCount = 0;

	for (const { file } of files) {
		const id = readSessionId(file);
		if (!id) continue;
		if (id === activeSessionId) continue;
		if (loadDigest(id) !== null) continue;

		try {
			const { size } = statSync(file);
			inputTokenEstimate += size / 4;
			sessionCount++;
		} catch {
			// inaccessible file — skip
		}
	}

	if (sessionCount === 0) {
		notify("Dry run: no un-digested sessions found.", "info");
		return;
	}

	// pi-ai stores cost.{input,output} as USD per 1M tokens; convert to per-token.
	const inputRate = ((resolvedModel as any).cost?.input ?? 0) / 1_000_000;
	const outputRate = ((resolvedModel as any).cost?.output ?? 0) / 1_000_000;
	const inputCostUsd = inputTokenEstimate * inputRate;
	const outputCostUsd = sessionCount * 700 * outputRate;

	const lines: string[] = [
		`Backfill dry run — ${sessionCount} un-digested session(s)`,
		`  Input tokens est.: ${Math.round(inputTokenEstimate).toLocaleString()}`,
		`  Input cost:        $${inputCostUsd.toFixed(4)}`,
		`  Output cost:       $${outputCostUsd.toFixed(4)} (${sessionCount} × 700 tokens)`,
	];

	if (embedderPricePerInputToken !== undefined) {
		const embedCostUsd = sessionCount * 700 * embedderPricePerInputToken;
		const total = inputCostUsd + outputCostUsd + embedCostUsd;
		lines.push(`  Embed cost:        $${embedCostUsd.toFixed(4)}`);
		lines.push(`  Total est.:        $${total.toFixed(4)}`);
	} else {
		const total = inputCostUsd + outputCostUsd;
		lines.push(
			`  Embed cost:        not estimated (configure embedder.pricePerInputToken to include)`,
		);
		lines.push(`  Total est.:        $${total.toFixed(4)} (excl. embedding)`);
	}

	lines.push(`  Note: accuracy may vary ±30–50% depending on session size distribution.`);

	notify(lines.join("\n"), "info");
}

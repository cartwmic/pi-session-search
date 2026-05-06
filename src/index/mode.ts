import type { Config } from "../config";

// ─── Mode type ───────────────────────────────────────────────────────

/**
 * Operating mode, auto-detected from config (task 5.7).
 *
 *   fts-raw     — no embedder, no digest model → BM25 keyword search only
 *   hybrid-raw  — embedder configured, no digest model → cosine + BM25 over raw content
 *   digest-mode — embedder + digest model both configured → cosine + BM25 over digested content
 *
 * The presence/absence of config IS the toggle. No user-facing switch needed.
 * See design.md "Three operating modes, auto-detected, not user-toggled".
 */
export type Mode = "fts-raw" | "hybrid-raw" | "digest-mode";

/**
 * Detect operating mode from config + whether a digest model resolved.
 *
 * @param config           Loaded extension config (null = no config file)
 * @param digestModelResolved  True if a digest model was resolved from the registry
 */
export function detectMode(config: Config | null, digestModelResolved: boolean): Mode {
	if (!config?.embedder && !digestModelResolved) return "fts-raw";
	if (config?.embedder && !digestModelResolved) return "hybrid-raw";
	// Both embedder and digest model are present
	return "digest-mode";
}

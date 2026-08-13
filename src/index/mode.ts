import { existsSync } from "node:fs"
import { join } from "node:path"

import type { Model, Api } from "@mariozechner/pi-ai"
import type { Config } from "../config"
import type { DigestConfig } from "../digest/config"
import { resolveModel } from "../digest/model-resolver"
import { sessionSearchHome } from "../utils"

// ─── Mode type (narrowed) ────────────────────────────────────────────

/**
 * Operating mode, auto-detected from config (task 5.7).
 *
 *   fts-raw       — no explicit digest intent → BM25 keyword search only.
 *                   FTS indexes raw session content only; any standalone
 *                   embedder configuration is ignored until digest config exists.
 *   digest-hybrid — embedder + digest model both configured →
 *                   cosine over digest-body embeddings + BM25 over
 *                   (digest body, raw content) weighted columns.
 *
 * Digest intent without both a working embedder and resolvable explicit model
 * is NOT a legal Mode — it produces a misconfigured Verdict instead.
 */
export type Mode = "fts-raw" | "digest-hybrid"

/**
 * Legacy on-disk mode literals.  Used ONLY in migration code that reads
 * `lastMode` from disk.  NOT assignable to the narrowed `Mode` type.
 */
export type LegacyDiskMode = "fts-raw" | "hybrid-raw" | "digest-mode" | "digest-hybrid"

/** User-friendly identifier for the missing component in a misconfigured verdict. */
export type MissingComponent = "embedder" | "digest" | "both"

// ─── Verdict discriminated union ─────────────────────────────────────

export interface FtsRawVerdict {
  kind: "fts-raw"
}

export interface DigestHybridVerdict {
  kind: "digest-hybrid"
}

export interface MisconfiguredVerdict {
  kind: "misconfigured"
  missing: MissingComponent
  /** Short status line for ctx.ui.setStatus (visible in TUI status bar). */
  statusLine: string
  /** Full remediation message for ctx.ui.notify (shown as an error toast). */
  notifyMessage: string
}

export type Verdict = FtsRawVerdict | DigestHybridVerdict | MisconfiguredVerdict

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Return remediation title fragment for a MissingComponent.
 * Used in statusLine and notifyMessage composition.
 */
function missingTitle(missing: MissingComponent): string {
  switch (missing) {
    case "embedder":
      return "no embedder"
    case "digest":
      return "no digest model"
    case "both":
      return "no embedder, no digest model"
  }
}

/**
 * Build the three remediation strings from the spec (task 1.4).
 */
export function composeRemediation(missing: MissingComponent): { statusLine: string; notifyMessage: string } {
  const statusLine = `session-search: misconfigured (${missingTitle(missing)})`

  let notifyMessage: string
  switch (missing) {
    case "digest":
      notifyMessage =
        "session-search: misconfigured (no digest model). " +
        "Configure ~/.pi/session-search/digest.json with provider+model, " +
        "or remove ~/.pi/session-search/config.json to use fts-raw mode."
      break
    case "embedder":
      notifyMessage =
        "session-search: misconfigured (no embedder). " +
        "Configure ~/.pi/session-search/config.json with embedder, " +
        "or remove ~/.pi/session-search/digest.json to use fts-raw mode."
      break
    case "both":
      notifyMessage =
        "session-search: misconfigured (no embedder, no digest model). " +
        "Configure both ~/.pi/session-search/config.json AND " +
        "~/.pi/session-search/digest.json, or remove both files to use fts-raw mode."
      break
  }

  return { statusLine, notifyMessage }
}

// ─── digestRequested predicate ───────────────────────────────────────
//
// True iff the user has expressed intent for digest-hybrid mode:
//   • a digest.json config file exists (global or project-scoped), OR
//   • the loaded config has explicit provider+model fields set.

function digestRequested(config: DigestConfig, cwd: string): boolean {
  const globalFile = join(sessionSearchHome(), "digest.json")
  const projectFile = join(cwd, ".pi", "session-search", "digest.json")

  if (existsSync(globalFile) || existsSync(projectFile)) return true
  if (config.provider !== undefined && config.model !== undefined) return true
  return false
}

// ─── Synchronous verdict computation ─────────────────────────────────

interface SyncVerdictInput {
  config: Config | null
  embedderAvailable: boolean
  /** True if the digest model is resolvable from the registry right now. */
  digestModelResolved: boolean
  digestRequested: boolean
}

/**
 * Compute the verdict synchronously from current values.
 * This is the pure table from session-indexing/spec.md.
 */
function computeVerdictSync(input: SyncVerdictInput): Verdict {
  const { embedderAvailable, digestModelResolved, digestRequested: requested } = input

  // No digest intent → fts-raw, regardless of standalone embedder config.
  // Digest configuration is the explicit opt-in boundary.
  if (!requested) {
    return { kind: "fts-raw" }
  }

  // Both embedder and digest model available → digest-hybrid
  if (embedderAvailable && digestModelResolved) {
    return { kind: "digest-hybrid" }
  }

  // Remaining cases are all misconfigured (partial config or both absent
  // with digest intent).  Determine which component(s) are missing.
  const missing: MissingComponent =
    !embedderAvailable && !digestModelResolved
      ? "both"
      : !embedderAvailable
        ? "embedder"
        : "digest"

  const { statusLine, notifyMessage } = composeRemediation(missing)
  return { kind: "misconfigured", missing, statusLine, notifyMessage }
}

// ─── ResolveModeVerdict ──────────────────────────────────────────────

export interface ResolveModeVerdictOpts {
  /**
   * Whether createEmbedder returned a non-null Embedder.
   * createEmbedder MUST run BEFORE resolveModeVerdict; the embedder
   * resolution step is wired from outside this module (Phase B).
   * Default: config.embedder is defined.
   */
  embedderAvailable?: boolean

  /**
   * The digest config (loaded from digest.json) for model resolution.
   * If omitted, digest model resolution is skipped (treated as not resolved).
   */
  digestConfig?: DigestConfig

  /**
   * Current working directory, used by digestRequested to check
   * project-scoped digest.json.  Defaults to process.cwd().
   */
  cwd?: string

  /**
   * Delay function used for the bounded retry.
   * Default: setTimeout-based promise.  Provide a mock in tests.
   */
  delay?: (ms: number) => Promise<void>
}

/**
 * Asynchronously resolve the operating-mode verdict.
 *
 * This replaces the synchronous `detectMode(config, digestModelResolved)`.
 *
 * NOTE (task 1.5): `createEmbedder` MUST run BEFORE this function so that
 * `embedderAvailable` reflects the real embedder-construction outcome.
 * The embedder-resolution step is wired from outside this module.
 *
 * The verdict is async because:
 *   - `ctx.modelRegistry.getAvailable()` may populate asynchronously
 *     after the first `session_start`.
 *   - If the synchronous resolution returns `misconfigured` AND `missing`
 *     is `"digest"` OR `"both"` AND the user has expressed digest intent,
 *     the function awaits ~1000ms and retries once to handle the
 *     registry-population race.
 *
 * @param config        Loaded extension config (null = no config file).
 * @param registryGetter  Async function returning the available model registry.
 *                        Matches the shape of ctx.modelRegistry.getAvailable().
 * @param opts          Optional configuration (embedder outcome, digest config,
 *                      delay injector for tests, cwd).
 */
export async function resolveModeVerdict(
  config: Config | null,
  registryGetter: () => Model<Api>[],
  opts?: ResolveModeVerdictOpts,
): Promise<Verdict> {
  const embedderAvailable = opts?.embedderAvailable ?? (config?.embedder !== undefined)
  const cwd = opts?.cwd ?? process.cwd()
  const requested = opts?.digestConfig
    ? digestRequested(opts.digestConfig, cwd)
    : false
  const delay = opts?.delay ?? defaultDelay

  // First synchronous resolution
  const registry = registryGetter()
  const digestModel = opts?.digestConfig
    ? resolveModel(opts.digestConfig, registry)
    : undefined
  const digestModelResolved = digestModel !== undefined

  let verdict = computeVerdictSync({
    config,
    embedderAvailable,
    digestModelResolved,
    digestRequested: requested,
  })

  // Bounded async retry (task 1.3):
  // Retry ONLY when missing is "digest" or "both" AND user wants digest.
  // Do NOT retry for missing: "embedder" only (embedder is sync; retry
  // cannot help).
  if (
    verdict.kind === "misconfigured" &&
    (verdict.missing === "digest" || verdict.missing === "both") &&
    requested
  ) {
    await delay(1000)

    const registry2 = registryGetter()
    const digestModel2 = opts?.digestConfig
      ? resolveModel(opts.digestConfig, registry2)
      : undefined
    const digestModelResolved2 = digestModel2 !== undefined

    verdict = computeVerdictSync({
      config,
      embedderAvailable,
      digestModelResolved: digestModelResolved2,
      digestRequested: requested,
    })
  }

  return verdict
}

// ─── Default delay ───────────────────────────────────────────────────

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

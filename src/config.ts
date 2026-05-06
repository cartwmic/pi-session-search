import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { EmbedderConfig } from "./embedder";
import { sessionSearchHome } from "./utils";

// ─── Types ───────────────────────────────────────────────────────────

export interface Config {
  /** Extra session directories to scan (in addition to default) */
  extraSessionDirs: string[];
  /** Extra archive directories to scan (in addition to default) */
  extraArchiveDirs: string[];
  /** Optional embedder configuration — enables hybrid search when set */
  embedder?: EmbedderConfig;
}

export interface ConfigFile {
  extraSessionDirs?: string[];
  extraArchiveDirs?: string[];
  /** May carry legacy `type` field from upstream config — handled on load */
  embedder?: EmbedderConfig & { type?: string };
}

// ─── Paths ───────────────────────────────────────────────────────────

// Lazily resolved so PI_SESSION_SEARCH_HOME / HOME overrides apply.
function configDir(): string { return sessionSearchHome(); }
function configFile(): string { return join(configDir(), "config.json"); }
function indexDir(): string { return join(configDir(), "index"); }

export function getConfigPath(): string {
  return configFile();
}

export function getIndexDir(): string {
  return indexDir();
}

// ─── Load / Save ─────────────────────────────────────────────────────

export function loadConfig(): Config | null {
  const path = configFile();
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, "utf8");
  let file: ConfigFile;
  try {
    file = JSON.parse(raw) as ConfigFile;
  } catch {
    return null;
  }

  // ── Legacy migration (task 1.11) ──────────────────────────────────
  // If the stored embedder has type === "openai-compatible", strip it silently
  // so callers get a clean EmbedderConfig.  Any other type value is left in
  // place so createEmbedder() can detect it, emit a notify, and refuse.
  let embedder: EmbedderConfig | undefined = file.embedder;
  if (embedder && (embedder as EmbedderConfig & { type?: string }).type === "openai-compatible") {
    const { type: _dropped, ...rest } = embedder as EmbedderConfig & { type?: string };
    embedder = rest as EmbedderConfig;
  }

  return {
    extraSessionDirs: file.extraSessionDirs ?? [],
    extraArchiveDirs: file.extraArchiveDirs ?? [],
    embedder,
  };
}

export function saveConfig(file: ConfigFile): void {
  const path = configFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), "utf8");
}

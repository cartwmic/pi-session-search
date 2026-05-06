import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sessionSearchHome } from "../utils";

// ─── Types ───────────────────────────────────────────────────────────

export interface DigestConfig {
	provider?: string;
	model?: string;
	debounceSeconds: number;
	resummarizeTokenThreshold: number;
	maxTokens: number;
	showWidget: boolean;
	verbose: boolean;
}

// ─── Paths ───────────────────────────────────────────────────────────

// Lazily computed so PI_SESSION_SEARCH_HOME / HOME overrides set after module load still apply.
function globalDigestDir(): string { return sessionSearchHome(); }
function globalDigestFile(): string { return join(globalDigestDir(), "digest.json"); }

function projectDigestFile(cwd: string): string {
	return join(cwd, ".pi", "session-search", "digest.json");
}

export function getDigestConfigPath(): string {
	return globalDigestFile();
}

// ─── Defaults ────────────────────────────────────────────────────────

const DEFAULTS: DigestConfig = {
	debounceSeconds: 60,
	resummarizeTokenThreshold: 10000,
	maxTokens: 1500,
	showWidget: false,
	verbose: false,
};

// ─── Parse helpers ───────────────────────────────────────────────────

function parsePartial(path: string): Partial<DigestConfig> | null {
	if (!existsSync(path)) return null;
	const raw = readFileSync(path, "utf8");
	try {
		return JSON.parse(raw) as Partial<DigestConfig>;
	} catch {
		console.warn(`session-search: malformed digest config at ${path}; falling back to defaults`);
		return null;
	}
}

// ─── Load ────────────────────────────────────────────────────────────

export function loadDigestConfig(cwd: string): DigestConfig {
	const global = parsePartial(globalDigestFile()) ?? {};
	const project = parsePartial(projectDigestFile(cwd)) ?? {};

	const merged = { ...DEFAULTS, ...global, ...project };

	return {
		...(merged.provider !== undefined ? { provider: merged.provider } : {}),
		...(merged.model !== undefined ? { model: merged.model } : {}),
		debounceSeconds: merged.debounceSeconds,
		resummarizeTokenThreshold: merged.resummarizeTokenThreshold,
		maxTokens: merged.maxTokens,
		showWidget: merged.showWidget,
		verbose: merged.verbose,
	};
}

// ─── Save ────────────────────────────────────────────────────────────

export function saveDigestConfig(config: DigestConfig): void {
	const dir = globalDigestDir();
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.digest-${randomBytes(6).toString("hex")}.json.tmp`);
	writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
	renameSync(tmp, globalDigestFile());
}

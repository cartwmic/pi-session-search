/**
 * /find-session overlay command.
 *
 * Registers a `/find-session <query>` slash command that opens a TUI overlay
 * showing session search results as scrollable cards. Keyboard shortcuts:
 *   ↑ / ↓   — navigate selection
 *   Enter   — switch to selected session (ctx.switchSession)
 *   Esc     — dismiss without switching
 *
 * Registration note (task 9.6):
 *   This module exports `registerFindSessionCommand` so Phase 10 (src/index.ts)
 *   can call it. We do NOT edit src/index.ts here — that file is owned by
 *   Phase 7/10. Import and call `registerFindSessionCommand(pi, { index })` in
 *   src/index.ts as part of Phase 10 wiring.
 */

import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { CURSOR_MARKER } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { SearchResult } from "../index/session-index.js";
import type { SessionDigest } from "../digest/schema.js";
import { formatRelativeDate } from "../utils.js";

// ─── Searchable index interface ───────────────────────────────────────────────

/**
 * Minimal interface required from the index.
 * Typed this way for testability (SessionIndex satisfies it).
 */
export interface SearchableIndex {
  search(query: string, limit: number): Promise<SearchResult[]>;
  getDigest(sessionId: string): SessionDigest | null;
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

/**
 * Truncate `text` to at most `maxLines` visual lines, each at most `width` chars.
 * Returns the truncated lines.
 */
function truncateToLines(text: string, width: number, maxLines: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (out.length >= maxLines) break;
    // Word-wrap the raw line into width-char chunks
    let remaining = raw;
    while (remaining.length > 0 && out.length < maxLines) {
      out.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
  }
  return out;
}

/**
 * Pad `str` with trailing spaces to exactly `len` columns.
 * If `str` is longer than `len`, truncate it.
 */
function padEnd(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len);
  return str + " ".repeat(len - str.length);
}

/**
 * Place `left` and `right` on a single line of `width` columns.
 * `left` is truncated/padded so `right` always fits flush against the right edge.
 */
function splitLine(left: string, right: string, width: number): string {
  const rightLen = right.length;
  const leftMax = width - rightLen - 1;
  const leftStr = leftMax > 0 ? padEnd(left.slice(0, leftMax), leftMax) : "";
  return leftStr + " " + right;
}

// ─── Card renderer ────────────────────────────────────────────────────────────

/**
 * Render one result card.
 * @param result     - Search result (session + score)
 * @param digest     - SessionDigest for this session, or null
 * @param selected   - Whether this card is currently selected
 * @param width      - Available card width (already inset from the outer overlay)
 * @param theme      - Theme for bold/dim styling
 */
function renderCard(
  result: SearchResult,
  digest: SessionDigest | null,
  selected: boolean,
  width: number,
  theme: Theme,
): string[] {
  const marker = selected ? "▶ " : "  ";
  const innerWidth = Math.max(width - marker.length, 10);
  const lines: string[] = [];

  const headline = digest?.headline ?? result.session.name ?? result.session.id.slice(0, 40);
  const topics = digest ? digest.topics.join(", ") : "";
  const date = formatRelativeDate(result.session.endedAt);
  const body = digest?.body ?? result.summary ?? "";
  const filePath = result.session.file;

  // Line 1: headline (bold) + date (right-aligned)
  const headlineBold = theme.bold(headline.slice(0, innerWidth));
  lines.push(marker + splitLine(headlineBold, date, innerWidth));

  // Line 2: topics (dim) — only when non-empty
  if (topics) {
    lines.push(marker + theme.fg("dim", topics.slice(0, innerWidth)));
  }

  // Lines 3-5: body excerpt
  const bodyLines = truncateToLines(body, innerWidth, 3);
  for (const bl of bodyLines) {
    lines.push(marker + theme.fg("dim", bl));
  }

  // Last line: file path (dim)
  lines.push(marker + theme.fg("dim", filePath.slice(-innerWidth)));

  return lines;
}

// ─── Overlay component ────────────────────────────────────────────────────────

/** Delay (ms) before firing search after a keystroke. */
const SEARCH_DEBOUNCE_MS = 150;

/**
 * The TUI overlay component for /find-session.
 * Implements Component + Focusable.
 */
export class FindSessionOverlayComponent implements Component, Focusable {
  focused: boolean = false;
  wantsKeyRelease = false;

  private query: string;
  private results: SearchResult[] = [];
  private selectedIndex: number = 0;
  private searching: boolean = false;

  private tui: TUI;
  private theme: Theme;
  private done: (result: string | undefined) => void;
  private index: SearchableIndex;
  private debounceMs: number;

  private searchTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    tui: TUI,
    theme: Theme,
    done: (result: string | undefined) => void,
    index: SearchableIndex,
    initialQuery: string,
    debounceMs = SEARCH_DEBOUNCE_MS,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.index = index;
    this.query = initialQuery;
    this.debounceMs = debounceMs;

    // Kick off initial search immediately (microtask, no debounce) so first
    // render already has results when the user's term came from the command line.
    if (initialQuery.trim()) {
      Promise.resolve().then(() => this.runSearch());
    }
  }

  invalidate(): void {
    // No cached render state — nothing to clear.
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // ── Query bar ──────────────────────────────────────────────────────────
    const queryPrefix = "> ";
    const queryDisplay = this.query + (this.focused ? CURSOR_MARKER : "");
    lines.push(queryPrefix + queryDisplay);
    lines.push("─".repeat(width));

    // ── Searching indicator ────────────────────────────────────────────────
    if (this.searching) {
      lines.push("  Searching…");
      return lines;
    }

    // ── Empty state ────────────────────────────────────────────────────────
    if (this.results.length === 0) {
      if (this.query.trim()) {
        lines.push("  No sessions match this query");
      } else {
        lines.push("  Type a query to search sessions");
      }
      return lines;
    }

    // ── Result cards ───────────────────────────────────────────────────────
    for (let i = 0; i < this.results.length; i++) {
      const result = this.results[i];
      const digest = this.index.getDigest(result.session.id);
      const selected = i === this.selectedIndex;
      const cardLines = renderCard(result, digest, selected, width, this.theme);
      lines.push(...cardLines);
      // Separator between cards (not after the last one)
      if (i < this.results.length - 1) {
        lines.push("");
      }
    }

    return lines;
  }

  handleInput(data: string): void {
    // Arrow Up
    if (data === "\x1b[A") {
      this.moveUp();
      this.requestRender();
      return;
    }
    // Arrow Down
    if (data === "\x1b[B") {
      this.moveDown();
      this.requestRender();
      return;
    }
    // Enter
    if (data === "\r" || data === "\n") {
      this.confirm();
      return;
    }
    // Esc
    if (data === "\x1b") {
      this.done(undefined);
      return;
    }
    // Backspace / DEL
    if (data === "\x7f" || data === "\b") {
      this.query = this.query.slice(0, -1);
      this.scheduleSearch();
      this.requestRender();
      return;
    }
    // Ctrl+U — clear query
    if (data === "\x15") {
      this.query = "";
      this.scheduleSearch();
      this.requestRender();
      return;
    }
    // Printable characters
    if (data.length === 1 && data >= " ") {
      this.query += data;
      this.scheduleSearch();
      this.requestRender();
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private requestRender(): void {
    (this.tui as any).requestRender?.();
  }

  private moveUp(): void {
    if (this.selectedIndex > 0) this.selectedIndex--;
  }

  private moveDown(): void {
    if (this.selectedIndex < this.results.length - 1) this.selectedIndex++;
  }

  private confirm(): void {
    if (this.results.length === 0) return;
    const selected = this.results[this.selectedIndex];
    this.done(selected.session.file);
  }

  private scheduleSearch(): void {
    if (this.searchTimeout !== null) clearTimeout(this.searchTimeout);
    this.searchTimeout = setTimeout(() => this.runSearch(), this.debounceMs);
  }

  private async runSearch(): Promise<void> {
    this.searchTimeout = null;
    const q = this.query.trim();
    if (!q) {
      this.results = [];
      this.selectedIndex = 0;
      this.searching = false;
      this.requestRender();
      return;
    }
    this.searching = true;
    this.requestRender();
    try {
      this.results = await this.index.search(q, 25);
      this.selectedIndex = 0;
    } catch {
      this.results = [];
      this.selectedIndex = 0;
    }
    this.searching = false;
    this.requestRender();
  }
}

// ─── Command registration ─────────────────────────────────────────────────────

/**
 * Register the `/find-session` command on the given ExtensionAPI.
 *
 * Call this from src/index.ts (Phase 10) after creating the index:
 *
 *   registerFindSessionCommand(pi, { index });
 *
 * The command takes the rest-of-line as an initial query (may be empty),
 * opens a TUI overlay, and switches to the selected session on Enter.
 * Esc dismisses without switching.
 *
 * NOTE: src/index.ts is NOT touched in Phase 9 (task 9.6). This export is
 * the only bridge between Phase 9 and Phase 10.
 */
export function registerFindSessionCommand(
  pi: ExtensionAPI,
  deps: { index: SearchableIndex },
): void {
  pi.registerCommand("find-session", {
    description: "Search sessions by content and switch to a matching session",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const initialQuery = args.trim();

      const sessionPath = await ctx.ui.custom<string | undefined>(
        (tui, theme, _keybindings, done) => {
          const component = new FindSessionOverlayComponent(
            tui,
            theme,
            done,
            deps.index,
            initialQuery,
          );
          return component;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "80%",
            maxHeight: "70%",
            anchor: "top-center",
            offsetY: 2,
          },
        },
      );

      if (sessionPath) {
        await ctx.switchSession(sessionPath);
      }
    },
  });
}

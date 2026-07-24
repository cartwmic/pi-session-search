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
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { SearchResult } from "../index/session-index.js";
import type { Verdict } from "../index/mode.js";
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
 * Place plain-text `left` and `right` on a single line of `width` columns,
 * applying `styleLeft` to the (already truncated) left text after layout so
 * ANSI escapes can never be chopped mid-sequence.
 */
function splitLine(
  left: string,
  right: string,
  width: number,
  styleLeft: (s: string) => string = (s) => s,
): string {
  const rightLen = right.length;
  const leftMax = width - rightLen - 1;
  if (leftMax <= 0) return styleLeft("") + " " + right;
  const leftPlain = padEnd(left.slice(0, leftMax), leftMax);
  return styleLeft(leftPlain) + " " + right;
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
  lines.push(
    marker +
      splitLine(headline, date, innerWidth, (s) => theme.bold(s)),
  );

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
// Maximum number of result cards to render in the visible viewport. Keeps the
// overlay bounded so it can't outgrow the terminal as the user scrolls down.
const MAX_VISIBLE_CARDS = 5;

export class FindSessionOverlayComponent implements Component, Focusable {
  focused: boolean = false;
  wantsKeyRelease = false;

  private query: string;
  private results: SearchResult[] = [];
  private selectedIndex: number = 0;
  private scrollOffset: number = 0;
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
    // Reserve 2 columns for the left/right border, plus 1 column of inner
    // padding on each side so content doesn't touch the frame.
    const frameOverhead = 4; // "│ " + " │"
    const innerWidth = Math.max(width - frameOverhead, 10);
    const horizontalRun = innerWidth + 2; // run between corners (covers padding)

    const border = (s: string) => this.theme.fg("border", s);
    const top = border("┌" + "─".repeat(horizontalRun) + "┐");
    const sep = border("├" + "─".repeat(horizontalRun) + "┤");
    const bottom = border("└" + "─".repeat(horizontalRun) + "┘");
    const side = border("│");

    // Wrap a single content line with side borders, padding/truncating to innerWidth.
    const wrap = (line: string): string => {
      const w = visibleWidth(line);
      let body: string;
      if (w > innerWidth) {
        body = truncateToWidth(line, innerWidth, "…", false);
        // truncateToWidth may not pad; ensure exact width.
        const bw = visibleWidth(body);
        if (bw < innerWidth) body = body + " ".repeat(innerWidth - bw);
      } else {
        body = line + " ".repeat(innerWidth - w);
      }
      return `${side} ${body} ${side}`;
    };

    // ── Build inner content (no borders yet) ───────────────────────────────
    const content: string[] = [];

    // Query bar
    const queryPrefix = "> ";
    const queryDisplay = this.query + (this.focused ? CURSOR_MARKER : "");
    content.push(queryPrefix + queryDisplay);
    // Marker so we can splice the in-frame separator at the right spot.
    const SEP_MARKER = "\u0000__SEP__\u0000";
    content.push(SEP_MARKER);

    if (this.searching) {
      content.push("  Searching…");
    } else if (this.results.length === 0) {
      if (this.query.trim()) {
        content.push("  No sessions match this query");
      } else {
        content.push("  Type a query to search sessions");
      }
    } else {
      // Keep the selected card in view by adjusting scrollOffset.
      const total = this.results.length;
      const visible = Math.min(MAX_VISIBLE_CARDS, total);
      if (this.selectedIndex < this.scrollOffset) {
        this.scrollOffset = this.selectedIndex;
      } else if (this.selectedIndex >= this.scrollOffset + visible) {
        this.scrollOffset = this.selectedIndex - visible + 1;
      }
      this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, total - visible));

      const start = this.scrollOffset;
      const end = Math.min(start + visible, total);

      if (start > 0) {
        content.push(this.theme.fg("dim", `  ↑ ${start} more above`));
      }
      for (let i = start; i < end; i++) {
        const result = this.results[i];
        const digest = this.index.getDigest(result.session.id);
        const selected = i === this.selectedIndex;
        const cardLines = renderCard(result, digest, selected, innerWidth, this.theme);
        content.push(...cardLines);
        if (i < end - 1) {
          content.push("");
        }
      }
      if (end < total) {
        content.push(this.theme.fg("dim", `  ↓ ${total - end} more below`));
      }
    }

    // ── Compose with frame ────────────────────────────────────────────────
    const lines: string[] = [];
    lines.push(top);
    for (const c of content) {
      if (c === SEP_MARKER) {
        lines.push(sep);
      } else {
        lines.push(wrap(c));
      }
    }
    lines.push(bottom);
    return lines;
  }

  handleInput(data: string): void {
    // Use pi-tui's protocol-aware key matching rather than raw byte comparison.
    // Under the Kitty keyboard protocol (which pi-tui enables via `CSI > 7 u`),
    // Escape is reported as `\x1b[27u`, NOT a lone `\x1b` — so a raw
    // `data === "\x1b"` check silently fails and the overlay becomes
    // impossible to dismiss (most visible when there are no results and Enter
    // is a no-op). matchesKey() handles both legacy and Kitty encodings.
    // Arrow Up
    if (matchesKey(data, "up")) {
      this.moveUp();
      this.requestRender();
      return;
    }
    // Arrow Down
    if (matchesKey(data, "down")) {
      this.moveDown();
      this.requestRender();
      return;
    }
    // Enter
    if (matchesKey(data, "enter")) {
      this.confirm();
      return;
    }
    // Esc
    if (matchesKey(data, "escape")) {
      this.done(undefined);
      return;
    }
    // Backspace / DEL
    if (matchesKey(data, "backspace")) {
      this.query = this.query.slice(0, -1);
      this.scheduleSearch();
      this.requestRender();
      return;
    }
    // Ctrl+U — clear query
    if (matchesKey(data, "ctrl+u")) {
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

  private resetScroll(): void {
    this.scrollOffset = 0;
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
      this.resetScroll();
    } catch {
      this.results = [];
      this.selectedIndex = 0;
      this.resetScroll();
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
  deps: { index: SearchableIndex; getCurrentVerdict?: () => Verdict | null },
): void {
  pi.registerCommand("find-session", {
    description: "Search sessions by content and switch to a matching session",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const verdict = deps.getCurrentVerdict?.();
      if (verdict?.kind === "misconfigured") {
        ctx.ui.notify(verdict.notifyMessage, "error");
        return;
      }
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

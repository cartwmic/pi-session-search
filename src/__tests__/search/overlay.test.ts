/**
 * Tests for src/search/overlay.ts
 *
 * Task 9.7: (a) renders cards from injected fake index results; (b) ↑/↓ moves
 * selection; (c) Enter resolves overlay's done(sessionPath); (d) empty results →
 * empty-state card; (e) Esc dismisses without switchSession (done(undefined)).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FindSessionOverlayComponent } from "../../search/overlay.js";
import type { SearchableIndex } from "../../search/overlay.js";
import type { SearchResult } from "../../index/session-index.js";
import type { SessionDigest } from "../../digest/schema.js";

// ─── Minimal fakes ────────────────────────────────────────────────────────────

/** Fake TUI — just tracks requestRender call count. */
function makeFakeTui() {
  let renderCount = 0;
  return {
    requestRender() { renderCount++; },
    get renders() { return renderCount; },
  };
}

/** Fake Theme — returns text unchanged (no ANSI). */
const fakeTheme = {
  bold: (t: string) => t,
  italic: (t: string) => t,
  underline: (t: string) => t,
  inverse: (t: string) => t,
  strikethrough: (t: string) => t,
  fg: (_color: string, t: string) => t,
  bg: (_color: string, t: string) => t,
} as any;

/** Fake keybindings — not used by the overlay. */
const fakeKeybindings = {} as any;

/** Build a minimal ParsedSession for use in SearchResult. */
function makeSession(overrides: {
  id?: string;
  name?: string;
  file?: string;
  endedAt?: string;
} = {}) {
  return {
    id: overrides.id ?? "sess-001",
    name: overrides.name ?? "Test Session",
    file: overrides.file ?? "/home/user/.pi/sessions/--proj--/sess-001.jsonl",
    startedAt: "2026-04-28T10:00:00Z",
    endedAt: overrides.endedAt ?? "2026-04-28T12:00:00Z",
    cwd: "/home/user/proj",
    archived: false,
    projectSlug: "--proj--",
    models: ["gpt-5.4-mini"],
    userMessageCount: 5,
    assistantMessageCount: 5,
    toolCalls: [],
    filesRead: [],
    filesModified: [],
    firstUserMessage: "first message",
    userMessages: [],
    assistantText: "",
    compactionSummaries: [],
    branchSummaries: [],
  };
}

/** Build a minimal SearchResult. */
function makeResult(overrides: {
  id?: string;
  name?: string;
  file?: string;
} = {}): SearchResult {
  return {
    session: makeSession(overrides) as any,
    summary: "A short summary of the session",
    score: 0.9,
  };
}

/** Build a minimal SessionDigest. */
function makeDigest(overrides: {
  headline?: string;
  topics?: string[];
  body?: string;
} = {}): SessionDigest {
  return {
    schemaVersion: 1,
    headline: overrides.headline ?? "Implemented authentication module",
    topics: overrides.topics ?? ["auth", "jwt", "typescript"],
    body: overrides.body ?? "The session focused on implementing a JWT-based authentication module. "
      + "We set up the token signing and validation logic, added middleware for route "
      + "protection, and wrote tests for the auth endpoints.",
    outcome: "Authentication module fully implemented with tests passing.",
    generatedAt: "2026-04-28T12:00:00Z",
    modelId: "openai-codex/gpt-5.4-mini",
    inputTokenCount: 3200,
    cost: 0.0004,
  };
}

/** Build a fake index that returns given results and digests. */
function makeFakeIndex(
  results: SearchResult[] = [],
  digests: Record<string, SessionDigest> = {},
): SearchableIndex {
  return {
    async search(_query, _limit) {
      return results;
    },
    getDigest(sessionId) {
      return digests[sessionId] ?? null;
    },
  };
}

/** Wait for all microtasks and a turn of the event loop to settle. */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("FindSessionOverlayComponent", () => {

  // ── (a) renders cards from injected fake index results ─────────────────────

  describe("render: cards from fake index results", () => {
    it("renders headline and topics for each result with a digest", async () => {
      const digest = makeDigest({ headline: "Auth refactor", topics: ["auth", "jwt"] });
      const result = makeResult({ id: "sess-001" });
      const index = makeFakeIndex([result], { "sess-001": digest });

      let doneResult: string | undefined = undefined;
      const done = (r: string | undefined) => { doneResult = r; };
      const tui = makeFakeTui();

      const component = new FindSessionOverlayComponent(
        tui as any, fakeTheme, done, index, "auth", 0,
      );

      // Wait for initial microtask search to complete
      await flushAsync();

      const lines = component.render(100);
      const joined = lines.join("\n");

      assert.ok(joined.includes("Auth refactor"), "Should include headline");
      assert.ok(joined.includes("auth, jwt"), "Should include topics");
    });

    it("renders body excerpt (up to 3 lines)", async () => {
      const longBody = "Line one of the body.\nLine two of the body.\nLine three of the body.\nLine four should be truncated.";
      const digest = makeDigest({ body: longBody });
      const result = makeResult({ id: "sess-002" });
      const index = makeFakeIndex([result], { "sess-002": digest });

      let done = (_r: string | undefined) => {};
      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, done, index, "body", 0,
      );
      await flushAsync();

      const lines = component.render(100);
      const joined = lines.join("\n");

      assert.ok(joined.includes("Line one"), "should include first body line");
      assert.ok(joined.includes("Line two"), "should include second body line");
      assert.ok(joined.includes("Line three"), "should include third body line");
      assert.ok(!joined.includes("Line four should be truncated"), "fourth body line should be truncated");
    });

    it("renders file path (dim) for each card", async () => {
      const result = makeResult({ id: "sess-003", file: "/home/user/.pi/sessions/proj/sess-003.jsonl" });
      const index = makeFakeIndex([result], {});

      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, (_r) => {}, index, "proj", 0,
      );
      await flushAsync();

      const lines = component.render(100);
      const joined = lines.join("\n");
      assert.ok(joined.includes("sess-003.jsonl"), "should render file path");
    });

    it("uses session.name as headline when no digest is available", async () => {
      const result = makeResult({ id: "sess-004", name: "My fallback name" });
      const index = makeFakeIndex([result], {});

      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, (_r) => {}, index, "fallback", 0,
      );
      await flushAsync();

      const lines = component.render(100);
      assert.ok(lines.join("\n").includes("My fallback name"), "should use session.name as fallback headline");
    });

    it("renders the query bar at top", async () => {
      const index = makeFakeIndex([], {});
      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, (_r) => {}, index, "hello", 0,
      );
      await flushAsync();

      const lines = component.render(80);
      // Line 0 is the top border; line 1 is the query bar (wrapped in side borders).
      assert.ok(lines[1].includes("> "), "second line should contain the query bar prompt");
      assert.ok(lines[1].includes("hello"), "query bar should show current query");
    });
  });

  // ── (b) ↑/↓ moves selection ───────────────────────────────────────────────

  describe("keyboard: ↑/↓ navigation", () => {
    it("down arrow moves selection to next card", async () => {
      const r1 = makeResult({ id: "s1", name: "Alpha Session" });
      const r2 = makeResult({ id: "s2", name: "Beta Session" });
      const d1 = makeDigest({ headline: "Alpha Headline" });
      const d2 = makeDigest({ headline: "Beta Headline" });
      const index = makeFakeIndex([r1, r2], { s1: d1, s2: d2 });

      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, (_r) => {}, index, "session", 0,
      );
      await flushAsync();

      // Initially first card is selected (▶)
      const before = component.render(80);
      const firstCardBefore = before.find(l => l.includes("Alpha Headline"));
      assert.ok(firstCardBefore?.includes("▶"), "first card should be selected initially");

      // Press down
      component.handleInput("\x1b[B");

      const after = component.render(80);
      const secondCardAfter = after.find(l => l.includes("Beta Headline"));
      assert.ok(secondCardAfter?.includes("▶"), "second card should be selected after down arrow");
    });

    it("up arrow moves selection to previous card", async () => {
      const r1 = makeResult({ id: "s1" });
      const r2 = makeResult({ id: "s2", name: "Second" });
      const d2 = makeDigest({ headline: "Second Headline" });
      const index = makeFakeIndex([r1, r2], { s2: d2 });

      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, (_r) => {}, index, "q", 0,
      );
      await flushAsync();

      // Move down first
      component.handleInput("\x1b[B");
      // Now move back up
      component.handleInput("\x1b[A");

      const lines = component.render(80);
      // First result should be selected again — check it starts with ▶
      // r1 has no digest, fallback to session.name = "Test Session"
      const firstLine = lines.find(l => l.includes("Test Session"));
      assert.ok(firstLine?.includes("▶"), "first card should be selected again after up arrow");
    });

    it("down arrow does not go past the last result", async () => {
      const r1 = makeResult({ id: "only" });
      const index = makeFakeIndex([r1], {});

      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, (_r) => {}, index, "q", 0,
      );
      await flushAsync();

      // Press down multiple times
      component.handleInput("\x1b[B");
      component.handleInput("\x1b[B");
      component.handleInput("\x1b[B");

      const lines = component.render(80);
      // Should still show the single card as selected
      assert.ok(lines.some(l => l.includes("▶")), "card should still be selected");
    });

    it("up arrow does not go before the first result", async () => {
      const r1 = makeResult({ id: "only" });
      const index = makeFakeIndex([r1], {});

      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, (_r) => {}, index, "q", 0,
      );
      await flushAsync();

      component.handleInput("\x1b[A");
      component.handleInput("\x1b[A");

      const lines = component.render(80);
      assert.ok(lines.some(l => l.includes("▶")), "card should still be selected");
    });
  });

  // ── (c) Enter resolves done(sessionPath) ──────────────────────────────────

  describe("keyboard: Enter confirms selection", () => {
    it("Enter calls done with the selected session file path", async () => {
      const path = "/home/user/.pi/sessions/proj/sess-enter.jsonl";
      const result = makeResult({ id: "s-enter", file: path });
      const index = makeFakeIndex([result], {});

      let resolvedWith: string | undefined = "NOT_SET";
      const done = (r: string | undefined) => { resolvedWith = r; };

      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, done, index, "enter", 0,
      );
      await flushAsync();

      component.handleInput("\r");

      assert.equal(resolvedWith, path, "done should be called with session file path");
    });

    it("Enter calls done with path of second card when second is selected", async () => {
      const path1 = "/path/to/sess-1.jsonl";
      const path2 = "/path/to/sess-2.jsonl";
      const r1 = makeResult({ id: "s1", file: path1 });
      const r2 = makeResult({ id: "s2", file: path2 });
      const index = makeFakeIndex([r1, r2], {});

      let resolvedWith: string | undefined;
      const done = (r: string | undefined) => { resolvedWith = r; };

      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, done, index, "q", 0,
      );
      await flushAsync();

      // Select second card
      component.handleInput("\x1b[B");
      // Confirm
      component.handleInput("\r");

      assert.equal(resolvedWith, path2, "done should be called with second session path");
    });

    it("Enter does nothing (no done call) when there are no results", async () => {
      const index = makeFakeIndex([], {});

      let called = false;
      const done = (_r: string | undefined) => { called = true; };

      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, done, index, "no-match", 0,
      );
      await flushAsync();

      component.handleInput("\r");
      assert.equal(called, false, "done should not be called with no results");
    });
  });

  // ── (d) empty results → empty-state card ─────────────────────────────────

  describe("render: empty state", () => {
    it("shows empty-state message when no results", async () => {
      const index = makeFakeIndex([], {});

      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, (_r) => {}, index, "nomatches", 0,
      );
      await flushAsync();

      const lines = component.render(80);
      assert.ok(
        lines.some(l => l.includes("No sessions match this query")),
        "should show empty-state message when no results for non-empty query",
      );
    });

    it("shows prompt when query is empty", async () => {
      const index = makeFakeIndex([], {});

      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, (_r) => {}, index, "", 0,
      );
      await flushAsync();

      const lines = component.render(80);
      assert.ok(
        lines.some(l => l.includes("Type a query")),
        "should show type-a-query prompt for empty query",
      );
    });
  });

  // ── (e) Esc dismisses without invoking switchSession ──────────────────────

  describe("keyboard: Esc dismisses overlay", () => {
    it("Esc calls done(undefined)", async () => {
      const result = makeResult({ id: "s-esc" });
      const index = makeFakeIndex([result], {});

      let resolvedWith: string | undefined = "NOT_SET";
      const done = (r: string | undefined) => { resolvedWith = r; };

      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, done, index, "esc-test", 0,
      );
      await flushAsync();

      component.handleInput("\x1b");

      assert.equal(resolvedWith, undefined, "done should be called with undefined on Esc");
    });

    it("Esc does not call done with a session path (switchSession not invoked)", async () => {
      const path = "/path/to/sess.jsonl";
      const result = makeResult({ id: "s-esc2", file: path });
      const index = makeFakeIndex([result], {});

      const calls: (string | undefined)[] = [];
      const done = (r: string | undefined) => { calls.push(r); };

      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, done, index, "q", 0,
      );
      await flushAsync();

      component.handleInput("\x1b");

      assert.equal(calls.length, 1, "done should be called exactly once");
      assert.equal(calls[0], undefined, "done should be called with undefined, not a path");
    });
  });

  // ── Additional: query editing ─────────────────────────────────────────────

  describe("query editing", () => {
    it("backspace removes last character from query", async () => {
      const index = makeFakeIndex([], {});
      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, (_r) => {}, index, "hello", 0,
      );
      await flushAsync();

      component.handleInput("\x7f");
      const lines = component.render(80);
      assert.ok(lines[1].includes("hell"), "query bar should show 'hell' after backspace");
      assert.ok(!lines[1].includes("hello"), "query bar should not include 'o' after backspace");
    });

    it("typing characters appends to query", async () => {
      const index = makeFakeIndex([], {});
      const component = new FindSessionOverlayComponent(
        makeFakeTui() as any, fakeTheme, (_r) => {}, index, "auth", 0,
      );
      await flushAsync();

      component.handleInput("x");
      const lines = component.render(80);
      assert.ok(lines[1].includes("authx"), "typed char should be appended to query");
    });
  });
});

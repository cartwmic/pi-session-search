/**
 * The "Recent Sessions" primer must never change the system prompt. A changing
 * system prompt makes Anthropic's prompt cache re-write the whole conversation
 * (measured: ~24% of spend). It goes out once, at session_start, as a hidden message.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import extension, { _setIndexWorkerEnabled } from "../index";
import { FtsSessionIndex } from "../index/fts-index";
import { createFakeHost, writeSession } from "./helpers/fake-pi";

_setIndexWorkerEnabled(false);

const ROOT = join(import.meta.dirname, "__tmp_primer__");

async function seededHost() {
  const host = createFakeHost(ROOT, extension);
  writeSession(host.sessionsDir, "p-a", "alpha refactor of the parser");
  writeSession(host.sessionsDir, "p-b", "beta lambda timeout");
  const seed = new FtsSessionIndex(host.indexDir, [], [], join(ROOT, "sessions"), join(ROOT, "archive"));
  await seed.load();
  await seed.sync();
  seed.close();
  return host;
}

describe("session primer", () => {
  it("two consecutive runs send an identical system prompt", async () => {
    const host = await seededHost();
    try {
      await host.start();
      assert.match(host.primer() ?? "", /Recent Sessions/, "the primer was produced");
      const first = await host.systemPromptFor("BASE SYSTEM PROMPT");
      await new Promise((r) => setTimeout(r, 1100)); // time passes between runs
      const second = await host.systemPromptFor("BASE SYSTEM PROMPT");
      assert.equal(first, "BASE SYSTEM PROMPT");
      assert.equal(second, first);
    } finally {
      await host.shutdown();
      host.cleanup();
    }
  });

  it("sends one hidden message at session start, with no relative ages, and not again on reload", async () => {
    const host = await seededHost();
    try {
      await host.start();
      assert.equal(host.sent.length, 1);
      const { message } = host.sent[0];
      assert.equal(message.customType, "pi-session-search-primer");
      assert.equal(message.display, false);
      assert.match(message.content, /alpha refactor of the parser/);
      assert.doesNotMatch(message.content, /\bago\b|just now/, "relative ages would be stale");
      await host.start(); // /reload runs session_start again; the session already has its primer
      assert.equal(host.sent.length, 1);
    } finally {
      await host.shutdown();
      host.cleanup();
    }
  });
});

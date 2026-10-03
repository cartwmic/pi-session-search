import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { spawnIndexWorker } from "../index-service";
import { SessionIndex } from "../index/session-index";
import { parseSession } from "../parser";
import { createFakeHost, writeSession } from "./helpers/fake-pi";
import extension, { _setIndexWorkerEnabled } from "../index";
import type { SessionDigest } from "../digest/schema";

const digest: SessionDigest = {
  schemaVersion: 1, body: "A cobalt migration was completed and verified against the parser fixture.",
  headline: "Cobalt migration", topics: ["cobalt"], generatedAt: "2026-01-15T10:01:00Z",
  modelId: "dummy/dummy", inputTokenCount: 10, cost: 0,
};

it("digest worker serializes backfill, embeds digests, and returns digest metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "digest-worker-"));
  const sessions = join(root, "sessions", "--tmp-proj--");
  let embeddings = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    embeddings += body.input.length;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: body.input.map((_: unknown, index: number) => ({ index, embedding: [1, 0, 0] })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  let threads = 0;
  const onWorker = () => { threads++; };
  subscribe("worker_threads", onWorker);
  const crashes: Error[] = [];
  const index = spawnIndexWorker(join(import.meta.dirname, "../../dist/index-worker.js"), {
    indexDir: join(root, "index"), extraSessionDirs: [], extraArchiveDirs: [],
    sessionDir: join(root, "sessions"), archiveDir: join(root, "archive"), digestHybrid: true,
    embedder: { baseUrl: `http://127.0.0.1:${port}`, model: "dummy", apiKey: "dummy" },
  }, (error) => crashes.push(error));
  try {
    writeSession(sessions, "cobalt-fixture", "raw needle before digest");
    await index.load();
    assert.equal((await index.sync()).added, 1);
    assert.equal((await index.search("needle", 5))[0].session.id, "cobalt-fixture");
    await index.setBackfillInProgress(true);
    assert.deepEqual(await index.sync(), { added: 0, updated: 0, removed: 0, moved: 0 });
    const parsed = parseSession(join(sessions, "cobalt-fixture.jsonl"), false)!;
    await index.addDigested(parsed.id, parsed, digest, { batched: true });
    await index.flush();
    await index.setBackfillInProgress(false);
    assert.equal((await index.getDigest(parsed.id))?.headline, "Cobalt migration");
    assert.equal((await index.search("cobalt", 5, "proj"))[0].session.id, parsed.id);
    assert.deepEqual(await index.search("cobalt", 5, "nonexistent-project"), []);
    assert.match((await index.get(parsed.id))!.summary, /cobalt/i);
    const persisted = JSON.parse(readFileSync(join(root, "index/session-index.json"), "utf8"));
    assert.ok(persisted.sessions[parsed.id].embedding);
    assert.equal(embeddings, 2); // One digest and one query; pre-digest search is FTS-only.
    assert.equal(threads, 1);
    assert.deepEqual(crashes, []);
  } finally {
    unsubscribe("worker_threads", onWorker);
    await index.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

it("digest JSON sync adopts another indexer's on-disk metadata before comparing files", async () => {
  const root = mkdtempSync(join(tmpdir(), "digest-multiprocess-"));
  const options = [join(root, "index"), [], [], "digest-hybrid", join(root, "sessions"), join(root, "archive")] as const;
  const embedder = { embed: async () => [1, 0, 0], embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0]) };
  const a = new SessionIndex(embedder, ...options);
  const b = new SessionIndex(embedder, ...options);
  try {
    await a.load();
    await b.load();
    writeSession(join(root, "sessions", "--tmp-proj--"), "shared", "shared cobalt content");
    assert.equal((await a.sync()).added, 1);
    assert.deepEqual(await b.sync(), { added: 0, updated: 0, removed: 0, moved: 0 });
    assert.equal(b.size(), 1);
  } finally {
    a.dispose();
    b.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it("primer.enabled=false suppresses the fork's system-prompt primer", async () => {
  const root = mkdtempSync(join(tmpdir(), "digest-primer-"));
  _setIndexWorkerEnabled(false);
  const host = createFakeHost(root, extension, { primer: { enabled: false }, sync: { interval: -1 } });
  try {
    writeSession(host.sessionsDir, "primer", "primer cobalt fixture");
    await host.start();
    assert.equal(await host.primer(), undefined);
  } finally {
    await host.shutdown();
    host.cleanup();
    _setIndexWorkerEnabled(true);
  }
});

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createEmbedder } from "../embedder";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installEmbeddingFetch(assertBody: (body: Record<string, unknown>) => void): void {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(init?.body, "expected JSON request body");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    assertBody(body);
    return new Response(
      JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

describe("createEmbedder OpenAI-compatible response indices", () => {
  it("embeds a single response item without an index", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200 })) as typeof fetch;

    const embedder = createEmbedder({
      apiKey: "test-key",
      baseUrl: "https://example.test",
      model: "gemini-embedding-001",
    });

    assert.deepEqual(await embedder.embed("hello"), [0.1, 0.2, 0.3]);
  });

  it("uses response positions for omitted indices across multiple batches", async () => {
    const batchSizes: number[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      batchSizes.push(input.length);
      return new Response(JSON.stringify({
        data: input.map((text) => ({ embedding: [Number(text)] })),
      }), { status: 200 });
    }) as typeof fetch;

    const embedder = createEmbedder({
      apiKey: "test-key",
      baseUrl: "https://example.test",
      model: "gemini-embedding-001",
    });
    const texts = Array.from({ length: 102 }, (_, i) => String(i));

    assert.deepEqual(await embedder.embedBatch(texts), texts.map((text) => [Number(text)]));
    assert.deepEqual(batchSizes, [100, 2]);
  });
});

describe("createEmbedder OpenAI-compatible dimensions", () => {
  it("does not send dimensions for openai-compatible providers by default", async () => {
    installEmbeddingFetch((body) => {
      assert.equal(body.model, "qwen3-embedding");
      assert.equal("dimensions" in body, false);
    });

    const embedder = createEmbedder({
      apiKey: "test-key",
      baseUrl: "https://example.test",
      model: "qwen3-embedding",
      dimensions: 512,
    });

    assert.deepEqual(await embedder.embed("hello"), [0.1, 0.2, 0.3]);
  });

  it("sends dimensions for openai-compatible providers when explicitly enabled", async () => {
    installEmbeddingFetch((body) => {
      assert.equal(body.dimensions, 512);
    });

    const embedder = createEmbedder({
      apiKey: "test-key",
      baseUrl: "https://example.test",
      model: "text-embedding-3-small",
      dimensions: 512,
      sendDimensions: true,
    });

    await embedder.embed("hello");
  });

  it("continues to send dimensions for an explicitly enabled first-party OpenAI endpoint", async () => {
    installEmbeddingFetch((body) => {
      assert.equal(body.dimensions, 512);
    });

    const embedder = createEmbedder({
      baseUrl: "https://api.openai.com",
      sendDimensions: true,
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dimensions: 512,
    });

    await embedder.embed("hello");
  });
});

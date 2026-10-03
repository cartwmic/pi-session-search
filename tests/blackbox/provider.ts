// Scripted backend only. No external requests, credentials or paid models.
import { createServer } from "node:http";
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";

export default async function (pi: any) {
  const base = process.env.PI_SESSION_SEARCH_HOME!;
  const trace = join(base, "backend.log");
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    appendFileSync(trace, `EMBED ${body.input.length} texts\n`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: body.input.map((_: unknown, index: number) => ({ index, embedding: [1, 0, 0] })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  writeFileSync(join(base, "config.json"), JSON.stringify({
    embedder: { baseUrl: `http://127.0.0.1:${port}`, model: "scripted-embedding", apiKey: "dummy" },
    sync: { interval: -1 }, primer: { enabled: false },
  }));
  pi.on("session_shutdown", () => { server.close(); });
  pi.registerProvider("sync-fixture", {
    baseUrl: "http://scripted.invalid", apiKey: "dummy", api: "sync-fixture",
    models: [{ id: "dummy", name: "Dummy (no network)", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 2000 }],
    streamSimple(model: any, context: any) {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        const digest = getCurrentTools(context.messages).some((tool: any) => tool.name === "submit_digest");
        const toolResult = context.messages.findLast((m: any) => m.role === "toolResult");
        let content: any[], stopReason: string;
        if (digest) {
          appendFileSync(trace, "DIGEST via host registry: submit_digest\n");
          content = [{ type: "toolCall", id: "digest-call", name: "submit_digest", arguments: {
            headline: "Fixture cobalt migration", topics: ["cobalt"],
            body: "The fixture session documents a cobalt migration and its validation. The parser was updated and verified against the expected fixture without external dependencies.",
            outcome: "Fixture migration verified.",
          } }];
          stopReason = "toolUse";
        } else if (!toolResult) {
          appendFileSync(trace, "SEARCH via Pi agent tool call\n");
          content = [{ type: "toolCall", id: "search-call", name: "session_search", arguments: { query: "cobalt", limit: 5 } }];
          stopReason = "toolUse";
        } else {
          const text = JSON.stringify(toolResult.content);
          if (!text.includes("fixture-cobalt") || !text.includes("Fixture cobalt migration")) {
            throw new Error(`Black-box search failed: ${text}`);
          }
          appendFileSync(trace, `SEARCH RESULT ${text}\n`);
          content = [{ type: "text", text: "BLACKBOX PASS: Pi session_search returned fixture-cobalt with its generated digest headline." }];
          stopReason = "stop";
        }
        const message: any = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
          content, stopReason, timestamp: Date.now(),
          usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: stopReason, message });
        stream.end(message);
      });
      return stream;
    },
  });
}

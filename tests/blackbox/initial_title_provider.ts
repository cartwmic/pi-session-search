// Scripted backend only. No external requests, credentials or paid models.
import { createServer } from "node:http";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";

export default async function (pi: any) {
  const base = process.env.PI_SESSION_SEARCH_HOME!;
  // Scripted embedder so the extension runs in digest-hybrid mode.
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: body.input.map((_: unknown, index: number) => ({ index, embedding: [1, 0, 0] })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(base, "config.json"), JSON.stringify({
    embedder: { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, model: "scripted-embedding", apiKey: "dummy" },
    sync: { interval: -1 }, primer: { enabled: false },
  }));
  pi.on("session_shutdown", () => { server.close(); });
  const trace = join(base, "backend.log");
  const release = join(base, "release-agent");
  pi.registerProvider("title-fixture", {
    baseUrl: "http://scripted.invalid", apiKey: "dummy", api: "title-fixture",
    models: ["agent", "digester"].map((id) => ({ id, name: id, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2000 })),
    streamSimple(model: any, context: any) {
      const stream = new AssistantMessageEventStream();
      const finish = (content: any[], stopReason: string) => {
        const message: any = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
          content, stopReason, timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: stopReason, message });
        stream.end(message);
      };
      const run = async () => {
        if (JSON.stringify(context).includes("You name coding-agent sessions")) {
          const prompt = JSON.stringify(context.messages);
          appendFileSync(trace, `TITLE model=${model.id} prompt=${prompt.includes("cobalt parser") ? "first" : "other"}\n`);
          finish([{ type: "text", text: "Fix cobalt parser trailing commas" }], "stop");
        } else if (getCurrentTools(context.messages).some((t: any) => t.name === "submit_digest")) {
          appendFileSync(trace, `DIGEST model=${model.id}\n`);
          finish([{ type: "toolCall", id: "d", name: "submit_digest", arguments: {
            headline: "Digest headline", topics: ["cobalt"],
            body: "The session fixed the cobalt parser so trailing commas no longer drop fields. The change was verified against a scripted fixture without external dependencies.",
            outcome: "Parser fixed.",
          } }], "toolUse");
        } else {
          appendFileSync(trace, `AGENT model=${model.id} waiting\n`);
          while (!existsSync(release)) await new Promise((r) => setTimeout(r, 50));
          finish([{ type: "text", text: "done" }], "stop");
        }
      };
      queueMicrotask(() => { void run(); });
      return stream;
    },
  });
}

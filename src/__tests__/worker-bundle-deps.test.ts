/**
 * The index worker is a plain Node worker thread. Unlike the main extension
 * module, Pi's loader does not resolve host packages (typebox, @earendil-works/*)
 * for it, and Pi installs git packages without devDependencies or peers.
 * Every bare import left in dist/index-worker.js must therefore be a runtime
 * dependency; anything else has to be bundled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

test("worker bundle imports only node builtins and runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const deps = new Set(Object.keys(pkg.dependencies ?? {}));
  const src = readFileSync(join(root, "dist/index-worker.js"), "utf8");
  const specifiers = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gms)].map((m) => m[1]);
  const bare = specifiers.filter((s) => !s.startsWith("node:") && !s.startsWith("."));
  const packageName = (s: string) => (s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);
  const unresolvable = [...new Set(bare.map(packageName))].filter((name) => !deps.has(name));
  assert.deepEqual(unresolvable, [], `worker imports packages a production install lacks: ${unresolvable.join(", ")}`);
});

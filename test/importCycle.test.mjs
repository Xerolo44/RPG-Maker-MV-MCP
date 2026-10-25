import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (rel) => path.join(root, "dist", rel);

// Each module must load as the very first import of a fresh process: an ESM import cycle breaks
// exactly when the module that completes the cycle is evaluated first.
for (const rel of ["dialogueTree.js", "eventTemplates.js", "shopCommands.js", path.join("tools", "mapTools.js")]) {
  test(`${rel} loads as the first import of a fresh node process`, () => {
    const url = pathToFileURL(dist(rel)).href;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)});`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
}

const importsOf = (rel) =>
  [...fs.readFileSync(dist(rel), "utf8").matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);

test("dialogueTree no longer imports eventTemplates or mapTools; shopCommands is a leaf over commandList", () => {
  const deps = importsOf("dialogueTree.js");
  assert.ok(deps.includes("./shopCommands.js"), deps.join(", "));
  assert.ok(!deps.some((d) => /eventTemplates|mapTools/.test(d)), deps.join(", "));
  assert.deepEqual(importsOf("shopCommands.js"), ["./commandList.js"]);
});

test("eventTemplates still re-exports shopCommands (same function)", async () => {
  const a = await import("../dist/eventTemplates.js");
  const b = await import("../dist/shopCommands.js");
  assert.equal(a.shopCommands, b.shopCommands);
});

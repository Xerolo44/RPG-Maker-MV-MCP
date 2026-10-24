import assert from "node:assert/strict";
import test from "node:test";
import { safe, textResult } from "../dist/util.js";

test("textResult returns pretty JSON for objects", () => {
  assert.equal(textResult({ a: 1 }).content[0].text, '{\n  "a": 1\n}');
});

test("safe turns a thrown Error into an isError result", async () => {
  const res = await safe(async () => {
    throw new Error("boom");
  })();
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.startsWith("Error: boom"));
});

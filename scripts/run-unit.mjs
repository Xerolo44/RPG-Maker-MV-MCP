// Runs every test/*.test.mjs with the built-in node:test runner.
// Files are listed explicitly because Node 18 cannot expand globs or directory arguments to `--test`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test");
const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(testDir, name));

if (files.length === 0) {
  console.error("No test/*.test.mjs files found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);

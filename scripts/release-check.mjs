// Pre-release validation used by .github/workflows/release.yml.
// Verifies that package.json, server.json and CHANGELOG.md agree on one version, writes that
// version's changelog section to the given file (release notes) and prints the version.
// Usage: node scripts/release-check.mjs <notes-output-path>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));

const notesPath = process.argv[2];
if (!notesPath) {
  console.error("Usage: node scripts/release-check.mjs <notes-output-path>");
  process.exit(2);
}

const pkg = readJson("package.json");
const server = readJson("server.json");
const version = pkg.version;

const errors = [];
const expect = (label, actual) => {
  if (actual !== version) errors.push(`${label} is ${JSON.stringify(actual)}, expected ${version} (package.json)`);
};

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  errors.push(`package.json version ${JSON.stringify(version)} is not a plain X.Y.Z release version`);
}
expect("server.json version", server.version);
const npmPackage = (server.packages ?? []).find((p) => p.registryType === "npm");
if (!npmPackage) {
  errors.push("server.json has no npm package entry");
} else {
  expect("server.json packages[npm].version", npmPackage.version);
  if (npmPackage.identifier !== pkg.name) {
    errors.push(`server.json npm identifier ${JSON.stringify(npmPackage.identifier)} does not match package name ${pkg.name}`);
  }
}
if (server.name !== pkg.mcpName) {
  errors.push(`server.json name ${JSON.stringify(server.name)} does not match package.json mcpName ${JSON.stringify(pkg.mcpName)}`);
}

const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const lines = changelog.split(/\r?\n/);
const heading = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`);
const start = lines.findIndex((line) => heading.test(line));
let notes = "";
if (start === -1) {
  errors.push(`CHANGELOG.md has no "## [${version}]" section`);
} else {
  let end = lines.findIndex((line, i) => i > start && /^## \[/.test(line));
  if (end === -1) end = lines.length;
  notes = lines.slice(start + 1, end).join("\n").trim();
  if (!notes) errors.push(`CHANGELOG.md section for ${version} is empty`);
}

if (errors.length > 0) {
  console.error(`Release check failed for ${version}:`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

fs.writeFileSync(notesPath, `${notes}\n`);
console.log(version);

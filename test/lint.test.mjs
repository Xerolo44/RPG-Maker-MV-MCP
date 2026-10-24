import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Project, ProjectError } from "../dist/project.js";
import { lintCommandList, lintProject } from "../dist/lint.js";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const c = (code, indent = 0, ...parameters) => ({ code, indent, parameters });
const END = c(0, 0);

const ctx = (over = {}) => ({
  mapIds: new Set([1, 2]),
  mapSizes: new Map([
    [1, { width: 10, height: 8 }],
    [2, { width: 4, height: 4 }],
  ]),
  commonEventIds: new Set([1, 2]),
  switchNames: ["", "Chest", ""],
  variableNames: ["", "Gold", ""],
  maxLineChars: 50,
  ...over,
});
const loc = { kind: "map", mapId: 1, eventId: 3, page: 0 };
const lint = (list, over) => lintCommandList(list, loc, ctx(over));
const only = (list, rule, over) => lint(list, over).filter((f) => f.rule === rule);

test("no findings for a clean event", () => {
  const list = [
    c(101, 0, "", 0, 0, 2),
    c(401, 0, "Hello there"),
    c(121, 0, 1, 1, 0),
    c(122, 0, 1, 1, 0, 0, 5),
    c(117, 0, 1),
    c(201, 0, 0, 2, 3, 3, 2, 0),
    END,
  ];
  assert.deepEqual(lint(list), []);
});

test("unterminated-list: missing terminator is an error at the last command", () => {
  const f = only([c(401, 0, "hi")], "unterminated-list");
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "error");
  assert.equal(f[0].location.index, 0);
  assert.deepEqual(
    { kind: f[0].location.kind, mapId: f[0].location.mapId, eventId: f[0].location.eventId, page: f[0].location.page },
    loc,
  );
});

test("block-structure: unclosed conditional branch is an error at the opener", () => {
  const f = only([c(111, 0, 0, 1, 0), c(401, 1, "x"), END], "block-structure");
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "error");
  assert.equal(f[0].location.index, 0);
  assert.equal(only([c(111, 0, 0, 1, 0), c(401, 1, "x"), END], "unterminated-list").length, 0);
});

test("unreachable-command: command after 115 at the same indent is a warning", () => {
  const f = only([c(115, 0), c(121, 0, 1, 1, 0), END], "unreachable-command");
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "warning");
  assert.equal(f[0].location.index, 1);
});

test("unreachable-command: 115 closing its block or ending the list is fine", () => {
  const list = [c(111, 0, 0, 1, 0), c(115, 1), c(412, 0), c(115, 0), END];
  assert.equal(only(list, "unreachable-command").length, 0);
  assert.equal(only([c(111, 0, 0, 1, 0), c(115, 1), c(411, 0), c(412, 0), END], "unreachable-command").length, 0);
});

test("long-message-line: a 401 line over maxLineChars is a warning", () => {
  const f = only([c(401, 0, "x".repeat(51)), END], "long-message-line");
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "warning");
  assert.equal(f[0].location.index, 0);
  assert.equal(only([c(401, 0, "x".repeat(50)), END], "long-message-line").length, 0);
  assert.equal(only([c(401, 0, "x".repeat(21)), END], "long-message-line", { maxLineChars: 20 }).length, 1);
});

test("strips control codes before measuring line length", () => {
  const text = "\\C[2]" + "x".repeat(50) + "\\C[0]\\V[1]\\N[2]\\P[1]\\I[3]\\{\\}\\.\\|\\!\\>\\<\\^";
  assert.ok(text.length > 50);
  assert.equal(only([c(401, 0, text), END], "long-message-line").length, 0);
  assert.equal(only([c(401, 0, text + "y"), END], "long-message-line").length, 1);
});

test("unnamed-switch: 121 on a switch with an empty name is info", () => {
  const f = only([c(121, 0, 2, 2, 0), END], "unnamed-switch");
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "info");
  assert.equal(f[0].location.index, 0);
  assert.equal(only([c(121, 0, 1, 1, 0), END], "unnamed-switch").length, 0);
});

test("unnamed-switch: a range yields one finding per command and covers ids past the name list", () => {
  assert.equal(only([c(121, 0, 1, 5, 0), END], "unnamed-switch").length, 1);
  assert.equal(only([c(121, 0, 9, 9, 0), END], "unnamed-switch").length, 1);
});

test("unnamed-variable: 122 on a variable with an empty name is info", () => {
  const f = only([c(122, 0, 2, 2, 0, 0, 1), END], "unnamed-variable");
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "info");
  assert.equal(f[0].location.index, 0);
  assert.equal(only([c(122, 0, 1, 1, 0, 0, 1), END], "unnamed-variable").length, 0);
});

test("transfer-missing-map: direct transfer to an unknown map is an error", () => {
  const f = only([c(201, 0, 0, 99, 1, 1, 2, 0), END], "transfer-missing-map");
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "error");
  assert.equal(f[0].location.index, 0);
});

test("transfer-out-of-bounds: x/y outside the target map is an error", () => {
  for (const [x, y] of [[4, 0], [0, 4], [-1, 0], [0, -1]]) {
    const f = only([c(201, 0, 0, 2, x, y, 2, 0), END], "transfer-out-of-bounds");
    assert.equal(f.length, 1, `${x},${y}`);
    assert.equal(f[0].severity, "error");
    assert.equal(f[0].location.index, 0);
  }
  assert.equal(only([c(201, 0, 0, 2, 3, 3, 2, 0), END], "transfer-out-of-bounds").length, 0);
  // an unknown map is reported as missing, not as out of bounds
  assert.equal(only([c(201, 0, 0, 99, 500, 500, 2, 0), END], "transfer-out-of-bounds").length, 0);
});

test("ignores variable-designated transfers (parameters[0] === 1)", () => {
  const list = [c(201, 0, 1, 99, 500, 500, 2, 0), END];
  assert.deepEqual(lint(list), []);
});

test("missing-common-event: 117 with an unknown id is an error", () => {
  const f = only([c(117, 0, 7), END], "missing-common-event");
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "error");
  assert.equal(f[0].location.index, 0);
  assert.equal(only([c(117, 0, 2), END], "missing-common-event").length, 0);
});

test("performance: 5000 events x 20 commands lint in under 1500 ms", () => {
  const list = [];
  for (let i = 0; i < 19; i++) list.push(i % 3 === 0 ? c(401, 0, "A line of dialogue text") : c(121, 0, 1, 1, 0));
  list.push(END);
  assert.equal(list.length, 20);
  const context = ctx();
  const start = performance.now();
  let total = 0;
  for (let e = 1; e <= 5000; e++) total += lintCommandList(list, { kind: "map", mapId: 1, eventId: e, page: 0 }, context).length;
  const elapsed = performance.now() - start;
  assert.equal(total, 0);
  assert.ok(elapsed < 1500, `took ${elapsed.toFixed(0)} ms`);
});

// ---- project-level lint ----

async function withProject(data, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-lint-"));
  try {
    await fs.mkdir(path.join(dir, "data"));
    for (const [name, value] of Object.entries(data)) {
      await fs.writeFile(path.join(dir, "data", name), typeof value === "string" ? value : JSON.stringify(value), "utf8");
    }
    const project = new Project();
    await project.setRoot(dir);
    await fn({ dir, project });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const baseData = (over = {}) => ({
  "System.json": { switches: ["", "Chest"], variables: ["", "Gold"] },
  "MapInfos.json": [null, { id: 1, name: "Town" }, { id: 2, name: "Cave" }],
  "CommonEvents.json": [null, { id: 1, name: "ce", list: [c(117, 0, 5), END] }],
  "Troops.json": [null, { id: 1, name: "t", pages: [{ list: [c(401, 0, "y".repeat(80)), END] }] }],
  "Map001.json": {
    width: 10,
    height: 10,
    events: [null, { id: 1, pages: [{ list: [c(201, 0, 0, 2, 1, 1, 2, 0), c(401, 0, "z".repeat(60)), END] }] }],
  },
  "Map002.json": { width: 4, height: 4, events: [null] },
  ...over,
});

test("lintProject: lists findings sorted by severity with counts", async () => {
  await withProject(baseData(), async ({ project }) => {
    const r = await lintProject(project, { scope: "all", maxLineChars: 50, minSeverity: "warning" });
    assert.deepEqual(r.skippedMaps, []);
    assert.equal(r.truncated, 0);
    assert.deepEqual(r.counts, { error: 1, warning: 2, info: 0 });
    assert.deepEqual(r.findings.map((f) => f.rule), ["missing-common-event", "long-message-line", "long-message-line"]);
    assert.deepEqual(r.findings.map((f) => f.location.kind), ["commonEvent", "map", "troop"]);
  });
});

test("lintProject: scope limits what is linted and mapId limits maps", async () => {
  await withProject(baseData(), async ({ project }) => {
    const ce = await lintProject(project, { scope: "commonEvents", maxLineChars: 50, minSeverity: "info" });
    assert.deepEqual(ce.findings.map((f) => f.location.kind), ["commonEvent"]);
    const tr = await lintProject(project, { scope: "troops", maxLineChars: 50, minSeverity: "info" });
    assert.deepEqual(tr.findings.map((f) => f.location.kind), ["troop"]);
    const m2 = await lintProject(project, { scope: "maps", mapId: 2, maxLineChars: 50, minSeverity: "info" });
    assert.deepEqual(m2.findings, []);
    const m1 = await lintProject(project, { scope: "maps", mapId: 1, maxLineChars: 50, minSeverity: "info" });
    assert.equal(m1.findings.length, 1);
    assert.equal(m1.findings[0].location.mapId, 1);
  });
});

test("lintProject: info rules only appear when minSeverity is info", async () => {
  const data = baseData({
    "CommonEvents.json": [null, { id: 1, name: "ce", list: [c(121, 0, 5, 5, 0), c(122, 0, 6, 6, 0, 0, 1), END] }],
  });
  await withProject(data, async ({ project }) => {
    const warn = await lintProject(project, { scope: "commonEvents", maxLineChars: 50, minSeverity: "warning" });
    assert.deepEqual(warn.findings, []);
    const info = await lintProject(project, { scope: "commonEvents", maxLineChars: 50, minSeverity: "info" });
    assert.deepEqual(info.findings.map((f) => f.rule), ["unnamed-switch", "unnamed-variable"]);
    assert.deepEqual(info.counts, { error: 0, warning: 0, info: 2 });
  });
});

test("lintProject: null holes, pages [], and pages without a list do not crash or produce findings", async () => {
  const data = baseData({
    "CommonEvents.json": [null, { id: 1, name: "ce" }, null],
    "Troops.json": [null, null, { id: 2, pages: [] }, { id: 3, pages: [null, {}] }],
    "Map001.json": {
      width: 10,
      height: 10,
      events: [null, null, { id: 2, pages: [] }, { id: 3, pages: [{}, null, { list: null }] }, { id: 4 }],
    },
  });
  await withProject(data, async ({ project }) => {
    const r = await lintProject(project, { scope: "all", maxLineChars: 50, minSeverity: "info" });
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.skippedMaps, []);
  });
});

test("lintProject: an unreadable map is listed in skippedMaps, not as a finding", async () => {
  const data = baseData({ "Map002.json": "{ not json" });
  await withProject(data, async ({ project }) => {
    const r = await lintProject(project, { scope: "all", maxLineChars: 50, minSeverity: "info" });
    assert.deepEqual(r.skippedMaps, [2]);
    assert.ok(r.findings.every((f) => f.location.mapId !== 2));
  });
  const missing = baseData();
  delete missing["Map002.json"];
  await withProject(missing, async ({ project }) => {
    const r = await lintProject(project, { scope: "all", maxLineChars: 50, minSeverity: "info" });
    assert.deepEqual(r.skippedMaps, [2]);
  });
});

test("lintProject: a transfer into a skipped map is not reported as out of bounds", async () => {
  const data = baseData({
    "Map002.json": "{ not json",
    "Map001.json": { width: 10, height: 10, events: [null, { id: 1, pages: [{ list: [c(201, 0, 0, 2, 99, 99, 2, 0), END] }] }] },
  });
  await withProject(data, async ({ project }) => {
    const r = await lintProject(project, { scope: "maps", maxLineChars: 50, minSeverity: "info" });
    assert.deepEqual(r.findings, []);
  });
});

test("lintProject: caps at 300 findings and reports how many were cut", async () => {
  const events = [null];
  for (let i = 1; i <= 350; i++) events.push({ id: i, pages: [{ list: [c(117, 0, 99), END] }] });
  await withProject(baseData({ "Map001.json": { width: 10, height: 10, events } }), async ({ project }) => {
    const r = await lintProject(project, { scope: "maps", maxLineChars: 50, minSeverity: "warning" });
    assert.equal(r.findings.length, 300);
    assert.equal(r.truncated, 50);
    assert.equal(r.counts.error, 350);
  });
});

test("lintProject: a mapId not listed in MapInfos is an error, not an empty result", async () => {
  await withProject(baseData(), async ({ project }) => {
    await assert.rejects(
      () => lintProject(project, { scope: "maps", mapId: 9, maxLineChars: 50, minSeverity: "info" }),
      (err) => err instanceof ProjectError && /map 9 is not listed in MapInfos\.json/.test(err.message),
    );
  });
});

test("lintProject: rejects when no project is open", async () => {
  await assert.rejects(
    () => lintProject(new Project(), { scope: "all", maxLineChars: 50, minSeverity: "warning" }),
    /No project selected/,
  );
});

async function connect(args) {
  const client = new Client({ name: "lint-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry, ...args],
      env: { ...process.env, RPGMV_TOOLS: "" },
      stderr: "ignore",
    }),
  );
  return client;
}

test("lint_events before set_project returns the No project selected error", async () => {
  const client = await connect([]);
  try {
    const res = await client.callTool({ name: "lint_events", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /No project selected/);
  } finally {
    await client.close();
  }
});

test("lint_events tool returns findings, counts, skippedMaps and truncated", async () => {
  await withProject(baseData(), async ({ dir }) => {
    const client = await connect(["--project", dir]);
    try {
      const res = await client.callTool({ name: "lint_events", arguments: {} });
      assert.notEqual(res.isError, true);
      const out = JSON.parse(res.content[0].text);
      assert.deepEqual(Object.keys(out).sort(), ["counts", "findings", "skippedMaps", "truncated"]);
      assert.equal(out.counts.error, 1);
      assert.equal(out.findings[0].rule, "missing-common-event");
    } finally {
      await client.close();
    }
  });
});

// ---- malformed commands ----

test("malformed commands: null, missing parameters and non-array parameters are reported, other commands still lint", () => {
  const list = [
    c(117, 0, 7), // 0: missing common event
    null, // 1
    { code: 401, indent: 0 }, // 2: parameters missing
    { code: 121, indent: 0, parameters: "1" }, // 3: parameters not an array
    c(201, 0, 0, 99, 1, 1, 2, 0), // 4: missing map
    END,
  ];
  let findings;
  assert.doesNotThrow(() => {
    findings = lint(list);
  });
  const malformed = findings.filter((f) => f.rule === "block-structure");
  assert.deepEqual(malformed.map((f) => f.location.index), [1, 2, 3]);
  for (const f of malformed) assert.equal(f.severity, "error");
  assert.match(malformed[0].message, /not an object/);
  assert.match(malformed[1].message, /parameters/);
  assert.match(malformed[2].message, /parameters/);
  assert.deepEqual(
    findings.filter((f) => f.rule !== "block-structure").map((f) => [f.rule, f.location.index]),
    [["missing-common-event", 0], ["transfer-missing-map", 4]],
  );
});

test("malformed commands: a malformed last entry does not throw and the list counts as unterminated", () => {
  const findings = lint([c(401, 0, "hi"), null]);
  assert.ok(findings.some((f) => f.rule === "unterminated-list" && f.location.index === 1));
  assert.ok(findings.some((f) => f.rule === "block-structure" && f.location.index === 1));
});

test("lintProject: a malformed command does not abort the lint of other events", async () => {
  const data = baseData({
    "Map001.json": {
      width: 10,
      height: 10,
      events: [
        null,
        { id: 1, pages: [{ list: [null, c(117, 0, 99), END] }] },
        { id: 2, pages: [{ list: [{ code: 117, indent: 0 }, END] }] },
        { id: 3, pages: [{ list: [c(117, 0, 98), END] }] },
      ],
    },
  });
  await withProject(data, async ({ project }) => {
    const r = await lintProject(project, { scope: "maps", maxLineChars: 50, minSeverity: "warning" });
    const summary = r.findings.map((f) => [f.rule, f.location.eventId, f.location.index]);
    assert.deepEqual(summary, [
      ["block-structure", 1, 0],
      ["missing-common-event", 1, 1],
      ["block-structure", 2, 0],
      ["missing-common-event", 3, 0],
    ]);
  });
});

// The MV editor ends every non-empty block branch with a blank row {code:0, indent: body indent}, and an empty
// branch consists of that row alone. build_dialogue_tree now writes the same rows. These tests cover the compiler
// output and check that the rest of the pipeline treats such rows as no-ops. Lists below are synthetic.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cmd, terminated, validateCommandList } from "../dist/commandList.js";
import { compileDialogue } from "../dist/dialogueTree.js";
import { simulateEvent } from "../dist/eventSim.js";
import { buildProjectIndex } from "../dist/eventIndex.js";
import { findUsages } from "../dist/usages.js";
import { analyzeProgression } from "../dist/progression.js";
import { checkReferences } from "../dist/references.js";
import { lintCommandList } from "../dist/lint.js";
import { c, END, createFixtureProject, event, page } from "./helpers/fixtureProject.mjs";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/** A list without the blank end-of-branch rows (what 0.5.0 wrote). The final terminator has indent 0 and stays. */
const stripBlanks = (list) => list.filter((x) => !(x.code === 0 && x.indent > 0));
const shape = (list) => list.map((x) => [x.code, x.indent]);
const blank = (indent) => c(0, indent);

// ---------------------------------------------------------------- compiler output

test("choices: every branch, the cancel branch and empty branches end with a blank row", () => {
  const list = compileDialogue([{ choices: [{ label: "A", then: [{ say: "a" }] }, { label: "B" }], cancel: "branch" }]);
  assert.deepEqual(shape(list), [[102, 0], [402, 0], [101, 1], [401, 1], [0, 1], [402, 0], [0, 1], [403, 0], [0, 1], [404, 0]]);
  assert.deepEqual(validateCommandList(terminated(list)), []);
});

test("if: then and else end with a blank row; an empty then is that row alone; no else means no 411", () => {
  assert.deepEqual(shape(compileDialogue([{ if: { switch: 1 }, then: [{ gold: 5 }], else: [{ gold: 6 }] }])), [[111, 0], [125, 1], [0, 1], [411, 0], [125, 1], [0, 1], [412, 0]]);
  assert.deepEqual(shape(compileDialogue([{ if: { switch: 1 }, then: [] }])), [[111, 0], [0, 1], [412, 0]]);
  assert.deepEqual(shape(compileDialogue([{ if: { switch: 1 }, then: [{ gold: 5 }] }])), [[111, 0], [125, 1], [0, 1], [412, 0]]);
});

test("battle: each written branch ends with a blank row at the body indent; a branchless battle has none", () => {
  const list = compileDialogue([{ battle: { troopId: 1, canEscape: true, canLose: true } }]);
  assert.deepEqual(list, [cmd(301, 0, 0, 1, true, true), cmd(601, 0), cmd(0, 1), cmd(602, 0), cmd(0, 1), cmd(603, 0), cmd(0, 1), cmd(604, 0)]);
  assert.deepEqual(compileDialogue([{ battle: { troopId: 1 } }]), [cmd(301, 0, 0, 1, false, false)]);
});

test("nested blocks: the blank row uses the indent of its own branch body", () => {
  const list = compileDialogue([{ choices: [{ label: "A", then: [{ if: { switch: 1 }, then: [{ battle: { troopId: 1, canLose: true, onLose: [{ gold: 1 }] } }] }] }] }]);
  assert.deepEqual(shape(list), [
    [102, 0], [402, 0], [111, 1], [301, 2], [601, 2], [0, 3], [603, 2], [125, 3], [0, 3], [604, 2], [0, 2], [412, 1], [0, 1], [404, 0],
  ]);
  assert.deepEqual(validateCommandList(terminated(list)), []);
});

test("compileDialogue at a base indent puts the blank rows one level below it", () => {
  const list = compileDialogue([{ if: { switch: 1 }, then: [] }], 2);
  assert.deepEqual(shape(list), [[111, 2], [0, 3], [412, 2]]);
});

// ---------------------------------------------------------------- shapes the editor writes

const lone = [c(301, 0, 0, 5, false, false), c(125, 0, 0, 0, 5), END];
const full = [
  c(301, 0, 0, 5, true, true), c(601, 0), c(123, 1, "A", 0), blank(1), c(602, 0), blank(1), c(603, 0), blank(1), c(604, 0), END,
];
const emptyBranches = [c(301, 0, 0, 5, true, true), c(601, 0), blank(1), c(602, 0), blank(1), c(603, 0), blank(1), c(604, 0), END];
const bareEmpty = [c(301, 0, 0, 5, true, true), c(601, 0), c(602, 0), c(603, 0), c(604, 0), END]; // no blank rows: still accepted
const choiceWithBlank = [c(102, 0, ["A"], 0, 0, 2, 0), c(402, 0, 0, "A"), c(123, 1, "A", 0), blank(1), c(404, 0), END];
const ifWithBlank = [c(111, 0, 0, 1, 0), c(125, 1, 0, 0, 1), blank(1), c(411, 0), blank(1), c(412, 0), END];

test("validateCommandList accepts editor-shaped lists with blank rows, and without them", () => {
  for (const list of [lone, full, emptyBranches, bareEmpty, choiceWithBlank, ifWithBlank]) assert.deepEqual(validateCommandList(list), []);
});

test("a 301 whose 604 closer is missing is reported by validateCommandList and lint", () => {
  const broken = [c(301, 0, 0, 5, true, false), c(601, 0), c(123, 1, "A", 0), blank(1), c(602, 0), blank(1), END];
  const problems = validateCommandList(broken);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Battle Processing has no matching End of Battle \(604\)/);
  const ctx = { mapIds: new Set([1]), mapSizes: new Map(), commonEventIds: new Set(), switchNames: [], variableNames: [], maxLineChars: 50 };
  const findings = lintCommandList(broken, { kind: "map", mapId: 1, eventId: 1, page: 0 }, ctx);
  assert.ok(findings.some((f) => f.rule === "block-structure" && f.severity === "error"));
});

// ---------------------------------------------------------------- lint

const lintCtx = { mapIds: new Set([1]), mapSizes: new Map([[1, { width: 10, height: 10 }]]), commonEventIds: new Set([1]), switchNames: ["", "S"], variableNames: [""], maxLineChars: 50 };
const lint = (list) => lintCommandList(list, { kind: "map", mapId: 1, eventId: 1, page: 0 }, lintCtx);

test("lint_events: blank rows produce no findings, also after Exit Event Processing inside a branch", () => {
  for (const list of [lone, full, emptyBranches, choiceWithBlank, ifWithBlank]) assert.deepEqual(lint(list), []);
  const exitInBranch = [c(111, 0, 0, 1, 0), c(115, 1), blank(1), c(412, 0), END];
  assert.deepEqual(lint(exitInBranch), []);
  // the rule still fires for a real command after the 115
  const unreachable = [c(111, 0, 0, 1, 0), c(115, 1), c(125, 1, 0, 0, 1), blank(1), c(412, 0), END];
  assert.deepEqual(lint(unreachable).map((f) => f.rule), ["unreachable-command"]);
});

// ---------------------------------------------------------------- simulate_event

const freshState = (over = {}) => ({ switches: {}, variables: {}, selfSwitches: {}, gold: 0, items: {}, ...over });
const sim = (list, over = {}, state = freshState()) =>
  simulateEvent(list, state, { unknownCondition: "stop", commonEvents: (id) => (id === 1 ? [c(125, 0, 0, 0, 1), END] : null), mapId: 1, eventId: 1, ...over });
const withoutIndexes = (t) => ({ ...t, unsupported: t.unsupported.map(({ code, message }) => ({ code, message })) });

test("simulate_event skips blank rows: nothing unsupported, nothing cosmetic, same result", () => {
  const withRows = compileDialogue([
    { choices: [{ label: "A", then: [{ say: "a" }, { gold: 5 }] }, { label: "B" }] },
    { if: { switch: 1 }, then: [], else: [{ say: "no" }] },
    { battle: { troopId: 1, canEscape: true, canLose: true, onWin: [{ say: "won" }] } },
    { say: "after" },
  ]);
  assert.ok(withRows.length > stripBlanks(withRows).length);
  for (const choices of [[0], [1]]) {
    for (const battleResult of ["win", "escape", "lose"]) {
      const a = sim([...withRows, END], { choices, battleResult });
      const b = sim([...stripBlanks(withRows), END], { choices, battleResult });
      assert.deepEqual(a.unsupported, []);
      assert.equal(a.cosmetic, 0);
      assert.deepEqual(withoutIndexes(a), withoutIndexes(b));
    }
  }
});

test("simulate_event: blank rows do not count as steps (a label loop stops at the same state)", () => {
  const loop = (rows) => [
    c(118, 0, "top"),
    c(125, 0, 0, 0, 1),
    c(111, 0, 0, 1, 0),
    c(125, 1, 0, 0, 0),
    ...(rows ? [c(0, 1)] : []),
    c(412, 0),
    c(119, 0, "top"),
    END,
  ];
  const state = () => freshState({ switches: { 1: true } });
  const a = sim(loop(true), {}, state());
  const b = sim(loop(false), {}, state());
  assert.equal(a.ended, "stepLimit");
  assert.equal(b.ended, "stepLimit");
  assert.equal(a.finalState.gold, b.finalState.gold);
});

// ---------------------------------------------------------------- differential check over every node kind

const everything = () => [
  { say: "hi" },
  { setSwitch: { id: 3, value: true } },
  { setVariable: { id: 2, op: "add", value: 4 } },
  { setSelfSwitch: { ch: "A", value: true } },
  { wait: 5 },
  { fade: "out" },
  { tint: { r: 1, g: 2, b: 3, gray: 4 } },
  { flash: { r: 255, g: 255, b: 255, intensity: 100 } },
  { shake: {} },
  { weather: { type: "rain" } },
  { playAudio: { kind: "bgm", name: "Theme1" } },
  { fadeAudio: { kind: "bgm", seconds: 2 } },
  { showPicture: { id: 1, name: "Pic", x: 0, y: 0 } },
  { erasePicture: 1 },
  { animation: { target: "player", animationId: 3 } },
  { balloon: { target: "this", balloonId: 2 } },
  { moveRoute: { target: "this", steps: ["down", { switchOn: 7 }] } },
  { callCommon: 1 },
  { shop: { goods: [{ type: "item", id: 1 }] } },
  { gold: 10 },
  { item: { kind: "item", id: 2, count: 3 } },
  { party: { actorId: 2, action: "add" } },
  { learnSkill: { actorId: 1, skillId: 2 } },
  { recoverAll: true },
  { nameInput: { actorId: 1, maxChars: 6 } },
  { plugin: "Foo bar" },
  { comment: "note" },
  { label: "L1" },
  {
    choices: [
      { label: "A", then: [{ say: "a" }, { if: { switch: 3 }, then: [{ gold: 1 }], else: [{ gold: 2 }] }] },
      { label: "B", then: [{ jump: "L2" }, { say: "skipped" }] },
      { label: "C" },
      { label: "D", then: [{ exit: true }] },
    ],
    cancel: "branch",
  },
  {
    battle: {
      troopId: 1,
      canEscape: true,
      canLose: true,
      onWin: [{ say: "won" }, { choices: [{ label: "x", then: [{ gold: 7 }] }, { label: "y" }] }],
      onEscape: [{ exit: true }],
      onLose: [{ scene: "gameOver" }],
    },
  },
  { battle: { troopId: 2 } },
  { label: "L2" },
  { if: { variable: 2, op: "gte", value: 4 }, then: [{ transfer: { mapId: 2, x: 1, y: 1 } }] },
  { raw: [c(111, 0, 0, 1, 0), c(125, 1, 0, 0, 1), c(412, 0)] },
  { setSwitch: { id: 9, value: false } },
];

test("differential: simulate_event is identical with and without the blank rows for a tree using every node kind", () => {
  const withRows = compileDialogue(everything());
  const without = stripBlanks(withRows);
  assert.deepEqual(validateCommandList(terminated(withRows)), []);
  assert.deepEqual(validateCommandList(terminated(without)), []);
  assert.ok(withRows.length - without.length >= 12, "the tree has many blank rows");

  let transferred = 0;
  let unsupported = 0;
  let ended = new Set();
  for (const choices of [[0, 0], [1, 0], [2, 0], [3, 0], [5, 0], [0, 1], [0, 2]]) {
    for (const battleResult of ["win", "escape", "lose"]) {
      for (const sw3 of [false, true]) {
        for (const unknownCondition of ["stop", "then", "else"]) {
          const opts = { choices, battleResult, unknownCondition };
          const state = () => freshState({ switches: { 3: sw3 }, variables: { 2: sw3 ? 0 : 4 } });
          const a = sim([...withRows, END], opts, state());
          const b = sim([...without, END], opts, state());
          assert.deepEqual(withoutIndexes(a), withoutIndexes(b), JSON.stringify(opts));
          transferred += a.transfers.length;
          unsupported += a.unsupported.length;
          ended.add(a.ended);
        }
      }
    }
  }
  // the runs are not trivial: some transfer, some end early, and the unsupported list (identical by code and message) is not empty
  assert.ok(transferred > 0);
  assert.ok(unsupported > 0);
  assert.ok(ended.size >= 2, [...ended].join());
});

// ---------------------------------------------------------------- index, find_usages, analyze_progression, check_references

test("the project index, find_usages, analyze_progression and check_references ignore blank rows", async () => {
  const body = [
    { choices: [{ label: "A", then: [{ gold: 1 }, { item: { kind: "item", id: 9, count: 1 } }] }, { label: "B" }], cancel: "branch" },
    { if: { switch: 5 }, then: [{ battle: { troopId: 4, canLose: true, onLose: [{ setSwitch: { id: 6, value: true } }] } }] },
    { callCommon: 3 },
    { transfer: { mapId: 2, x: 1, y: 1 } },
  ];
  const specFor = (list) => ({
    maps: { 1: { events: [null, event(1, [page([...list, END])])] }, 2: {} },
    commonEvents: [null, null, null, { id: 3, name: "CE", trigger: 0, switchId: 1, list: [END] }],
    troops: [null, null, null, null, { id: 4, name: "T", members: [], pages: [] }],
    items: [null],
    system: { partyMembers: [] },
  });
  const withRows = compileDialogue(body);
  const without = stripBlanks(withRows);
  assert.ok(withRows.length > without.length);

  const fa = await createFixtureProject(specFor(withRows));
  const fb = await createFixtureProject(specFor(without));
  try {
    const ia = await buildProjectIndex(fa.project);
    const ib = await buildProjectIndex(fb.project);
    const key = (r) => `${r.kind} ${r.id} ${r.role}`;
    assert.deepEqual(ia.refs.map(key), ib.refs.map(key));
    assert.deepEqual(ia.hidden, ib.hidden);
    // locations point at the real command position in the list that has the rows
    for (const r of ia.refs.filter((x) => x.where.source === "map" && x.where.index !== undefined)) {
      assert.ok(withRows[r.where.index] !== undefined && withRows[r.where.index].code !== 0, `ref ${key(r)} at ${r.where.index}`);
    }
    const item9 = ia.refs.find((r) => r.kind === "item" && r.id === 9);
    assert.equal(withRows[item9.where.index].code, 126);

    for (const target of [{ kind: "item", id: 9 }, { kind: "switch", id: 6 }, { kind: "commonEvent", id: 3 }, { kind: "map", id: 2 }, { kind: "troop", id: 4 }]) {
      const a = findUsages(ia, target, { limit: 10, name: "n" });
      const b = findUsages(ib, target, { limit: 10, name: "n" });
      assert.deepEqual(a.counts, b.counts, JSON.stringify(target));
      assert.deepEqual(a.warnings, b.warnings, JSON.stringify(target));
    }
    assert.deepEqual(analyzeProgression(ia, { limit: 100 }), analyzeProgression(ib, { limit: 100 }));
    const ra = await checkReferences(fa.project);
    const rb = await checkReferences(fb.project);
    assert.deepEqual(ra.missing.map((m) => `${m.kind} ${m.id} ${m.count}`), rb.missing.map((m) => `${m.kind} ${m.id} ${m.count}`));
    assert.deepEqual(ra.missing.map((m) => `${m.kind} ${m.id}`), ["item 9"]);
  } finally {
    await fa.cleanup();
    await fb.cleanup();
  }
});

// ---------------------------------------------------------------- insertion rules (tools)

async function withServer(spec, fn) {
  const fx = await createFixtureProject(spec);
  const client = new Client({ name: "blank-rows-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, RPGMV_TOOLS: "" }, stderr: "ignore" }));
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    return { isError: !!res.isError, text, json: !res.isError && /^[{[]/.test(text) ? JSON.parse(text) : null };
  };
  try {
    assert.equal((await call("set_project", { path: fx.root })).isError, false);
    return await fn({ call, fx });
  } finally {
    await client.close();
    await fx.cleanup();
  }
}

const listOf = async (fx) => (await fx.project.readJson(fx.project.mapFile(1))).events[1].pages[0].list;

test("build_dialogue_tree index: top-level positions around blocks with blank rows work, positions inside them are refused", async () => {
  const base = [c(111, 0, 0, 5, 0), c(101, 1, "", 0, 0, 2), c(401, 1, "inside"), blank(1), c(412, 0), c(125, 0, 0, 0, 1), END];
  const spec = { maps: { 1: { events: [null, event(1, [page(structuredClone(base))])] } }, system: { partyMembers: [] } };
  // 0 before the block, 5 after it (the 125), 6 the terminator: allowed. 1..4 are inside (the blank row at 3 and the closer at 4 too).
  for (const index of [1, 2, 3, 4]) {
    await withServer(spec, async ({ call, fx }) => {
      const r = await call("build_dialogue_tree", { tree: [{ say: "new" }], mapId: 1, eventId: 1, index });
      assert.equal(r.isError, true, `index ${index}`);
      assert.match(r.text, /inside a block|nested/);
      assert.deepEqual(await listOf(fx), base);
    });
  }
  for (const [index, at] of [[0, 0], [5, 5], [6, 6]]) {
    await withServer(spec, async ({ call, fx }) => {
      const r = await call("build_dialogue_tree", { tree: [{ if: { switch: 2 }, then: [] }], mapId: 1, eventId: 1, index });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.json.inserted.at, at);
      const list = await listOf(fx);
      assert.deepEqual(validateCommandList(list), []);
      assert.deepEqual(list.slice(at, at + 3).map((x) => [x.code, x.indent]), [[111, 0], [0, 1], [412, 0]]);
    });
  }
});

test("add_event_command inserts between blocks that end with blank rows and keeps them", async () => {
  const base = [c(111, 0, 0, 5, 0), c(125, 1, 0, 0, 1), blank(1), c(412, 0), END];
  const spec = { maps: { 1: { events: [null, event(1, [page(structuredClone(base))])] } }, system: { partyMembers: [] } };
  await withServer(spec, async ({ call, fx }) => {
    const r = await call("add_event_command", { mapId: 1, eventId: 1, index: 4, commands: [{ code: 125, indent: 0, parameters: [0, 0, 7] }] });
    assert.equal(r.isError, false, r.text);
    const list = await listOf(fx);
    assert.deepEqual(shape(list), [[111, 0], [125, 1], [0, 1], [412, 0], [125, 0], [0, 0]]);
    assert.deepEqual(validateCommandList(list), []);
    const got = await call("get_event", { mapId: 1, eventId: 1 });
    assert.equal(got.isError, false);
    assert.match(got.text, /"code": 0/);
  });
});

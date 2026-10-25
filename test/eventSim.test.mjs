import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { compileDialogue } from "../dist/dialogueTree.js";
import { simulateEvent } from "../dist/eventSim.js";
import { buildTemplate, templateParamsSchema } from "../dist/eventTemplates.js";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const c = (code, indent = 0, ...parameters) => ({ code, indent, parameters });
const END = c(0, 0);

const freshState = (over = {}) => ({ switches: {}, variables: {}, selfSwitches: {}, gold: 0, items: {}, ...over });
const sim = (list, over = {}, state = freshState()) =>
  simulateEvent(list, state, { unknownCondition: "stop", commonEvents: () => null, mapId: 1, eventId: 1, ...over });

test("treasure chest: conditional on self switch A, message, gold +100, self switch A on", () => {
  const list = [
    c(111, 0, 2, "A", 0),
    c(101, 1, "", 0, 0, 2),
    c(401, 1, "The chest is empty."),
    c(0, 1),
    c(411, 0),
    c(101, 1, "", 0, 0, 2),
    c(401, 1, "You found 100 gold!"),
    c(125, 1, 0, 0, 100),
    c(123, 1, "A", 0),
    c(0, 1),
    c(412, 0),
    END,
  ];
  const t = sim(list);
  assert.deepEqual(t.messages, ["You found 100 gold!"]);
  assert.deepEqual(t.changes, ["gold +100 → 100", "self switch A → ON"]);
  assert.equal(t.finalState.gold, 100);
  assert.equal(t.finalState.selfSwitches.A, true);
  assert.equal(t.ended, "end");
  assert.deepEqual(t.unsupported, []);

  // Second run with the chest already opened takes the other branch.
  const again = sim(list, {}, freshState({ selfSwitches: { A: true } }));
  assert.deepEqual(again.messages, ["The chest is empty."]);
  assert.equal(again.finalState.gold, 0);
});

test("does not mutate the state passed in", () => {
  const state = freshState({ switches: { 1: false } });
  sim([c(121, 0, 1, 1, 0), c(125, 0, 0, 0, 5), END], {}, state);
  assert.deepEqual(state, freshState({ switches: { 1: false } }));
});

const choiceList = [
  c(102, 0, ["Yes", "No"], 1, 0, 2, 0),
  c(402, 0, 0, "Yes"),
  c(401, 1, "said yes"),
  c(0, 1),
  c(402, 0, 1, "No"),
  c(401, 1, "said no"),
  c(0, 1),
  c(403, 0),
  c(401, 1, "cancelled"),
  c(0, 1),
  c(404, 0),
  c(401, 0, "after"),
  END,
];

test("choices select the branch given in options.choices", () => {
  assert.deepEqual(sim(choiceList).messages, ["said yes", "after"]);
  assert.deepEqual(sim(choiceList, { choices: [1] }).messages, ["said no", "after"]);
  // out of range falls to the cancel branch
  assert.deepEqual(sim(choiceList, { choices: [9] }).messages, ["cancelled", "after"]);
});

test("choices are consumed in order, missing answers default to 0", () => {
  const two = [...choiceList.slice(0, -1), ...choiceList.slice(0, -1), END];
  assert.deepEqual(sim(two, { choices: [1] }).messages, ["said no", "after", "said yes", "after"]);
});

test("nested conditional inside a choice branch uses the right indent", () => {
  const list = [
    c(102, 0, ["A", "B"], -1, 0, 2, 0),
    c(402, 0, 0, "A"),
    c(111, 1, 0, 3, 0),
    c(401, 2, "A switch on"),
    c(0, 2),
    c(411, 1),
    c(401, 2, "A switch off"),
    c(0, 2),
    c(412, 1),
    c(0, 1),
    c(402, 0, 1, "B"),
    c(401, 1, "B chosen"),
    c(0, 1),
    c(404, 0),
    c(401, 0, "done"),
    END,
  ];
  assert.deepEqual(sim(list, { choices: [0] }).messages, ["A switch off", "done"]);
  assert.deepEqual(sim(list, { choices: [0] }, freshState({ switches: { 3: true } })).messages, ["A switch on", "done"]);
  assert.deepEqual(sim(list, { choices: [1] }, freshState({ switches: { 3: true } })).messages, ["B chosen", "done"]);
});

test("variable arithmetic: add, multiply, and divide with floored integers", () => {
  const list = [
    c(122, 0, 1, 1, 0, 0, 7), // v1 = 7
    c(122, 0, 1, 1, 1, 0, 5), // v1 += 5 -> 12
    c(122, 0, 1, 1, 3, 0, 3), // v1 *= 3 -> 36
    c(122, 0, 1, 1, 2, 0, 6), // v1 -= 6 -> 30
    c(122, 0, 2, 2, 0, 1, 1), // v2 = v1 -> 30
    c(122, 0, 2, 2, 4, 0, 7), // v2 /= 7 -> 4 (4.28 floored)
    c(122, 0, 3, 3, 0, 0, -7),
    c(122, 0, 3, 3, 4, 0, 2), // -3.5 floors to -4 (the engine's setValue floors; truncation would give -3)
    c(122, 0, 4, 4, 0, 0, 10),
    c(122, 0, 4, 4, 5, 0, 4), // 10 % 4
    END,
  ];
  const t = sim(list);
  assert.deepEqual(t.finalState.variables, { 1: 30, 2: 4, 3: -4, 4: 2 });
  assert.ok(t.changes.includes("variable 1 → 36"));
});

test("variable values are floored, not truncated, for negative quotients and fractional constants", () => {
  const t = sim([c(122, 0, 1, 1, 0, 0, -7), c(122, 0, 1, 1, 4, 0, 2), c(122, 0, 2, 2, 0, 0, -2.7), END]);
  assert.deepEqual(t.finalState.variables, { 1: -4, 2: -3 });
});

test("a single-id change keeps the per-id format", () => {
  const t = sim([c(121, 0, 7, 7, 0), c(122, 0, 3, 3, 1, 0, 4), END]);
  assert.deepEqual(t.changes, ["switch 7 → ON", "variable 3 → 4"]);
});

test("a range is summarised as one changes entry per command", () => {
  const t = sim([c(121, 0, 3, 9, 0), c(122, 0, 1, 3, 1, 0, 2), c(122, 0, 1, 3, 4, 0, 0), END]);
  assert.deepEqual(t.changes, ["switches 3..9 → ON", "variables 1..3 += 2", "variables 1..3 unchanged (division by zero)"]);
  assert.deepEqual(t.finalState.variables, { 1: 2, 2: 2, 3: 2 });
});

test("the operand is evaluated once: a variable operand inside its own range is read once", () => {
  const t = sim([c(122, 0, 2, 2, 0, 0, 1), c(122, 0, 1, 3, 1, 1, 2), END]); // v2 = 1; v1..v3 += v2
  assert.deepEqual(t.finalState.variables, { 1: 1, 2: 2, 3: 1 });
});

test("item id 0 or negative is unsupported and not applied", () => {
  const t = sim([c(126, 0, 0, 0, 0, 1), c(126, 0, -2, 0, 0, 1), END]);
  assert.deepEqual(t.unsupported.map((u) => [u.index, u.code]), [[0, 126], [1, 126]]);
  assert.match(t.unsupported[0].message, /item id/);
  assert.deepEqual(t.finalState.items, {});
});

test("a range command inside an infinite loop yields a bounded trace", () => {
  const list = [c(112, 0), c(122, 1, 1, 1000, 1, 0, 1), c(121, 1, 1, 1000, 0), c(413, 0), END];
  const t = sim(list);
  assert.equal(t.ended, "stepLimit");
  assert.ok(JSON.stringify(t).length < 1_000_000, `trace is ${JSON.stringify(t).length} bytes`);
  assert.equal(t.changes.length, 2000);
  assert.ok(t.omitted && t.omitted.changes > 0);
  assert.equal(t.omitted.messages, 0);
  assert.equal(t.omitted.unsupported, 0);
  // 10000 steps = 112 once, then 3333 passes of (122, 121, 413): one summary entry per range command
  assert.equal(t.changes.length + t.omitted.changes, 2 * 3333);
  assert.equal(t.finalState.variables[1], 3333);
  assert.equal(t.finalState.variables[1000], 3333);
  assert.equal(t.finalState.switches[500], true);
});

test("a message-emitting infinite loop is capped and finalState stays exact", () => {
  const list = [c(112, 0), c(401, 1, "again"), c(125, 1, 0, 0, 1), c(413, 0), END];
  const t = sim(list);
  assert.equal(t.ended, "stepLimit");
  assert.equal(t.messages.length, 2000);
  assert.ok(t.omitted.messages > 0);
  // 112 once, then 3333 passes of (401, 125, 413)
  assert.equal(t.messages.length + t.omitted.messages, 3333);
  assert.equal(t.finalState.gold, 3333);
  assert.equal(t.changes.length + t.omitted.changes, 3333);
});

test("unsupported entries are capped too", () => {
  const t = sim([c(112, 0), c(355, 1, "x"), c(413, 0), END]);
  assert.equal(t.unsupported.length, 2000);
  assert.equal(t.unsupported.length + t.omitted.unsupported, 5000);
  assert.equal(sim([c(401, 0, "hi"), END]).omitted, undefined);
});

test("division and modulo by zero leave the variable unchanged and are noted", () => {
  const t = sim([c(122, 0, 1, 1, 0, 0, 9), c(122, 0, 1, 1, 4, 0, 0), c(122, 0, 1, 1, 5, 0, 0), END]);
  assert.equal(t.finalState.variables[1], 9);
  assert.equal(t.changes.filter((x) => /by zero/.test(x)).length, 2);
  assert.equal(t.ended, "end");
});

test("variable ranges apply to every id", () => {
  const t = sim([c(122, 0, 2, 4, 0, 0, 1), c(121, 0, 5, 6, 0), END]);
  assert.deepEqual(t.finalState.variables, { 2: 1, 3: 1, 4: 1 });
  assert.deepEqual(t.finalState.switches, { 5: true, 6: true });
});

test("exit command stops later commands and ends \"exit\"", () => {
  const t = sim([c(401, 0, "one"), c(115, 0), c(401, 0, "two"), END]);
  assert.deepEqual(t.messages, ["one"]);
  assert.equal(t.ended, "exit");
});

test("transfer is recorded and ends \"transfer\"", () => {
  const t = sim([c(201, 0, 0, 2, 4, 5, 2, 0), c(401, 0, "never"), END]);
  assert.deepEqual(t.transfers, [{ mapId: 2, x: 4, y: 5 }]);
  assert.deepEqual(t.messages, []);
  assert.equal(t.ended, "transfer");
});

test("variable-designated transfer reads the variables", () => {
  const t = sim([c(201, 0, 1, 1, 2, 3, 2, 0), END], {}, freshState({ variables: { 1: 7, 2: 8, 3: 9 } }));
  assert.deepEqual(t.transfers, [{ mapId: 7, x: 8, y: 9 }]);
});

test("infinite loop ends \"stepLimit\"", () => {
  const t = sim([c(112, 0), c(121, 1, 1, 1, 0), c(413, 0), END]);
  assert.equal(t.ended, "stepLimit");
  const empty = sim([c(112, 0), c(413, 0), END]);
  assert.equal(empty.ended, "stepLimit");
});

test("loop with break runs until the break condition", () => {
  const list = [
    c(112, 0),
    c(122, 1, 1, 1, 1, 0, 1), // v1 += 1
    c(111, 1, 1, 1, 0, 3, 1), // v1 >= 3
    c(113, 2),
    c(0, 2),
    c(412, 1),
    c(413, 0),
    c(401, 0, "out"),
    END,
  ];
  const t = sim(list);
  assert.equal(t.finalState.variables[1], 3);
  assert.deepEqual(t.messages, ["out"]);
  assert.equal(t.ended, "end");
});

test("break inside a conditional ignores a later sibling loop", () => {
  const list = [
    c(112, 0),
    c(111, 1, 0, 1, 1), // switch 1 is OFF -> true when OFF
    c(113, 2),
    c(0, 2),
    c(412, 1),
    c(413, 0),
    c(401, 0, "after outer"),
    c(112, 0),
    c(413, 0),
    END,
  ];
  const t = sim(list);
  assert.deepEqual(t.messages, ["after outer"]);
  assert.equal(t.ended, "stepLimit"); // the trailing empty loop never ends
});

test("recursive common event stops at depth 8 without throwing", () => {
  const ce = [c(401, 0, "x"), c(117, 0, 1), END];
  let t;
  assert.doesNotThrow(() => {
    t = sim([c(117, 0, 1), END], { commonEvents: (id) => (id === 1 ? ce : null) });
  });
  assert.equal(t.messages.length, 8);
  assert.equal(t.unsupported.length, 1);
  assert.equal(t.unsupported[0].code, 117);
  assert.match(t.unsupported[0].message, /depth/i);
  assert.equal(t.ended, "end");
});

test("common event runs inline, exit inside it ends only the common event", () => {
  const ce = [c(401, 0, "inner"), c(115, 0), c(401, 0, "never"), END];
  const t = sim([c(117, 0, 4), c(401, 0, "outer"), END], { commonEvents: (id) => (id === 4 ? ce : null) });
  assert.deepEqual(t.messages, ["inner", "outer"]);
  assert.equal(t.ended, "end");
});

test("unknown common event is recorded as unsupported and skipped", () => {
  const t = sim([c(117, 0, 9), c(401, 0, "next"), END]);
  assert.deepEqual(t.unsupported.map((u) => [u.index, u.code]), [[0, 117]]);
  assert.deepEqual(t.messages, ["next"]);
});

test("script command is listed in unsupported but execution continues", () => {
  const t = sim([c(355, 0, "$gameVariables.setValue(1, 5)"), c(655, 0, "more"), c(401, 0, "still here"), END]);
  assert.deepEqual(t.unsupported.map((u) => [u.index, u.code]), [[0, 355]]);
  assert.deepEqual(t.messages, ["still here"]);
  assert.equal(t.ended, "end");
});

test("plugin command is recorded in changes", () => {
  const t = sim([c(356, 0, "Foo bar 1"), END]);
  assert.deepEqual(t.changes, ["plugin: Foo bar 1"]);
});

test("comments are ignored", () => {
  const t = sim([c(108, 0, "note"), c(408, 0, "more"), END]);
  assert.deepEqual(t.unsupported, []);
  assert.deepEqual(t.changes, []);
});

const unknownCond = [c(111, 0, 12, "x === 1"), c(401, 1, "then"), c(0, 1), c(411, 0), c(401, 1, "else"), c(0, 1), c(412, 0), c(401, 0, "after"), END];

test("unknownCondition \"stop\" ends \"unsupported\" at the condition's index", () => {
  const t = sim([c(401, 0, "before"), ...unknownCond], { unknownCondition: "stop" });
  assert.equal(t.ended, "unsupported");
  assert.deepEqual(t.unsupported.map((u) => [u.index, u.code]), [[1, 111]]);
  assert.deepEqual(t.messages, ["before"]);
});

test("unknownCondition \"then\" and \"else\" choose the branch", () => {
  const th = sim(unknownCond, { unknownCondition: "then" });
  assert.deepEqual(th.messages, ["then", "after"]);
  assert.equal(th.ended, "end");
  assert.equal(th.unsupported.length, 1);
  assert.deepEqual(sim(unknownCond, { unknownCondition: "else" }).messages, ["else", "after"]);
});

test("random operand is deterministic for a fixed seed", () => {
  const list = [c(122, 0, 1, 3, 0, 2, 1, 100), END];
  const a = sim(list, { seed: 42 });
  const b = sim(list, { seed: 42 });
  assert.deepEqual(a.finalState.variables, b.finalState.variables);
  for (const id of [1, 2, 3]) {
    assert.ok(a.finalState.variables[id] >= 1 && a.finalState.variables[id] <= 100);
  }
  // one draw per command: every variable in the range gets the same value
  assert.equal(new Set(Object.values(a.finalState.variables)).size, 1);
  const other = sim(list, { seed: 43 });
  assert.notDeepEqual(other.finalState.variables, a.finalState.variables);
  assert.deepEqual(sim(list).finalState.variables, sim(list, { seed: 0 }).finalState.variables);
});

test("conditional types: switch, variable, self switch, gold, item", () => {
  const branch = (cond) => sim([cond, c(401, 1, "T"), c(0, 1), c(411, 0), c(401, 1, "F"), c(0, 1), c(412, 0), END], {}, st).messages[0];
  const st = freshState({ switches: { 2: true }, variables: { 1: 5, 2: 5 }, selfSwitches: { B: true }, gold: 50, items: { 3: 2 } });
  assert.equal(branch(c(111, 0, 0, 2, 0)), "T");
  assert.equal(branch(c(111, 0, 0, 2, 1)), "F");
  assert.equal(branch(c(111, 0, 0, 9, 1)), "T");
  assert.equal(branch(c(111, 0, 1, 1, 0, 5, 0)), "T"); // v1 == 5
  assert.equal(branch(c(111, 0, 1, 1, 0, 6, 1)), "F"); // v1 >= 6
  assert.equal(branch(c(111, 0, 1, 1, 0, 5, 2)), "T"); // v1 <= 5
  assert.equal(branch(c(111, 0, 1, 1, 0, 5, 3)), "F"); // v1 > 5
  assert.equal(branch(c(111, 0, 1, 1, 0, 6, 4)), "T"); // v1 < 6
  assert.equal(branch(c(111, 0, 1, 1, 0, 6, 5)), "T"); // v1 != 6
  assert.equal(branch(c(111, 0, 1, 1, 1, 2, 0)), "T"); // v1 == v2
  assert.equal(branch(c(111, 0, 2, "B", 0)), "T");
  assert.equal(branch(c(111, 0, 2, "A", 0)), "F");
  assert.equal(branch(c(111, 0, 7, 50, 0)), "T"); // gold >= 50
  assert.equal(branch(c(111, 0, 7, 50, 1)), "T"); // gold <= 50
  assert.equal(branch(c(111, 0, 7, 50, 2)), "F"); // gold < 50
  assert.equal(branch(c(111, 0, 8, 3)), "T");
  assert.equal(branch(c(111, 0, 8, 4)), "F");
});

test("gold and items clamp at zero and record changes", () => {
  const t = sim([c(125, 0, 1, 0, 30), c(126, 0, 3, 0, 0, 2), c(126, 0, 3, 1, 0, 5), c(125, 0, 0, 1, 1), END], {}, freshState({ gold: 10, variables: { 1: 4 } }));
  assert.equal(t.finalState.gold, 4);
  assert.deepEqual(t.finalState.items, { 3: 0 });
  assert.deepEqual(t.changes, ["gold -30 → 0", "item 3 +2 → 2", "item 3 -5 → 0", "gold +4 → 4"]);
});

test("malformed entries do not throw and are listed as unsupported", () => {
  const list = [
    null,
    { code: 401, indent: 0 },
    { code: 401, indent: 0, parameters: "oops" },
    "junk",
    c(121, 0, "a", "b", 0),
    c(122, 0, 1),
    c(111, 0),
    c(401, 1, "inside"),
    c(0, 1),
    c(412, 0),
    c(123, 0),
    c(125, 0),
    c(201, 0),
    c(117, 0),
    c(102, 0),
    c(401, 0, "survived"),
    END,
  ];
  let t;
  assert.doesNotThrow(() => {
    t = sim(list, { unknownCondition: "else" });
  });
  assert.equal(t.ended, "end");
  assert.ok(t.messages.includes("survived"));
  const idx = t.unsupported.map((u) => u.index);
  for (const i of [0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14]) assert.ok(idx.includes(i), `index ${i} listed`);
});

test("a list that is not an array does not throw", () => {
  assert.doesNotThrow(() => sim(null));
  assert.equal(sim(undefined).ended, "end");
});

// ---- tool ----

async function withProject(data, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-sim-"));
  try {
    await fs.mkdir(path.join(dir, "data"));
    for (const [name, value] of Object.entries(data)) {
      await fs.writeFile(path.join(dir, "data", name), JSON.stringify(value), "utf8");
    }
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function connect(args) {
  const client = new Client({ name: "sim-test", version: "0.0.0" });
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

const page = (conditions, list) => ({ conditions, list: [...list, END], image: {}, moveRoute: {} });
const off = { switch1Valid: false, switch2Valid: false, variableValid: false, selfSwitchValid: false, itemValid: false, actorValid: false };
const msg = (text) => [c(101, 0, "", 0, 0, 2), c(401, 0, text)];

const simData = () => ({
  "System.json": { switches: ["", "Chest"], variables: ["", "Gold"] },
  "MapInfos.json": [null, { id: 1, name: "Town" }],
  "CommonEvents.json": [null, { id: 1, name: "greet", list: [c(401, 0, "hello from common"), END] }],
  "Map001.json": {
    width: 10,
    height: 10,
    events: [
      null,
      {
        id: 1,
        name: "Sage",
        pages: [
          page(off, [...msg("page zero"), c(117, 0, 1)]),
          page({ ...off, switch1Valid: true, switch1Id: 4 }, msg("page one")),
          page({ ...off, variableValid: true, variableId: 2, variableValue: 10 }, msg("page two")),
          page({ ...off, selfSwitchValid: true, selfSwitchCh: "C" }, msg("page three")),
          page({ ...off, itemValid: true, itemId: 6 }, msg("page four")),
        ],
      },
    ],
  },
});

const text = (res) => res.content[0].text;

test("simulate_event before set_project returns the No project selected error", async () => {
  const client = await connect([]);
  try {
    const res = await client.callTool({ name: "simulate_event", arguments: { mapId: 1, eventId: 1 } });
    assert.equal(res.isError, true);
    assert.match(text(res), /No project selected/);
  } finally {
    await client.close();
  }
});

test("simulate_event picks the highest page whose conditions hold and runs common events", async () => {
  await withProject(simData(), async (dir) => {
    const client = await connect(["--project", dir]);
    try {
      const run = async (args) => {
        const res = await client.callTool({ name: "simulate_event", arguments: { mapId: 1, eventId: 1, ...args } });
        assert.notEqual(res.isError, true, text(res));
        return JSON.parse(text(res));
      };
      let r = await run({});
      assert.equal(r.pageUsed, 0);
      assert.deepEqual(r.messages, ["page zero", "hello from common"]);
      assert.equal(r.ended, "end");

      assert.equal((await run({ switches: { "4": true } })).pageUsed, 1);
      assert.equal((await run({ switches: { "4": true }, variables: { "2": 10 } })).pageUsed, 2);
      assert.equal((await run({ variables: { "2": 9 } })).pageUsed, 0);
      assert.equal((await run({ selfSwitches: { C: true }, variables: { "2": 10 } })).pageUsed, 3);
      assert.equal((await run({ items: { "6": 1 }, selfSwitches: { C: true } })).pageUsed, 4);
      assert.equal((await run({ items: { "6": 0 } })).pageUsed, 0);

      r = await run({ page: 1 });
      assert.equal(r.pageUsed, 1);
      assert.deepEqual(r.messages, ["page one"]);
      assert.deepEqual(r.finalState.switches, {});
    } finally {
      await client.close();
    }
  });
});

test("simulate_event reports unknown map, event and page, and rejects bad ids", async () => {
  await withProject(simData(), async (dir) => {
    const client = await connect(["--project", dir]);
    try {
      const call = (args) => client.callTool({ name: "simulate_event", arguments: args });
      let res = await call({ mapId: 1, eventId: 99 });
      assert.equal(res.isError, true);
      assert.match(text(res), /event 99/i);
      res = await call({ mapId: 1, eventId: 1, page: 7 });
      assert.equal(res.isError, true);
      assert.match(text(res), /page 7/i);
      res = await call({ mapId: 5, eventId: 1 });
      assert.equal(res.isError, true);
      res = await call({ mapId: 1, eventId: 1, switches: { abc: true } });
      assert.equal(res.isError, true);
      res = await call({ mapId: 1, eventId: 1, variables: { "0": 3 } });
      assert.equal(res.isError, true);
      res = await call({ mapId: 1, eventId: 1, choices: [-1] });
      assert.equal(res.isError, true);
      res = await call({ mapId: 1, eventId: 1, choices: new Array(51).fill(0) });
      assert.equal(res.isError, true);
    } finally {
      await client.close();
    }
  });
});

// ---- cutscene and battle commands ----

const COSMETIC_CODES = [205, 212, 213, 221, 222, 223, 224, 225, 230, 231, 232, 235, 236, 241, 242, 245, 246, 249, 250, 251, 505];
const withEnd = (list) => [...list, END];

test("a compiled cutscene simulates with nothing unsupported, counts the presentation commands and keeps the message", () => {
  const list = withEnd(compileDialogue([
    { fade: "out" },
    { wait: 30 },
    { showPicture: { id: 1, name: "Sunrise", x: 0, y: 0 } },
    { playAudio: { kind: "bgm", name: "Theme1" } },
    { moveRoute: { target: "player", steps: ["up", "up", { wait: 10 }, "turnLeft"] } },
    { fade: "in" },
    { say: "The morning came." },
  ]));
  const presentation = list.filter((cmd) => COSMETIC_CODES.includes(cmd.code)).length;
  const t = sim(list);
  assert.deepEqual(t.unsupported, []);
  assert.deepEqual(t.messages, ["The morning came."]);
  assert.equal(t.ended, "end");
  assert.equal(t.cosmetic, presentation);
  assert.equal(t.cosmetic, 1 + 1 + 1 + 1 + 1 + 4 + 1); // fade, wait, picture, bgm, 205 + 4 rows, fade
  assert.deepEqual(t.changes, []);
});

test("every cosmetic code is ignored and counted, none is listed as unsupported", () => {
  for (const code of COSMETIC_CODES) {
    const t = sim([c(code, 0, 1, 2, 3), END]);
    assert.deepEqual(t.unsupported, [], `code ${code}`);
    assert.equal(t.cosmetic, 1, `code ${code}`);
  }
  assert.equal(sim([END]).cosmetic, 0);
  // Commands skipped by a block are not counted.
  assert.equal(sim([c(111, 0, 0, 1, 0), c(221, 1), c(0, 1), c(412, 0), END]).cosmetic, 0);
});

test("Move Picture (232) is cosmetic like Show and Erase Picture, not unsupported", () => {
  const t = sim([c(231, 0, 1, "Pic", 0, 0, 0, 0, 100, 100, 255, 0), c(232, 0, 1, "", 0, 0, 10, 10, 100, 100, 255, 0, 30, true), c(235, 0, 1), END]);
  assert.deepEqual(t.unsupported, []);
  assert.equal(t.cosmetic, 3);
  assert.equal(t.ended, "end");
  // Rotate (233) and Tint Picture (234) are still not simulated
  assert.deepEqual(sim([c(233, 0, 1, 5), c(234, 0, 1), END]).unsupported.map((u) => u.code), [233, 234]);
});

test("the inn template simulates with the fades and wait cosmetic and only recover-all (314) unsupported", () => {
  const { pages } = buildTemplate(templateParamsSchema.parse({ template: "inn", price: 50, greeting: "Welcome!" }));
  const t = sim(pages[0].list, { choices: [0] }, freshState({ gold: 100 }));
  assert.deepEqual(t.unsupported.map((u) => u.code), [314]);
  assert.equal(t.cosmetic, 3); // 221, 230, 222
  assert.equal(t.finalState.gold, 50);
});

test("Set Movement Route applies switch ON and OFF route commands in order and stays cosmetic otherwise", () => {
  const step = (code, ...parameters) => ({ code, parameters, indent: null });
  const route = (...list) => c(205, 0, -1, { list: [...list, { code: 0, parameters: [] }], repeat: false, skippable: false, wait: true });
  const t = sim(withEnd([route(step(1), step(27, 4), step(28, 5), step(27, 6), step(28, 6))]), {}, freshState({ switches: { 5: true } }));
  assert.deepEqual(t.unsupported, []);
  assert.equal(t.cosmetic, 1);
  assert.deepEqual(t.changes, ["switch 4 → ON (move route)", "switch 5 → OFF (move route)", "switch 6 → ON (move route)", "switch 6 → OFF (move route)"]);
  assert.equal(t.finalState.switches[4], true);
  assert.equal(t.finalState.switches[5], false);
  assert.equal(t.finalState.switches[6], false);
});

test("a compiled move route with switchOn changes the simulated switches", () => {
  const t = sim(withEnd(compileDialogue([{ moveRoute: { target: "this", steps: [{ switchOn: 9 }, "down"] } }])));
  assert.equal(t.finalState.switches[9], true);
  assert.deepEqual(t.changes, ["switch 9 → ON (move route)"]);
  assert.equal(t.cosmetic, 3); // 205 + two 505 rows
});

test("malformed Set Movement Route parameters never throw and count as cosmetic", () => {
  const bad = [
    c(205, 0),
    c(205, 0, -1),
    c(205, 0, -1, null),
    c(205, 0, -1, "route"),
    c(205, 0, -1, {}),
    c(205, 0, -1, { list: "x" }),
    c(205, 0, -1, { list: [null, 5, { code: 27 }, { code: 27, parameters: [] }, { code: 27, parameters: ["a"] }, { code: 27, parameters: [0] }, { code: 28, parameters: [1.5] }] }),
    END,
  ];
  let t;
  assert.doesNotThrow(() => { t = sim(bad); });
  assert.equal(t.cosmetic, 7);
  assert.deepEqual(t.unsupported, []);
  assert.deepEqual(t.changes, []);
  assert.deepEqual(t.finalState.switches, {});
  assert.equal(t.ended, "end");
});

// ---- move route bounds ----

const routeStep = (code, ...parameters) => ({ code, parameters, indent: null });
const routeCmd = (list) => c(205, 0, -1, { list, repeat: false, skippable: false, wait: true });
const alternating = (n) => Array.from({ length: n }, (_, k) => routeStep(k % 2 === 0 ? 27 : 28, 1));

test("a huge move route inside a loop is charged against the step budget and ends stepLimit quickly", () => {
  const started = Date.now();
  const t = sim([c(112, 0), routeCmd(alternating(100000)), c(413, 0), END]);
  assert.equal(t.ended, "stepLimit");
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.ok(t.unsupported.some((u) => u.code === 205 && /1000/.test(u.message)));
});

test("a route with more than 1000 entries applies switch commands only within the first 1000 and reports the truncation", () => {
  const list = Array.from({ length: 1500 }, () => routeStep(1));
  list[999] = routeStep(27, 7); // the 1000th entry: still scanned
  list[1000] = routeStep(27, 8); // the 1001st: not scanned
  const t = sim([routeCmd(list), END]);
  assert.equal(t.finalState.switches[7], true);
  assert.equal(t.finalState.switches[8], undefined);
  assert.equal(t.cosmetic, 1);
  assert.equal(t.unsupported.length, 1);
  assert.deepEqual([t.unsupported[0].index, t.unsupported[0].code], [0, 205]);
  assert.match(t.unsupported[0].message, /1000/);
  assert.equal(t.ended, "end");
  // Exactly 1000 entries is not truncated.
  assert.deepEqual(sim([routeCmd(list.slice(0, 1000)), END]).unsupported, []);
});

test("scanned route entries count against the step budget", () => {
  // 10 iterations of a 1000-entry route use the whole 10000-step budget.
  const t = sim([c(112, 0), routeCmd(alternating(1000)), c(413, 0), END]);
  assert.equal(t.ended, "stepLimit");
  assert.ok(t.changes.length < 10 * 1000 + 1);
});

test("move route switch ids are bounded", () => {
  const t = sim([routeCmd([routeStep(27, 1e21), routeStep(27, 100001), routeStep(27, 100000)]), END]);
  assert.deepEqual(Object.keys(t.finalState.switches), ["100000"]);
  assert.deepEqual(t.changes, ["switch 100000 → ON (move route)"]);
});

// A battle whose branches set variable 1 to 1 (win), 2 (escape) or 3 (lose).
const battleList = (tree) => withEnd(compileDialogue(tree));
const fullBattle = battleList([
  { battle: { troopId: 3, canEscape: true, canLose: true,
    onWin: [{ setVariable: { id: 1, op: "set", value: 1 } }, { say: "won" }],
    onEscape: [{ setVariable: { id: 1, op: "set", value: 2 } }],
    onLose: [{ setVariable: { id: 1, op: "set", value: 3 } }] } },
  { say: "after" },
]);

test("Battle Processing runs the branch that matches battleResult, then continues after the block", () => {
  for (const [result, expected] of [["win", 1], ["escape", 2], ["lose", 3]]) {
    const t = sim(fullBattle, { battleResult: result });
    assert.equal(t.finalState.variables[1], expected, result);
    assert.equal(t.messages.at(-1), "after", result);
    assert.deepEqual(t.unsupported, [], result);
    assert.equal(t.ended, "end", result);
  }
  assert.deepEqual(sim(fullBattle, { battleResult: "win" }).messages, ["won", "after"]);
  assert.deepEqual(sim(fullBattle, { battleResult: "lose" }).messages, ["after"]);
});

test("Battle Processing defaults to a win", () => {
  assert.equal(sim(fullBattle).finalState.variables[1], 1);
  assert.equal(sim(fullBattle, { battleResult: undefined }).finalState.variables[1], 1);
});

test("a battle without the chosen branch is skipped with a note in changes", () => {
  const onlyWin = battleList([
    { battle: { troopId: 1, onWin: [{ setVariable: { id: 1, op: "set", value: 1 } }] } },
    { say: "after" },
  ]);
  let t = sim(onlyWin, { battleResult: "lose" });
  assert.deepEqual(t.changes, ["battle: cannot lose (canLose is false)", "battle: no lose branch"]);
  assert.equal(t.finalState.variables[1], undefined);
  assert.deepEqual(t.messages, ["after"]);
  t = sim(onlyWin, { battleResult: "escape" });
  assert.deepEqual(t.changes, ["battle: cannot escape (canEscape is false)", "battle: no escape branch"]);
  const bare = sim(battleList([{ battle: { troopId: 1 } }, { say: "after" }]));
  assert.deepEqual(bare.changes, []);
  assert.deepEqual(bare.messages, ["after"]);
  assert.deepEqual(bare.unsupported, []);
});

test("a branchless battle (editor style: no 601-604) does not skip the commands after it", () => {
  const list = [c(301, 0, 0, 1, false, false), c(121, 0, 7, 7, 0), c(401, 0, "later"), END];
  for (const result of ["win", undefined]) {
    const t = sim(list, { battleResult: result });
    assert.equal(t.finalState.switches[7], true);
    assert.deepEqual(t.changes, ["switch 7 → ON"]);
    assert.equal(t.ended, "end");
  }
  assert.deepEqual(sim(list, { battleResult: "escape" }).changes, ["battle: cannot escape (canEscape is false)", "switch 7 → ON"]);
  assert.deepEqual(sim(list, { battleResult: "lose" }).changes, ["battle: cannot lose (canLose is false)", "switch 7 → ON"]);
});

test("a branchless battle followed later by a battle with branches never jumps into the second one's 601", () => {
  const list = [
    c(301, 0, 0, 1, false, false),
    c(121, 0, 1, 1, 0),
    c(301, 0, 0, 2, true, true),
    c(601, 0), c(121, 1, 2, 2, 0),
    c(602, 0), c(121, 1, 3, 3, 0),
    c(603, 0), c(121, 1, 4, 4, 0),
    c(604, 0),
    c(121, 0, 5, 5, 0),
    END,
  ];
  const win = sim(list, { battleResult: "win" });
  assert.deepEqual(Object.keys(win.finalState.switches).sort(), ["1", "2", "5"]);
  const lose = sim(list, { battleResult: "lose" });
  assert.deepEqual(Object.keys(lose.finalState.switches).sort(), ["1", "4", "5"]);
});

test("a battle branch can contain choices and an exit; nesting indents are respected", () => {
  const list = battleList([
    { battle: { troopId: 1, canLose: true,
      onWin: [{ choices: [{ label: "A", then: [{ setVariable: { id: 2, op: "set", value: 10 } }] }, { label: "B" }] }],
      onLose: [{ say: "dead" }, { exit: true }] } },
    { say: "after" },
  ]);
  let t = sim(list, { battleResult: "win" });
  assert.equal(t.finalState.variables[2], 10);
  assert.deepEqual(t.messages, ["after"]);
  t = sim(list, { battleResult: "lose" });
  assert.deepEqual(t.messages, ["dead"]);
  assert.equal(t.ended, "exit");
});

test("Label / Jump to Label: 118 is a no-op, 119 jumps forward and backward", () => {
  const forward = sim(withEnd([c(119, 0, "skip"), c(401, 0, "never"), c(118, 0, "skip"), c(401, 0, "landed")]));
  assert.deepEqual(forward.messages, ["landed"]);
  assert.deepEqual(forward.unsupported, []);

  const backward = sim(withEnd([
    c(118, 0, "top"),
    c(122, 0, 1, 1, 1, 0, 1), // variable 1 += 1
    c(111, 0, 1, 1, 0, 3, 4), // if variable 1 < 3
    c(119, 1, "top"),
    c(0, 1),
    c(412, 0),
    c(401, 0, "done"),
  ]));
  assert.equal(backward.finalState.variables[1], 3);
  assert.deepEqual(backward.messages, ["done"]);
  assert.equal(backward.ended, "end");
});

test("119 finds the first label with that name anywhere in the list, even inside a block", () => {
  const t = sim(withEnd([
    c(119, 0, "in"),
    c(401, 0, "never"),
    c(111, 0, 0, 1, 0),
    c(118, 1, "in"),
    c(401, 1, "inside"),
    c(0, 1),
    c(412, 0),
    c(401, 0, "tail"),
  ]), {}, freshState({ switches: { 1: false } }));
  assert.deepEqual(t.messages, ["inside", "tail"]);
});

test("a label loop ends in stepLimit and does not throw", () => {
  let t;
  assert.doesNotThrow(() => { t = sim(withEnd([c(118, 0, "x"), c(119, 0, "x")])); });
  assert.equal(t.ended, "stepLimit");
});

test("Jump to Label with a missing or malformed label is reported and execution continues", () => {
  const t = sim(withEnd([c(119, 0, "nowhere"), c(401, 0, "next"), c(119, 0), c(401, 0, "last")]));
  assert.deepEqual(t.messages, ["next", "last"]);
  assert.deepEqual(t.unsupported.map((u) => [u.index, u.code]), [[0, 119], [2, 119]]);
  assert.match(t.unsupported[0].message, /nowhere/);
  assert.equal(t.ended, "end");
});

test("a label is only looked up in the current command list, not in the caller's", () => {
  const ce = withEnd([c(119, 0, "a"), c(401, 0, "from ce")]);
  const t = sim(withEnd([c(118, 0, "a"), c(117, 0, 1), c(401, 0, "back")]), { commonEvents: (id) => (id === 1 ? ce : null) });
  assert.deepEqual(t.messages, ["from ce", "back"]);
  assert.equal(t.unsupported.length, 1);
  assert.equal(t.unsupported[0].code, 119);
});

test("simulate_event battleResult selects the branch and the trace carries cosmetic", async () => {
  const data = simData();
  data["Map001.json"].events[1].pages[0].list = [...fullBattle.slice(0, -1), c(221, 0), END];
  await withProject(data, async (dir) => {
    const client = await connect(["--project", dir]);
    try {
      const run = async (args) => {
        const res = await client.callTool({ name: "simulate_event", arguments: { mapId: 1, eventId: 1, page: 0, ...args } });
        assert.notEqual(res.isError, true, text(res));
        return JSON.parse(text(res));
      };
      assert.equal((await run({})).finalState.variables["1"], 1);
      for (const [result, expected] of [["win", 1], ["escape", 2], ["lose", 3]]) {
        const r = await run({ battleResult: result });
        assert.equal(r.finalState.variables["1"], expected, result);
        assert.equal(r.cosmetic, 1);
      }
      const bad = await client.callTool({ name: "simulate_event", arguments: { mapId: 1, eventId: 1, battleResult: "draw" } });
      assert.equal(bad.isError, true);
      const tool = (await client.listTools()).tools.find((t) => t.name === "simulate_event");
      assert.match(tool.description, /battleResult/);
      assert.match(tool.description, /cosmetic/);
    } finally {
      await client.close();
    }
  });
});


test("an impossible battle outcome still runs the branch but notes it", () => {
  const t = (tree, result) => sim(battleList(tree), { battleResult: result });
  const noEscape = [{ battle: { troopId: 1, onWin: [{ say: "w" }] } }];
  assert.deepEqual(t(noEscape, "escape").changes, ["battle: cannot escape (canEscape is false)", "battle: no escape branch"]);
  assert.deepEqual(t(noEscape, "lose").changes, ["battle: cannot lose (canLose is false)", "battle: no lose branch"]);
  assert.deepEqual(t(noEscape, "win").changes, []);
  // A hand-built block with the branch present: it runs, with the note.
  const list = [c(301, 0, 0, 1, false, false), c(602, 0), c(401, 1, "fled"), c(0, 1), c(604, 0), END];
  const r = sim(list, { battleResult: "escape" });
  assert.deepEqual(r.messages, ["fled"]);
  assert.deepEqual(r.changes, ["battle: cannot escape (canEscape is false)"]);
  const ok = sim([c(301, 0, 0, 1, true, true), c(603, 0), c(401, 1, "dead"), c(0, 1), c(604, 0), END], { battleResult: "lose" });
  assert.deepEqual(ok.changes, []);
});

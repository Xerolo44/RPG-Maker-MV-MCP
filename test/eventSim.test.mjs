import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { simulateEvent } from "../dist/eventSim.js";

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

test("variable arithmetic: add, multiply, and divide with integer truncation", () => {
  const list = [
    c(122, 0, 1, 1, 0, 0, 7), // v1 = 7
    c(122, 0, 1, 1, 1, 0, 5), // v1 += 5 -> 12
    c(122, 0, 1, 1, 3, 0, 3), // v1 *= 3 -> 36
    c(122, 0, 1, 1, 2, 0, 6), // v1 -= 6 -> 30
    c(122, 0, 2, 2, 0, 1, 1), // v2 = v1 -> 30
    c(122, 0, 2, 2, 4, 0, 7), // v2 /= 7 -> 4 (4.28 truncated)
    c(122, 0, 3, 3, 0, 0, -7),
    c(122, 0, 3, 3, 4, 0, 2), // -3.5 truncated toward zero
    c(122, 0, 4, 4, 0, 0, 10),
    c(122, 0, 4, 4, 5, 0, 4), // 10 % 4
    END,
  ];
  const t = sim(list);
  assert.deepEqual(t.finalState.variables, { 1: 30, 2: 4, 3: -3, 4: 2 });
  assert.ok(t.changes.includes("variable 1 → 36"));
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
  assert.equal(new Set(Object.values(a.finalState.variables)).size > 1, true);
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

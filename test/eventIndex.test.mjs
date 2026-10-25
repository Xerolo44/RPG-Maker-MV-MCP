import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Project } from "../dist/project.js";
import { buildProjectIndex, commandRefs, conditionRefs, hiddenKind } from "../dist/eventIndex.js";
import { END, c, createFixtureProject, event, page } from "./helpers/fixtureProject.mjs";

const r = (kind, id, role) => ({ kind, id, role });

// ---- commandRefs: one case per row of the extraction table ----

const ROWS = [
  ["111 switch", c(111, 0, 0, 5, 0), [r("switch", 5, "read")]],
  ["111 variable vs constant", c(111, 0, 1, 3, 0, 2, 0), [r("variable", 3, "read")]],
  ["111 variable vs variable", c(111, 0, 1, 3, 1, 4, 0), [r("variable", 3, "read"), r("variable", 4, "read")]],
  ["111 self switch", c(111, 0, 2, "A", 0), []],
  ["111 actor", c(111, 0, 4, 2, 0), [r("actor", 2, "read")]],
  ["111 item", c(111, 0, 8, 7), [r("item", 7, "read")]],
  ["111 weapon", c(111, 0, 9, 7), [r("weapon", 7, "read")]],
  ["111 armor", c(111, 0, 10, 7), [r("armor", 7, "read")]],
  ["111 script", c(111, 0, 12, "a > b"), []],
  ["117 common event", c(117, 0, 4), [r("commonEvent", 4, "use")]],
  ["121 range", c(121, 0, 3, 5, 0), [r("switch", 3, "write"), r("switch", 4, "write"), r("switch", 5, "write")]],
  ["121 single", c(121, 0, 8, 8, 1), [r("switch", 8, "write")]],
  ["122 range, constant operand", c(122, 0, 2, 3, 0, 0, 5), [r("variable", 2, "write"), r("variable", 3, "write")]],
  ["122 variable operand", c(122, 0, 2, 2, 0, 1, 9), [r("variable", 2, "write"), r("variable", 9, "read")]],
  ["122 random operand", c(122, 0, 2, 2, 0, 2, 1, 6), [r("variable", 2, "write")]],
  ["126 item", c(126, 0, 4, 0, 0, 1), [r("item", 4, "write")]],
  ["127 weapon", c(127, 0, 4, 0, 0, 1, false), [r("weapon", 4, "write")]],
  ["128 armor", c(128, 0, 4, 0, 0, 1, false), [r("armor", 4, "write")]],
  ["129 actor", c(129, 0, 2, 0, 0), [r("actor", 2, "write")]],
  ["201 direct", c(201, 0, 0, 3, 5, 6, 2, 0), [r("map", 3, "use")]],
  ["201 variable designation", c(201, 0, 1, 3, 5, 6, 2, 0), [r("variable", 3, "read"), r("variable", 5, "read"), r("variable", 6, "read")]],
  ["301 direct", c(301, 0, 0, 4, false, false), [r("troop", 4, "use")]],
  ["301 variable designation", c(301, 0, 1, 4, false, false), [r("variable", 4, "read")]],
  ["301 same as random encounter", c(301, 0, 2, 4, false, false), []],
  ["302 item", c(302, 0, 0, 5, 0, 100, false), [r("item", 5, "use")]],
  ["302 weapon", c(302, 0, 1, 5, 0, 100, false), [r("weapon", 5, "use")]],
  ["302 armor", c(302, 0, 2, 5, 0, 100, false), [r("armor", 5, "use")]],
  ["605 item", c(605, 0, 0, 6, 0, 100, false), [r("item", 6, "use")]],
  ["605 armor", c(605, 0, 2, 6, 0, 100, false), [r("armor", 6, "use")]],
  ["302 unknown goods type", c(302, 0, 3, 5, 0, 100, false), []],
  ["311 change HP", c(311, 0, 0, 2, 0, 0, 10, false), [r("actor", 2, "use")]],
  ["311 variable actor", c(311, 0, 1, 2, 0, 0, 10, false), [r("variable", 2, "read")]],
  ["312 change MP", c(312, 0, 0, 2, 0, 0, 10), [r("actor", 2, "use")]],
  ["313 change state", c(313, 0, 0, 2, 0, 7), [r("actor", 2, "use"), r("state", 7, "write")]],
  ["313 variable actor still writes the state", c(313, 0, 1, 2, 0, 7), [r("variable", 2, "read"), r("state", 7, "write")]],
  ["315 change EXP", c(315, 0, 0, 2, 0, 0, 10, false), [r("actor", 2, "use")]],
  ["316 change level", c(316, 0, 0, 2, 0, 0, 1, false), [r("actor", 2, "use")]],
  ["317 change parameter", c(317, 0, 0, 2, 0, 0, 0, 5), [r("actor", 2, "use")]],
  ["318 change skill", c(318, 0, 0, 2, 0, 9), [r("actor", 2, "use"), r("skill", 9, "write")]],
  ["321 change class", c(321, 0, 2, 3, true), [r("actor", 2, "use"), r("class", 3, "use")]],
  ["322 change actor graphic", c(322, 0, 2, "Actor1", 0), [r("actor", 2, "use")]],
  ["303 name input", c(303, 0, 2, 8), [r("actor", 2, "use")]],
  ["a command with no references", c(101, 0, "", 0, 0, 2), []],
  ["the list terminator", END, []],

  // completeness round: variable operands and designations
  ["201 variable designation with invalid x", c(201, 0, 1, 3, 0, 6, 2, 0), [r("variable", 3, "read"), r("variable", 6, "read")]],
  ["202 vehicle, direct", c(202, 0, 0, 0, 4, 5, 6), [r("map", 4, "use")]],
  ["202 vehicle, variables", c(202, 0, 0, 1, 4, 5, 6), [r("variable", 4, "read"), r("variable", 5, "read"), r("variable", 6, "read")]],
  ["202 vehicle, invalid designation", c(202, 0, 0, 2, 4, 5, 6), []],
  ["203 event location, variables", c(203, 0, 3, 1, 7, 8, 0), [r("variable", 7, "read"), r("variable", 8, "read")]],
  ["203 event location, direct", c(203, 0, 3, 0, 7, 8, 0), []],
  ["203 event location, exchange", c(203, 0, 3, 2, 7, 8, 0), []],
  ["125 change gold, variable operand", c(125, 0, 0, 1, 6), [r("variable", 6, "read")]],
  ["125 change gold, constant operand", c(125, 0, 0, 0, 6), []],
  ["126 variable operand", c(126, 0, 4, 0, 1, 9), [r("item", 4, "write"), r("variable", 9, "read")]],
  ["127 variable operand", c(127, 0, 4, 1, 1, 9, false), [r("weapon", 4, "write"), r("variable", 9, "read")]],
  ["128 variable operand", c(128, 0, 4, 0, 1, 9, false), [r("armor", 4, "write"), r("variable", 9, "read")]],
  ["231 show picture, variables", c(231, 0, 1, "Pic", 0, 1, 11, 12, 100, 100, 255, 0), [r("variable", 11, "read"), r("variable", 12, "read")]],
  ["231 show picture, direct", c(231, 0, 1, "Pic", 0, 0, 11, 12, 100, 100, 255, 0), []],
  ["285 get location info, direct", c(285, 0, 5, 0, 0, 3, 4), [r("variable", 5, "write")]],
  ["285 get location info, variables", c(285, 0, 5, 0, 1, 3, 4), [r("variable", 5, "write"), r("variable", 3, "read"), r("variable", 4, "read")]],
  ["301 random designation", c(301, 0, 2, 0, false, false), []],
  ["311 variable operand", c(311, 0, 0, 2, 0, 1, 7, false), [r("actor", 2, "use"), r("variable", 7, "read")]],
  ["311 variable actor and operand", c(311, 0, 1, 2, 0, 1, 7, false), [r("variable", 2, "read"), r("variable", 7, "read")]],
  ["312 variable operand", c(312, 0, 0, 2, 0, 1, 7), [r("actor", 2, "use"), r("variable", 7, "read")]],
  ["315 variable operand", c(315, 0, 0, 2, 0, 1, 7, false), [r("actor", 2, "use"), r("variable", 7, "read")]],
  ["316 variable operand", c(316, 0, 0, 2, 0, 1, 7, false), [r("actor", 2, "use"), r("variable", 7, "read")]],
  ["312 constant operand", c(312, 0, 0, 2, 0, 0, 7), [r("actor", 2, "use")]],
  ["317 variable operand at p[4]", c(317, 0, 0, 2, 3, 0, 1, 8), [r("actor", 2, "use"), r("variable", 8, "read")]],
  ["317 constant operand", c(317, 0, 0, 2, 3, 0, 0, 8), [r("actor", 2, "use")]],
  ["317 variable actor", c(317, 0, 1, 2, 3, 0, 0, 8), [r("variable", 2, "read")]],
  ["315 variable actor", c(315, 0, 1, 2, 0, 1, 7, false), [r("variable", 2, "read"), r("variable", 7, "read")]],
  ["313 fixed actor with invalid actor id still writes the state", c(313, 0, 0, 0, 0, 7), [r("state", 7, "write")]],
  ["318 variable actor still writes the skill", c(318, 0, 1, 2, 0, 9), [r("variable", 2, "read"), r("skill", 9, "write")]],
  ["331 enemy HP, variable operand", c(331, 0, 0, 0, 1, 5, false), [r("variable", 5, "read")]],
  ["332 enemy MP, variable operand", c(332, 0, 0, 0, 1, 5), [r("variable", 5, "read")]],
  ["331 enemy HP, constant operand", c(331, 0, 0, 0, 0, 5, false), []],
  ["103 input number", c(103, 0, 4, 3), [r("variable", 4, "write")]],
  ["104 select item", c(104, 0, 4, 2), [r("variable", 4, "write")]],
  ["401 variable escape", c(401, 0, "You have \\V[12] gold"), [r("variable", 12, "read")]],
  ["401 duplicate escapes are deduplicated", c(401, 0, "\\V[3] \\v[4] \\V[3]"), [r("variable", 3, "read"), r("variable", 4, "read")]],
  ["401 ignores \\V[0] and \\V[x]", c(401, 0, "\\V[0] \\V[x] \\V[] \\V[99999999999]"), []],
  ["401 without escapes", c(401, 0, "plain"), []],
  ["405 variable escape", c(405, 0, "Scroll \\V[7]"), [r("variable", 7, "read")]],
  ["102 choices escapes", c(102, 0, ["\\V[1] a", "b \\V[2]", "\\V[1]", "none"], 1, 0, 2, 0), [r("variable", 1, "read"), r("variable", 2, "read")]],
  ["402 labels are skipped", c(402, 0, 0, "\\V[5]"), []],
  ["403 cancel branch is skipped", c(403, 0, 6, "\\V[5]"), []],
  ["505 route rows are skipped", c(505, 0, { code: 27, parameters: [4], indent: null }), []],
  ["205 route switch ON and OFF", c(205, 0, 0, route([27, [4]], [1, []], [28, [5]], [45, ["x"]])), [r("switch", 4, "write"), r("switch", 5, "write")]],
  ["205 route ignores bad switch ids", c(205, 0, 0, route([27, [0]], [28, ["x"]], [27, []], [27, [-1]])), []],
];

/** A move route object as MV stores it, terminated by the code-0 entry. */
function route(...entries) {
  return {
    list: [...entries.map(([code, parameters]) => ({ code, parameters, indent: null })), { code: 0, parameters: [] }],
    repeat: false,
    skippable: false,
    wait: true,
  };
}

for (const [name, command, expected] of ROWS) {
  test(`commandRefs: ${name}`, () => assert.deepEqual(commandRefs(command), expected));
}

test("commandRefs: ranges are capped at 1000 ids per command", () => {
  const refs = commandRefs(c(121, 0, 1, 1_000_000, 0));
  assert.equal(refs.length, 1000);
  assert.deepEqual(refs[0], r("switch", 1, "write"));
  assert.deepEqual(refs[999], r("switch", 1000, "write"));
  const vars = commandRefs(c(122, 0, 5, 1_000_000, 0, 0, 1));
  assert.equal(vars.length, 1000);
  assert.deepEqual(vars[999], r("variable", 1004, "write"));
});

test("commandRefs: a move route scans at most 1000 entries", () => {
  const entries = Array.from({ length: 1500 }, (_, i) => [27, [i + 1]]);
  const refs = commandRefs(c(205, 0, 0, route(...entries)));
  assert.equal(refs.length, 1000);
  assert.deepEqual(refs[999], r("switch", 1000, "write"));
});

test("commandRefs: malformed variants of the new rows never throw", () => {
  const bad = [
    c(201, 0, 1),
    c(201, 0, 1, "x", null, -1),
    c(202),
    c(202, 0, 0, 1),
    c(202, 0, 0, 1, "x", 0, 1e15),
    c(203, 0, 1, 1),
    c(125, 0, 0, 1),
    c(126, 0, 4, 0, 1),
    c(231, 0, 1, "p", 0, 1),
    c(285),
    c(285, 0, "x", 0, 1),
    c(301, 0, 1),
    c(311, 0, 1),
    c(311, 0, 0, 2, 0, 1),
    c(317, 0, 0, 2, 3, 0, 1),
    c(331, 0, 0, 0, 1),
    c(103),
    c(104, 0, "x"),
    c(401, 0),
    c(401, 0, 5),
    c(405, 0, null),
    c(102, 0),
    c(102, 0, "not an array"),
    c(102, 0, [null, 5, "\\V[3]"]),
    c(205),
    c(205, 0, 0),
    c(205, 0, 0, null),
    c(205, 0, 0, "route"),
    c(205, 0, 0, { list: "x" }),
    c(205, 0, 0, { list: [null, 5, "x", {}, { code: 27 }, { code: 27, parameters: "x" }, { code: 28, parameters: [null] }] }),
    { code: 205, indent: 0, parameters: null },
  ];
  for (const command of bad) assert.doesNotThrow(() => commandRefs(command));
  assert.deepEqual(commandRefs(c(201, 0, 1)), []);
  assert.deepEqual(commandRefs(c(201, 0, 1, "x", null, -1)), []);
  assert.deepEqual(commandRefs(c(202, 0, 0, 1, "x", 0, 1e15)), []);
  assert.deepEqual(commandRefs(c(205, 0, 0, { list: [null, 5, "x", {}, { code: 27 }, { code: 27, parameters: "x" }, { code: 28, parameters: [null] }] })), []);
  assert.deepEqual(commandRefs(c(102, 0, [null, 5, "\\V[3]"])), [r("variable", 3, "read")]);
  for (const command of bad) assert.doesNotThrow(() => hiddenKind(command));
});

test("commandRefs: an inverted range gives nothing", () => {
  assert.deepEqual(commandRefs(c(121, 0, 5, 3, 0)), []);
});

test("commandRefs: malformed commands never throw and give no refs", () => {
  const bad = [
    null,
    undefined,
    42,
    "x",
    [],
    {},
    { code: 111 },
    { code: 111, indent: 0, parameters: "oops" },
    { code: 117, indent: 0, parameters: null },
    c(111, 0),
    c(111, 0, 0, "x"),
    c(111, 0, 0, 0),
    c(111, 0, 0, -3),
    c(111, 0, 0, 1.5),
    c(111, 0, 1, 2, 1, "z"),
    c(117, 0, "4"),
    c(117, 0, null),
    c(117, 0, 0),
    c(117, 0, -1),
    c(117, 0, 1e15),
    c(117, 0, Number.MAX_SAFE_INTEGER),
    c(117, 0, NaN),
    c(121, 0, "a", "b", 0),
    c(121, 0, 0, 5, 0),
    c(121, 0, 1, 0, 0),
    c(121, 0, -2, 5, 0),
    c(121, 0, 1e15, 1e15 + 5, 0),
    c(122, 0, 1, "x", 0),
    c(126, 0, "x"),
    c(129, 0, 0),
    c(201, 0, 0, "x"),
    c(201, 0, 0, 0),
    c(301, 0, 0, -1),
    c(302, 0, 0, "x"),
    c(302, 0, "x", 4),
    c(313, 0, 0, 2),
    c(318, 0, 0),
    c(321, 0),
  ];
  for (const command of bad) {
    assert.doesNotThrow(() => commandRefs(command));
  }
  // Spot-checks: nothing is guessed from a bad id.
  assert.deepEqual(commandRefs(null), []);
  assert.deepEqual(commandRefs(c(111, 0, 0, "x")), []);
  assert.deepEqual(commandRefs(c(111, 0, 0, 0)), []);
  assert.deepEqual(commandRefs(c(111, 0, 0, -3)), []);
  assert.deepEqual(commandRefs(c(111, 0, 0, 1.5)), []);
  assert.deepEqual(commandRefs(c(117, 0, 1e15)), []);
  assert.deepEqual(commandRefs(c(121, 0, 0, 5, 0)), []);
  assert.deepEqual(commandRefs(c(121, 0, "a", "b", 0)), []);
  assert.deepEqual(commandRefs(c(121, 0, 1e15, 1e15 + 5, 0)), []);
  assert.deepEqual(commandRefs({ code: 117, indent: 0, parameters: null }), []);
  assert.deepEqual(commandRefs(c(111, 0, 1, 2, 1, "z")), [r("variable", 2, "read")]); // the valid half survives
  assert.deepEqual(commandRefs(c(313, 0, 0, 2)), [r("actor", 2, "use")]);
});

// ---- conditionRefs ----

test("conditionRefs: every valid flag yields a read, in a fixed order", () => {
  assert.deepEqual(
    conditionRefs({
      switch1Valid: true,
      switch1Id: 3,
      switch2Valid: true,
      switch2Id: 4,
      variableValid: true,
      variableId: 5,
      variableValue: 2,
      itemValid: true,
      itemId: 6,
      actorValid: true,
      actorId: 7,
      selfSwitchValid: true,
      selfSwitchCh: "A",
    }),
    [r("switch", 3, "read"), r("switch", 4, "read"), r("variable", 5, "read"), r("item", 6, "read"), r("actor", 7, "read")],
  );
});

test("conditionRefs: invalid flags and ids are ignored", () => {
  assert.deepEqual(
    conditionRefs({ switch1Valid: false, switch1Id: 3, switch2Valid: false, switch2Id: 4, variableValid: false, variableId: 5, itemValid: false, itemId: 6, actorValid: false, actorId: 7, selfSwitchValid: true, selfSwitchCh: "B" }),
    [],
  );
  assert.deepEqual(conditionRefs({ switch1Valid: true, switch1Id: 0, variableValid: true, variableId: "x", itemValid: true, itemId: -1, actorValid: true }), []);
  assert.deepEqual(conditionRefs({ switch1Valid: "yes", switch1Id: 3 }), []);
  assert.deepEqual(conditionRefs(undefined), []);
  assert.deepEqual(conditionRefs(null), []);
  assert.deepEqual(conditionRefs({}), []);
});

// ---- hiddenKind ----

test("hiddenKind classifies commands that cannot be resolved statically", () => {
  assert.equal(hiddenKind(c(355, 0, "$gameSwitches.setValue(1, true)")), "script");
  assert.equal(hiddenKind(c(655, 0, "more script")), null); // continuation row, not counted
  assert.equal(hiddenKind(c(356, 0, "Plugin arg")), "plugin");
  assert.equal(hiddenKind(c(201, 0, 1, 1, 2, 3, 2, 0)), "variableTransfer");
  assert.equal(hiddenKind(c(201, 0, 0, 1, 2, 3, 2, 0)), null);
  assert.equal(hiddenKind(c(301, 0, 1, 4, false, false)), "variableBattle");
  assert.equal(hiddenKind(c(301, 0, 2, 0, false, false)), "variableBattle");
  assert.equal(hiddenKind(c(301, 0, 0, 4, false, false)), null);
  assert.equal(hiddenKind(c(121, 0, 1, 1, 0)), null);
  assert.equal(hiddenKind(c(111, 0, 12, "a > b")), "script");
  assert.equal(hiddenKind(c(111, 0, 0, 1, 0)), null);
  assert.equal(hiddenKind(c(122, 0, 1, 1, 0, 4, "a + b")), "script");
  assert.equal(hiddenKind(c(122, 0, 1, 1, 0, 0, 4)), null);
  assert.equal(hiddenKind(c(205, 0, 0, route([45, ["this.jump()"]]))), "script");
  assert.equal(hiddenKind(c(205, 0, 0, route([27, [1]]))), null);
  assert.equal(hiddenKind(c(205, 0, 0, "bad")), null);
  assert.equal(hiddenKind(c(505, 0, { code: 45, parameters: ["x"] })), null);
  assert.equal(hiddenKind(null), null);
  assert.equal(hiddenKind({ code: 201 }), null);
  assert.equal(hiddenKind({ code: 301, indent: 0, parameters: "x" }), null);
});

// ---- buildProjectIndex ----

async function withFixture(spec, fn) {
  const fixture = await createFixtureProject(spec);
  try {
    await fn(fixture);
  } finally {
    await fixture.cleanup();
  }
}

const fullSpec = () => ({
  system: { startMapId: 2, partyMembers: [1, 3, 0] },
  maps: {
    1: {
      encounterList: [{ troopId: 2, weight: 5, regionSet: [] }, { troopId: 0, weight: 1, regionSet: [] }, null],
      events: [
        null,
        event(1, [
          page(
            [c(121, 0, 3, 4, 0), c(201, 0, 0, 5, 1, 1, 2, 0), c(201, 0, 1, 1, 2, 3, 2, 0), c(355, 0, "x"), c(655, 0, "y"), END],
            { conditions: { switch1Valid: true, switch1Id: 7, variableValid: true, variableId: 2 }, trigger: 3 },
          ),
          { conditions: {}, trigger: 0 }, // no list: skipped
          page([c(126, 0, 6, 0, 0, 1), END], { conditions: { itemValid: true, itemId: 4 } }),
        ]),
        null,
        event(3, [page([c(301, 0, 0, 3, false, false), c(301, 0, 1, 5, false, false), c(356, 0, "Plug"), END])]),
        "junk",
      ],
    },
    2: { events: [] },
    3: null, // no file
    4: "{broken",
    5: { events: [null] },
    6: { events: undefined }, // key dropped by JSON
  },
  commonEvents: [
    null,
    { id: 1, name: "Alarm", trigger: 2, switchId: 9, list: [c(117, 0, 2), c(122, 0, 1, 1, 0, 1, 8), END] },
    { id: 2, name: "Heal", trigger: 0, switchId: 9, list: [c(129, 0, 2, 0, 0), END] },
    "junk",
    { id: 4, name: "NoList" },
  ],
  troops: [
    null,
    {
      id: 1,
      name: "Slimes",
      members: [{ enemyId: 2, x: 0, y: 0 }, { enemyId: 0 }, null],
      pages: [
        { conditions: { switchValid: true, switchId: 11, actorValid: true, actorId: 3, turnValid: true, turnA: 0, turnB: 0, enemyValid: true, enemyIndex: 0 }, span: 0, list: [c(121, 0, 12, 12, 0), END] },
        { list: "nope" },
        7,
      ],
    },
  ],
  actors: [null, { id: 1, classId: 2, equips: [3, 0, 5, 0, 0] }],
  classes: [null, { id: 2, learnings: [{ level: 1, skillId: 6 }, { level: 2, skillId: 0 }] }],
  enemies: [
    null,
    {
      id: 4,
      dropItems: [{ kind: 1, dataId: 7, denominator: 1 }, { kind: 2, dataId: 8, denominator: 1 }, { kind: 3, dataId: 9, denominator: 1 }, { kind: 0, dataId: 10, denominator: 1 }],
      actions: [{ skillId: 1 }, { skillId: 11 }],
    },
  ],
  items: [
    null,
    { id: 1, effects: [{ code: 21, dataId: 5 }, { code: 22, dataId: 6 }, { code: 43, dataId: 12 }, { code: 44, dataId: 13 }, { code: 11, dataId: 99 }, { code: 21, dataId: 0 }] },
  ],
  skills: [null, { id: 2, effects: [{ code: 44, dataId: 14 }] }],
});

test("buildProjectIndex: system, maps and unreadable maps", async () => {
  await withFixture(fullSpec(), async ({ project }) => {
    const index = await buildProjectIndex(project);
    assert.equal(index.startMapId, 2);
    assert.deepEqual(index.partyMembers, [1, 3]);
    assert.deepEqual(index.mapIds, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(index.unreadableMaps, [3, 4]);
    assert.deepEqual(index.refs.filter((x) => x.where.source === "system"), [
      { ...r("map", 2, "use"), where: { source: "system", field: "startMapId" } },
      { ...r("actor", 1, "use"), where: { source: "system", field: "partyMembers", index: 0 } },
      { ...r("actor", 3, "use"), where: { source: "system", field: "partyMembers", index: 1 } },
    ]);
  });
});

test("buildProjectIndex: refs from map events and encounter lists carry exact locations", async () => {
  await withFixture(fullSpec(), async ({ project }) => {
    const index = await buildProjectIndex(project);
    const at = (eventId, pg, i) => ({ source: "map", mapId: 1, eventId, page: pg, ...(i === undefined ? {} : { index: i }) });
    assert.deepEqual(index.refs.filter((x) => x.where.source === "map"), [
      { ...r("troop", 2, "use"), where: { source: "map", mapId: 1, field: "encounterList" } },
      { ...r("switch", 7, "read"), where: at(1, 0) },
      { ...r("variable", 2, "read"), where: at(1, 0) },
      { ...r("switch", 3, "write"), where: at(1, 0, 0) },
      { ...r("switch", 4, "write"), where: at(1, 0, 0) },
      { ...r("map", 5, "use"), where: at(1, 0, 1) },
      { ...r("variable", 1, "read"), where: at(1, 0, 2) }, // 201 designated by variables
      { ...r("variable", 2, "read"), where: at(1, 0, 2) },
      { ...r("variable", 3, "read"), where: at(1, 0, 2) },
      { ...r("item", 4, "read"), where: at(1, 2) },
      { ...r("item", 6, "write"), where: at(1, 2, 0) },
      { ...r("troop", 3, "use"), where: at(3, 0, 0) },
      { ...r("variable", 5, "read"), where: at(3, 0, 1) }, // 301 designated by a variable
    ]);
    const mapPages = index.pages.filter((p) => p.kind === "map");
    assert.deepEqual(mapPages.map((p) => [p.mapId, p.eventId, p.page, p.trigger, p.name]), [
      [1, 1, 0, 3, "EV001"],
      [1, 1, 2, 0, "EV001"],
      [1, 3, 0, 0, "EV003"],
    ]);
    assert.equal(mapPages[0].conditions.switch1Id, 7);
    assert.equal(mapPages[0].list.length, 6);
  });
});

test("buildProjectIndex: common events (derived conditions) and troops (mapped conditions)", async () => {
  await withFixture(fullSpec(), async ({ project }) => {
    const index = await buildProjectIndex(project);
    assert.deepEqual(index.refs.filter((x) => x.where.source === "commonEvent"), [
      { ...r("switch", 9, "read"), where: { source: "commonEvent", eventId: 1 } },
      { ...r("commonEvent", 2, "use"), where: { source: "commonEvent", eventId: 1, index: 0 } },
      { ...r("variable", 1, "write"), where: { source: "commonEvent", eventId: 1, index: 1 } },
      { ...r("variable", 8, "read"), where: { source: "commonEvent", eventId: 1, index: 1 } },
      { ...r("actor", 2, "write"), where: { source: "commonEvent", eventId: 2, index: 0 } },
    ]);
    const ces = index.pages.filter((p) => p.kind === "commonEvent");
    assert.deepEqual(ces.map((p) => [p.eventId, p.page, p.trigger, p.name]), [
      [1, 0, 2, "Alarm"],
      [2, 0, 0, "Heal"],
    ]);
    assert.deepEqual(ces[0].conditions, { switch1Valid: true, switch1Id: 9 });
    assert.equal(ces[1].conditions, undefined); // trigger 0: only reachable through a 117

    assert.deepEqual(index.refs.filter((x) => x.where.source === "troop"), [
      { ...r("switch", 11, "read"), where: { source: "troop", eventId: 1, page: 0 } },
      { ...r("actor", 3, "read"), where: { source: "troop", eventId: 1, page: 0 } },
      { ...r("switch", 12, "write"), where: { source: "troop", eventId: 1, page: 0, index: 0 } },
    ]);
    const troopPages = index.pages.filter((p) => p.kind === "troop");
    assert.equal(troopPages.length, 1);
    assert.deepEqual(troopPages[0].conditions, { switch1Valid: true, switch1Id: 11, actorValid: true, actorId: 3 });
    assert.equal(troopPages[0].name, "Slimes");
  });
});

test("buildProjectIndex: every database row of the table", async () => {
  await withFixture(fullSpec(), async ({ project }) => {
    const index = await buildProjectIndex(project);
    const d = (table, recordId, field) => ({ source: "database", table, recordId, field });
    assert.deepEqual(index.refs.filter((x) => x.where.source === "database"), [
      { ...r("enemy", 2, "use"), where: d("Troops", 1, "members") },
      { ...r("class", 2, "use"), where: d("Actors", 1, "classId") },
      { ...r("weapon", 3, "use"), where: d("Actors", 1, "equips") },
      { ...r("armor", 5, "use"), where: d("Actors", 1, "equips") },
      { ...r("skill", 6, "use"), where: d("Classes", 2, "learnings") },
      { ...r("item", 7, "use"), where: d("Enemies", 4, "dropItems") },
      { ...r("weapon", 8, "use"), where: d("Enemies", 4, "dropItems") },
      { ...r("armor", 9, "use"), where: d("Enemies", 4, "dropItems") },
      { ...r("skill", 1, "use"), where: d("Enemies", 4, "actions") },
      { ...r("skill", 11, "use"), where: d("Enemies", 4, "actions") },
      { ...r("state", 5, "use"), where: d("Items", 1, "effects") },
      { ...r("state", 6, "use"), where: d("Items", 1, "effects") },
      { ...r("skill", 12, "use"), where: d("Items", 1, "effects") },
      { ...r("commonEvent", 13, "use"), where: d("Items", 1, "effects") },
      { ...r("commonEvent", 14, "use"), where: d("Skills", 2, "effects") },
    ]);
  });
});

test("buildProjectIndex: hidden counters cover all pages, 655 is not counted", async () => {
  await withFixture(fullSpec(), async ({ project }) => {
    const index = await buildProjectIndex(project);
    assert.deepEqual(index.hidden, { scriptCommands: 1, pluginCommands: 1, variableTransfers: 1, variableBattles: 1, truncatedRanges: 0, enabledPlugins: 0, enabledPluginNames: [] });
  });
});

test("buildProjectIndex: hidden commands on an unreachable map and in common events and troops still count", async () => {
  await withFixture(
    {
      maps: { 1: {}, 9: { events: [null, event(1, [page([c(355, 0, "a"), c(356, 0, "b"), END])])] } },
      commonEvents: [null, { id: 1, trigger: 0, switchId: 0, list: [c(355, 0, "a"), END] }],
      troops: [null, { id: 1, members: [], pages: [{ conditions: {}, span: 0, list: [c(356, 0, "p"), END] }] }],
    },
    async ({ project }) => {
      const index = await buildProjectIndex(project);
      assert.deepEqual(index.hidden, { scriptCommands: 2, pluginCommands: 2, variableTransfers: 0, variableBattles: 0, truncatedRanges: 0, enabledPlugins: 0, enabledPluginNames: [] });
    },
  );
});

test("buildProjectIndex: defaults for an empty project", async () => {
  await withFixture({}, async ({ project }) => {
    const index = await buildProjectIndex(project);
    assert.equal(index.startMapId, 1);
    assert.deepEqual(index.partyMembers, [1]);
    assert.deepEqual(index.mapIds, [1]);
    assert.deepEqual(index.unreadableMaps, []);
    assert.deepEqual(index.pages, []);
    assert.deepEqual(index.refs.map((x) => x.kind), ["map", "actor"]);
  });
});

test("buildProjectIndex: missing, unreadable or malformed optional files are skipped", async () => {
  await withFixture({ items: [null, { id: 1, effects: [{ code: 44, dataId: 3 }] }] }, async ({ project, root }) => {
    await fs.rm(path.join(root, "data", "Troops.json"));
    await fs.rm(path.join(root, "data", "Classes.json"));
    await fs.rm(path.join(root, "data", "CommonEvents.json"));
    await fs.writeFile(path.join(root, "data", "Enemies.json"), "{not json", "utf8");
    await fs.writeFile(path.join(root, "data", "Actors.json"), JSON.stringify({ not: "an array" }), "utf8");
    await fs.writeFile(path.join(root, "data", "Skills.json"), JSON.stringify([null, 5, "x", { id: 2, effects: "no" }]), "utf8");
    const index = await buildProjectIndex(project);
    assert.deepEqual(index.refs.filter((x) => x.where.source === "database").map((x) => [x.kind, x.id]), [["commonEvent", 3]]);
    assert.deepEqual(index.pages, []);
  });
});

test("buildProjectIndex: a missing or invalid System.json and MapInfos.json is tolerated", async () => {
  await withFixture({}, async ({ project, root }) => {
    await fs.rm(path.join(root, "data", "System.json"));
    await fs.writeFile(path.join(root, "data", "MapInfos.json"), "[null, 3, {\"id\": \"x\"}, {\"id\": 1}]", "utf8");
    const index = await buildProjectIndex(project);
    assert.equal(index.startMapId, 0);
    assert.deepEqual(index.partyMembers, []);
    assert.deepEqual(index.mapIds, [1]);
    assert.deepEqual(index.refs, []);
  });
});

test("buildProjectIndex: map file that is not an object is unreadable", async () => {
  await withFixture({ maps: { 1: "[1,2]", 2: "null", 3: {} } }, async ({ project }) => {
    const index = await buildProjectIndex(project);
    assert.deepEqual(index.unreadableMaps, [1, 2]);
  });
});

test("buildProjectIndex: events null, empty or missing and pages without list are skipped", async () => {
  await withFixture(
    { maps: { 1: { events: [null] }, 2: { events: [] }, 3: { events: undefined }, 4: { events: [null, { id: 1, pages: [{}, { list: null }, null, 3] }, { id: 2 }, { id: 3, pages: "x" }] } } },
    async ({ project }) => {
      const index = await buildProjectIndex(project);
      assert.deepEqual(index.pages, []);
      assert.deepEqual(index.unreadableMaps, []);
    },
  );
});

test("buildProjectIndex: malformed commands inside a list neither throw nor produce refs", async () => {
  await withFixture(
    { maps: { 1: { events: [null, event(1, [page([null, { code: 121 }, c(121, 0, "x", "y", 0), c(117, 0, 0), 5, c(121, 0, 2, 2, 0), END])])] } } },
    async ({ project }) => {
      const index = await buildProjectIndex(project);
      assert.deepEqual(index.refs.filter((x) => x.where.source === "map"), [
        { ...r("switch", 2, "write"), where: { source: "map", mapId: 1, eventId: 1, page: 0, index: 5 } },
      ]);
    },
  );
});

test("buildProjectIndex: rejects before a project is selected", async () => {
  await assert.rejects(() => buildProjectIndex(new Project()), /No project selected/);
});

test("buildProjectIndex: sees staged changeset content", async () => {
  await withFixture({ items: [null, { id: 1, effects: [] }] }, async ({ project, root }) => {
    assert.deepEqual((await buildProjectIndex(project)).refs.filter((x) => x.where.source === "database"), []);
    project.beginChangeset("stage");
    await project.writeJson(project.dataFile("Items.json"), [null, { id: 1, effects: [{ code: 44, dataId: 4 }] }]);
    await project.writeJson(project.mapFile(1), { width: 17, height: 13, encounterList: [], events: [null, event(1, [page([c(121, 0, 9, 9, 0), END])])] });
    const staged = await buildProjectIndex(project);
    assert.deepEqual(staged.refs.filter((x) => x.where.source === "database").map((x) => [x.kind, x.id]), [["commonEvent", 4]]);
    assert.deepEqual(staged.refs.filter((x) => x.where.source === "map").map((x) => [x.kind, x.id, x.role]), [["switch", 9, "write"]]);
    // Disk is untouched while the changeset is open.
    const onDisk = JSON.parse(await fs.readFile(path.join(root, "data", "Items.json"), "utf8"));
    assert.deepEqual(onDisk[1].effects, []);
    project.discardChangeset();
  });
});

test("buildProjectIndex: script-like commands and route scripts count as hidden scripts, once per route command", async () => {
  const commands = [
    c(111, 0, 12, "a > b"),
    c(122, 0, 1, 1, 0, 4, "1 + 1"),
    c(205, 0, 0, route([45, ["a()"]], [27, [3]], [45, ["b()"]])),
    c(505, 0, { code: 45, parameters: ["a()"], indent: null }),
    c(355, 0, "x"),
    END,
  ];
  await withFixture({ maps: { 1: { events: [null, event(1, [page(commands)])] } } }, async ({ project }) => {
    const index = await buildProjectIndex(project);
    assert.deepEqual(index.hidden, { scriptCommands: 5, pluginCommands: 0, variableTransfers: 0, variableBattles: 0, truncatedRanges: 0, enabledPlugins: 0, enabledPluginNames: [] });
    assert.deepEqual(index.refs.filter((x) => x.where.source === "map").map((x) => [x.kind, x.id, x.role, x.where.index]), [
      ["variable", 1, "write", 1],
      ["switch", 3, "write", 2],
    ]);
  });
});

test("buildProjectIndex: truncated 121/122 ranges are counted", async () => {
  const commands = [c(121, 0, 1, 5000, 0), c(122, 0, 1, 1001, 0, 0, 1), c(122, 0, 1, 1000, 0, 0, 1), c(121, 0, 5, 3, 0), c(121, 0, 1, 1e15, 0), END];
  await withFixture({ maps: { 1: { events: [null, event(1, [page(commands)])] } } }, async ({ project }) => {
    const index = await buildProjectIndex(project);
    assert.equal(index.hidden.truncatedRanges, 2); // 1..1e15 is not a valid range (huge id): not counted
    assert.equal(index.refs.filter((x) => x.kind === "switch").length, 1000);
    assert.equal(index.refs.filter((x) => x.kind === "variable").length, 2000);
  });
});

test("buildProjectIndex: new command rows carry their locations", async () => {
  const commands = [c(103, 0, 4, 3), c(401, 0, "\\V[12]"), c(285, 0, 6, 0, 1, 7, 8), END];
  await withFixture({ maps: { 1: { events: [null, event(1, [page(commands)])] } } }, async ({ project }) => {
    const index = await buildProjectIndex(project);
    const w = (i) => ({ source: "map", mapId: 1, eventId: 1, page: 0, index: i });
    assert.deepEqual(index.refs.filter((x) => x.where.source === "map"), [
      { ...r("variable", 4, "write"), where: w(0) },
      { ...r("variable", 12, "read"), where: w(1) },
      { ...r("variable", 6, "write"), where: w(2) },
      { ...r("variable", 7, "read"), where: w(2) },
      { ...r("variable", 8, "read"), where: w(2) },
    ]);
  });
});

test("buildProjectIndex: 5 000 events x 20 commands index quickly", async () => {
  const list = [];
  for (let i = 0; i < 19; i++) {
    list.push(i % 4 === 0 ? c(111, 0, 0, (i % 50) + 1, 0) : i % 4 === 1 ? c(121, 0, i + 1, i + 3, 0) : i % 4 === 2 ? c(401, 0, "Some dialogue text") : c(126, 0, i + 1, 0, 0, 1));
  }
  list.push(END);
  assert.equal(list.length, 20);
  const events = [null];
  for (let e = 1; e <= 5000; e++) events.push(event(e, [page(list, { conditions: { switch1Valid: true, switch1Id: (e % 100) + 1 } })]));
  await withFixture({ maps: { 1: { events } } }, async ({ project }) => {
    const start = performance.now();
    const index = await buildProjectIndex(project);
    const elapsed = performance.now() - start;
    assert.equal(index.pages.length, 5000);
    assert.ok(index.refs.length > 5000 * 5);
    // The design target is 2 000 ms; 5 000 ms leaves headroom for slow CI runners.
    assert.ok(elapsed < 5000, `indexing took ${elapsed.toFixed(0)} ms`);
  });
});

// ---- autonomous move routes (map pages with moveType 3) ----

test("buildProjectIndex: an autonomous move route (moveType 3) adds switch writes and counts route scripts", async () => {
  const autonomous = route([27, [5]], [28, [6]], [45, ["x()"]], [27, [0]], [27, ["7"]], [1, []]);
  const spec = {
    maps: {
      1: {
        events: [
          null,
          event(1, [page([END], { moveType: 3, moveRoute: autonomous })]),
          event(2, [page([END], { moveType: 0, moveRoute: route([27, [8]], [45, ["y()"]]) })]),
        ],
      },
    },
  };
  await withFixture(spec, async ({ project }) => {
    const index = await buildProjectIndex(project);
    const where = { source: "map", mapId: 1, eventId: 1, page: 0, field: "moveRoute" };
    assert.deepEqual(index.refs.filter((x) => x.where.source === "map"), [
      { ...r("switch", 5, "write"), where },
      { ...r("switch", 6, "write"), where },
    ]);
    assert.equal(index.hidden.scriptCommands, 1, "only the moveType 3 route's script counts");
    assert.deepEqual(index.pages[0].moveRoute.map((e) => e.code), [27, 28, 45, 27, 27, 1, 0]);
    assert.equal(index.pages[1].moveRoute, undefined, "moveType 0 routes are not kept");
  });
});

test("buildProjectIndex: an autonomous route is scanned up to 1000 entries; a malformed route is ignored", async () => {
  const long = route(...Array.from({ length: 1000 }, () => [1, []]), [27, [9]]);
  const spec = {
    maps: {
      1: {
        events: [
          null,
          event(1, [page([END], { moveType: 3, moveRoute: long })]),
          event(2, [page([END], { moveType: 3, moveRoute: "bad" }), page([END], { moveType: 3, moveRoute: { list: 5 } }), page([END], { moveType: 3 })]),
        ],
      },
    },
  };
  await withFixture(spec, async ({ project }) => {
    const index = await buildProjectIndex(project);
    assert.deepEqual(index.refs.filter((x) => x.where.source === "map"), []);
    assert.equal(index.pages[0].moveRoute.length, 1000);
  });
});

// ---- enabled plugins (js/plugins.js) ----

const pluginsJs = (entries) => `// Generated by RPG Maker.\nvar $plugins =\n${JSON.stringify(entries)};\n`;
const plugin = (name, status) => ({ name, status, description: "", parameters: {} });

async function hiddenWithPlugins(text) {
  let hidden;
  await withFixture({}, async ({ project, root }) => {
    if (text !== undefined) {
      await fs.mkdir(path.join(root, "js"), { recursive: true });
      await fs.writeFile(path.join(root, "js", "plugins.js"), text, "utf8");
    }
    hidden = (await buildProjectIndex(project)).hidden;
  });
  return hidden;
}

test("buildProjectIndex: enabled plugins are counted (Community_Basic and disabled ones excluded); a bad plugins.js counts 0", async () => {
  for (const text of [undefined, "garbage", "var $plugins = [ {not json ];", pluginsJs([plugin("Community_Basic", true)]), pluginsJs(["x", null, 3])]) {
    const hidden = await hiddenWithPlugins(text);
    assert.equal(hidden.enabledPlugins, 0, String(text));
    assert.deepEqual(hidden.enabledPluginNames, []);
  }
  const two = await hiddenWithPlugins(pluginsJs([plugin("Community_Basic", true), plugin("YEP_Core", true), plugin("Off", false), plugin("MyQuest", true)]));
  assert.equal(two.enabledPlugins, 2);
  assert.deepEqual(two.enabledPluginNames, ["YEP_Core", "MyQuest"]);
  const many = await hiddenWithPlugins(pluginsJs(Array.from({ length: 12 }, (_, i) => plugin(`P${i + 1}`, true))));
  assert.equal(many.enabledPlugins, 12);
  assert.deepEqual(many.enabledPluginNames, Array.from({ length: 10 }, (_, i) => `P${i + 1}`));
});

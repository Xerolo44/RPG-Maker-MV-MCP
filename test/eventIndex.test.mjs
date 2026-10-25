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
  ["201 variable designation", c(201, 0, 1, 3, 5, 6, 2, 0), []],
  ["301 direct", c(301, 0, 0, 4, false, false), [r("troop", 4, "use")]],
  ["301 variable designation", c(301, 0, 1, 4, false, false), []],
  ["301 same as random encounter", c(301, 0, 2, 4, false, false), []],
  ["302 item", c(302, 0, 0, 5, 0, 100, false), [r("item", 5, "use")]],
  ["302 weapon", c(302, 0, 1, 5, 0, 100, false), [r("weapon", 5, "use")]],
  ["302 armor", c(302, 0, 2, 5, 0, 100, false), [r("armor", 5, "use")]],
  ["605 item", c(605, 0, 0, 6, 0, 100, false), [r("item", 6, "use")]],
  ["605 armor", c(605, 0, 2, 6, 0, 100, false), [r("armor", 6, "use")]],
  ["302 unknown goods type", c(302, 0, 3, 5, 0, 100, false), []],
  ["311 change HP", c(311, 0, 0, 2, 0, 0, 10, false), [r("actor", 2, "use")]],
  ["311 variable actor", c(311, 0, 1, 2, 0, 0, 10, false), []],
  ["312 change MP", c(312, 0, 0, 2, 0, 0, 10), [r("actor", 2, "use")]],
  ["313 change state", c(313, 0, 0, 2, 0, 7), [r("actor", 2, "use"), r("state", 7, "write")]],
  ["313 variable actor", c(313, 0, 1, 2, 0, 7), []],
  ["315 change EXP", c(315, 0, 0, 2, 0, 0, 10, false), [r("actor", 2, "use")]],
  ["316 change level", c(316, 0, 0, 2, 0, 0, 1, false), [r("actor", 2, "use")]],
  ["317 change parameter", c(317, 0, 0, 2, 0, 0, 0, 5), [r("actor", 2, "use")]],
  ["318 change skill", c(318, 0, 0, 2, 0, 9), [r("actor", 2, "use"), r("skill", 9, "write")]],
  ["321 change class", c(321, 0, 2, 3, true), [r("actor", 2, "use"), r("class", 3, "use")]],
  ["322 change actor graphic", c(322, 0, 2, "Actor1", 0), [r("actor", 2, "use")]],
  ["303 name input", c(303, 0, 2, 8), [r("actor", 2, "use")]],
  ["a command with no references", c(101, 0, "", 0, 0, 2), []],
  ["the list terminator", END, []],
];

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
      { ...r("item", 4, "read"), where: at(1, 2) },
      { ...r("item", 6, "write"), where: at(1, 2, 0) },
      { ...r("troop", 3, "use"), where: at(3, 0, 0) },
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
    assert.deepEqual(index.hidden, { scriptCommands: 1, pluginCommands: 1, variableTransfers: 1, variableBattles: 1 });
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
      assert.deepEqual(index.hidden, { scriptCommands: 2, pluginCommands: 2, variableTransfers: 0, variableBattles: 0 });
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

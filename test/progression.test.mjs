import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectIndex } from "../dist/eventIndex.js";
import { analyzeProgression } from "../dist/progression.js";
import { mulberry32 } from "../dist/battle.js";
import { c, END, createFixtureProject, event, page } from "./helpers/fixtureProject.mjs";

/** Builds a fixture project on disk, indexes it and returns { index, report } for the given options. */
async function run(spec, opts = {}) {
  const { project, cleanup } = await createFixtureProject(spec);
  try {
    const index = await buildProjectIndex(project);
    return { index, report: analyzeProgression(index, { limit: 1000, ...opts }) };
  } finally {
    await cleanup();
  }
}

/** An in-memory stand-in for Project (only what buildProjectIndex touches): fast for big or many projects. */
function memoryProject(spec) {
  const files = new Map();
  const maps = spec.maps ?? { 1: {} };
  files.set("System.json", { startMapId: 1, partyMembers: [1], switches: [""], variables: [""], ...(spec.system ?? {}) });
  files.set("MapInfos.json", [null, ...Object.keys(maps).map(Number).sort((a, b) => a - b).map((id) => ({ id, name: `Map${id}` }))]);
  for (const [id, value] of Object.entries(maps)) {
    files.set(`Map${String(id).padStart(3, "0")}.json`, { width: 17, height: 13, encounterList: [], events: [null], ...value });
  }
  const tables = { commonEvents: "CommonEvents", troops: "Troops", enemies: "Enemies", items: "Items", skills: "Skills" };
  for (const [key, name] of Object.entries(tables)) files.set(`${name}.json`, spec[key] ?? [null]);
  return {
    root: "memory",
    dataFile: (name) => name,
    mapFile: (id) => `Map${String(id).padStart(3, "0")}.json`,
    readJson: async (name) => {
      if (!files.has(name)) throw new Error(`missing ${name}`);
      return files.get(name);
    },
  };
}

const sw = (id) => ({ switch1Valid: true, switch1Id: id });
const transfer = (mapId) => c(201, 0, 0, mapId, 1, 1, 0, 0);
const switchOn = (id, end = id) => c(121, 0, id, end, 0);
const switchOff = (id) => c(121, 0, id, id, 1);
const door = (id, to, conditions = {}) => event(id, [page([transfer(to), END], { conditions })]);
const npc = (id, list) => event(id, [page([...list, END])]);
const ce = (id, list, extra = {}) => ({ id, name: `CE${id}`, trigger: 0, switchId: 1, list: [...list, END], ...extra });
const troop = (id, pages) => ({ id, name: `Troop${id}`, members: [], pages });
const troopPage = (list, conditions = {}) => ({
  conditions: { actorHp: 50, actorId: 1, actorValid: false, enemyHp: 50, enemyIndex: 0, enemyValid: false, switchId: 1, switchValid: false, turnA: 0, turnB: 0, turnEnding: false, turnValid: false, ...conditions },
  list: [...list, END],
  span: 0,
});

// ---- the door / switch basics ----

test("a door gated by switch 5 opens when an NPC on the start map sets it", async () => {
  const { report } = await run({ maps: { 1: { events: [null, npc(1, [switchOn(5)]), door(2, 2, sw(5))] }, 2: {} } });
  assert.equal(report.startMapId, 1);
  assert.deepEqual(report.reachableMaps, [1, 2]);
  assert.deepEqual(report.unreachableMaps, []);
  assert.deepEqual(report.edges, [{ from: 1, to: 2 }]);
  assert.deepEqual(report.deadPages, []);
  assert.deepEqual(report.deadEndMaps, [2]);
  assert.equal(report.uncertainty.confidence, "high");
  assert.equal(report.truncated, false);
});

test("without the NPC (or when it only switches 5 OFF) map 2 is unreachable and the goal names switch 5", async () => {
  for (const npcList of [[], [switchOff(5)]]) {
    const { report } = await run(
      { maps: { 1: { events: [null, npc(1, npcList), door(2, 2, sw(5))] }, 2: {} } },
      { goal: { mapId: 2 } },
    );
    assert.deepEqual(report.reachableMaps, [1]);
    assert.deepEqual(report.unreachableMaps, [2]);
    assert.deepEqual(report.edges, []);
    assert.deepEqual(report.deadPages, [
      { kind: "map", mapId: 1, eventId: 2, page: 0, reason: "switch 5 is never switched ON by any reachable event" },
    ]);
    assert.deepEqual(report.goal, {
      target: "map 2",
      reachable: false,
      blockedBy: ["Map001 event 2 page 1: switch 5 is never switched ON by any reachable event"],
    });
  }
});

test("a chain of three switches across maps; breaking the middle link cuts off the rest", async () => {
  const chain = (withSecond) => ({
    maps: {
      1: { events: [null, npc(1, [switchOn(1)]), door(2, 2, sw(1))] },
      2: { events: [null, npc(1, withSecond ? [switchOn(2)] : []), door(2, 3, sw(2))] },
      3: { events: [null, npc(1, [switchOn(3)]), door(2, 4, sw(3))] },
      4: {},
    },
  });
  const ok = (await run(chain(true), { goal: { mapId: 4 } })).report;
  assert.deepEqual(ok.reachableMaps, [1, 2, 3, 4]);
  assert.deepEqual(ok.goal, { target: "map 4", reachable: true, blockedBy: [] });
  assert.deepEqual(ok.edges, [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 4 }]);

  const broken = (await run(chain(false), { goal: { mapId: 4 } })).report;
  assert.deepEqual(broken.reachableMaps, [1, 2]);
  assert.deepEqual(broken.unreachableMaps, [3, 4]);
  assert.deepEqual(broken.goal.blockedBy, ["Map003 event 2 page 1: map 3 is unreachable"]);
  // pages on unreachable maps are not listed as dead (the map itself is reported)
  assert.deepEqual(broken.deadPages.map((p) => p.mapId), [2]);
});

test("an item gate opens through a chest (126 gain) or a shop (302) but not through nothing or a 126 loss", async () => {
  const gate = (giver) => ({ maps: { 1: { events: [null, npc(1, giver), door(2, 2, { itemValid: true, itemId: 5 })] }, 2: {} } });
  assert.deepEqual((await run(gate([c(126, 0, 5, 0, 0, 1)]))).report.reachableMaps, [1, 2]);
  assert.deepEqual((await run(gate([c(302, 0, 0, 5, 0, 0, false)]))).report.reachableMaps, [1, 2]);
  assert.deepEqual((await run(gate([c(605, 0, 1, 2, 0, 0), c(302, 0, 1, 3, 0, 0, false), c(605, 0, 0, 5, 0, 0)]))).report.reachableMaps, [1, 2]);
  for (const nothing of [[], [c(126, 0, 5, 1, 0, 1)], [c(127, 0, 5, 0, 0, 1, false)]]) {
    const { report } = await run(gate(nothing));
    assert.deepEqual(report.reachableMaps, [1]);
    assert.equal(report.deadPages[0].reason, "item 5 can never be obtained");
  }
});

test("enemy drops make an item gainable even when no battle uses the enemy", async () => {
  const { report } = await run({
    maps: { 1: { events: [null, door(1, 2, { itemValid: true, itemId: 4 })] }, 2: {} },
    enemies: [null, { id: 1, name: "Slime", actions: [], dropItems: [{ kind: 1, dataId: 4, denominator: 2 }, { kind: 0, dataId: 9, denominator: 1 }] }],
  });
  assert.deepEqual(report.reachableMaps, [1, 2]);
});

test("a variable gate >= 3 opens only when some reachable page writes the variable; >= 0 is always open", async () => {
  const gate = (writer, value = 3) => ({
    maps: { 1: { events: [null, npc(1, writer), door(2, 2, { variableValid: true, variableId: 2, variableValue: value })] }, 2: {} },
  });
  const closed = (await run(gate([]))).report;
  assert.deepEqual(closed.reachableMaps, [1]);
  assert.equal(closed.deadPages[0].reason, "variable 2 is never set by any reachable event, so it stays 0 (the page needs >= 3)");
  assert.deepEqual((await run(gate([c(122, 0, 2, 2, 0, 0, 3)]))).report.reachableMaps, [1, 2]);
  assert.deepEqual((await run(gate([c(122, 0, 1, 4, 1, 0, 1)]))).report.reachableMaps, [1, 2], "range write");
  assert.deepEqual((await run(gate([c(103, 0, 2, 1)]))).report.reachableMaps, [1, 2], "input number writes it");
  assert.deepEqual((await run(gate([], 0))).report.reachableMaps, [1, 2], "0 >= 0 holds from the start");
});

test("self-switch chest: page 2 needs self switch A, set only by page 1 of the same event", async () => {
  const chest = (pageOne, other = []) => ({
    maps: {
      1: {
        events: [
          null,
          event(1, [page([c(126, 0, 1, 0, 0, 1), ...pageOne, END]), page([transfer(2), END], { conditions: { selfSwitchValid: true, selfSwitchCh: "A" } })]),
          npc(2, other),
        ],
      },
      2: {},
    },
  });
  assert.deepEqual((await run(chest([c(123, 0, "A", 0)]))).report.reachableMaps, [1, 2]);
  for (const [pageOne, other] of [[[], []], [[c(123, 0, "A", 1)], []], [[c(123, 0, "B", 0)], []], [[], [c(123, 0, "A", 0)]]]) {
    const { report } = await run(chest(pageOne, other));
    assert.deepEqual(report.reachableMaps, [1]);
    assert.deepEqual(report.deadPages, [
      { kind: "map", mapId: 1, eventId: 1, page: 1, reason: "self switch A of this event is never switched ON by a reachable page" },
    ]);
  }
});

test("an actor condition holds for starting party members and actors added by 129 (not removed ones)", async () => {
  const gate = (list) => ({ maps: { 1: { events: [null, npc(1, list), door(2, 2, { actorValid: true, actorId: 3 })] }, 2: {} } });
  assert.deepEqual((await run({ ...gate([]), system: { partyMembers: [1, 3] } })).report.reachableMaps, [1, 2]);
  assert.deepEqual((await run(gate([c(129, 0, 3, 0, false)]))).report.reachableMaps, [1, 2]);
  const removed = (await run(gate([c(129, 0, 3, 1, false)]))).report;
  assert.deepEqual(removed.reachableMaps, [1]);
  assert.equal(removed.deadPages[0].reason, "actor 3 never joins the party");
});

// ---- common events ----

test("a common event that sets a switch counts only when a reachable page calls it", async () => {
  const spec = (callerMap) => ({
    maps: { 1: { events: [null, npc(1, callerMap === 1 ? [c(117, 0, 1)] : [])] }, 2: { events: [null, npc(1, [c(117, 0, 1)])] } },
    commonEvents: [null, ce(1, [switchOn(7)])],
  });
  const far = (await run(spec(2), { goal: { switch: 7 } })).report;
  assert.deepEqual(far.goal, {
    target: "switch 7",
    reachable: false,
    blockedBy: ["CommonEvent 1: common event 1 is never called by a reachable event"],
  });
  assert.deepEqual(far.deadPages, [{ kind: "commonEvent", eventId: 1, page: 0, reason: "common event 1 is never called by a reachable event" }]);
  const near = (await run(spec(1), { goal: { switch: 7 } })).report;
  assert.deepEqual(near.goal, { target: "switch 7", reachable: true, blockedBy: [] });
  assert.deepEqual(near.deadPages, []);
});

test("a parallel common event gated by a switch runs once the switch can be ON; autorun without a switch always runs", async () => {
  const spec = (setter) => ({
    maps: { 1: { events: [null, npc(1, setter)] } },
    commonEvents: [null, ce(1, [switchOn(4)], { trigger: 2, switchId: 3 }), ce(2, [switchOn(6)], { trigger: 1, switchId: 0 })],
  });
  const on = (await run(spec([switchOn(3)]), { goal: { switch: 4 } })).report;
  assert.equal(on.goal.reachable, true);
  assert.deepEqual(on.deadPages, []);
  const off = (await run(spec([]), { goal: { switch: 4 } })).report;
  assert.equal(off.goal.reachable, false);
  assert.deepEqual(off.deadPages, [
    {
      kind: "commonEvent",
      eventId: 1,
      page: 0,
      reason: "common event 1 is never called by a reachable event and its trigger switch 3 is never switched ON by any reachable event",
    },
  ]);
  assert.equal((await run(spec([]), { goal: { switch: 6 } })).report.goal.reachable, true);
});

test("a common event's 123 sets the self switch of the map event that called it, also through nested calls", async () => {
  const chest = (callList, ces) => ({
    maps: {
      1: {
        events: [
          null,
          event(1, [page([...callList, END]), page([transfer(2), END], { conditions: { selfSwitchValid: true, selfSwitchCh: "A" } })]),
          event(2, [page([END]), page([transfer(3), END], { conditions: { selfSwitchValid: true, selfSwitchCh: "A" } })]),
        ],
      },
      2: {},
      3: {},
    },
    commonEvents: ces,
  });
  const direct = (await run(chest([c(117, 0, 1)], [null, ce(1, [c(123, 0, "A", 0)])]))).report;
  assert.deepEqual(direct.reachableMaps, [1, 2], "event 1 gets A; event 2 (not a caller) does not");
  const nested = (await run(chest([c(117, 0, 1)], [null, ce(1, [c(117, 0, 2)]), ce(2, [c(123, 0, "A", 0)])]))).report;
  assert.deepEqual(nested.reachableMaps, [1, 2]);
  const loop = (await run(chest([c(117, 0, 1)], [null, ce(1, [c(117, 0, 2)]), ce(2, [c(117, 0, 1), c(123, 0, "A", 0)])]))).report;
  assert.deepEqual(loop.reachableMaps, [1, 2], "recursive calls terminate");
  // an autorun common event has no calling map event, so its 123 sets nobody's self switch
  const autorun = (await run(chest([], [null, ce(1, [c(123, 0, "A", 0)], { trigger: 1, switchId: 0 })]))).report;
  assert.deepEqual(autorun.reachableMaps, [1]);
});

test("common events named by item effects run when the item is gainable; by skill effects always", async () => {
  const spec = (giver) => ({
    maps: { 1: { events: [null, npc(1, giver)] } },
    commonEvents: [null, ce(1, [switchOn(8)]), ce(2, [switchOn(9)])],
    items: [null, null, null, { id: 3, name: "Horn", effects: [{ code: 44, dataId: 1, value1: 0, value2: 0 }] }],
    skills: [null, { id: 1, name: "Call", effects: [{ code: 44, dataId: 2, value1: 0, value2: 0 }] }],
  });
  assert.equal((await run(spec([c(126, 0, 3, 0, 0, 1)]), { goal: { switch: 8 } })).report.goal.reachable, true);
  assert.equal((await run(spec([]), { goal: { switch: 8 } })).report.goal.reachable, false);
  assert.equal((await run(spec([]), { goal: { switch: 9 } })).report.goal.reachable, true);
});

// ---- troops ----

test("troop pages run when the troop is fought (reachable encounter or direct battle) and their switch condition holds", async () => {
  const { report } = await run({
    maps: {
      1: { encounterList: [{ troopId: 1, regionSet: [], weight: 10 }], events: [null, npc(1, [c(301, 0, 0, 3, false, false)])] },
      2: { encounterList: [{ troopId: 4, regionSet: [], weight: 10 }] },
    },
    troops: [
      null,
      troop(1, [troopPage([switchOn(6)], { turnEnding: true }), troopPage([switchOn(7)], { switchValid: true, switchId: 9 }), troopPage([])]),
      troop(2, [troopPage([switchOn(8)], { turnEnding: true })]),
      troop(3, [troopPage([transfer(2)], { turnValid: true, turnA: 1 })]),
      troop(4, [troopPage([switchOn(10)], { turnEnding: true })]),
    ],
  });
  assert.deepEqual(report.reachableMaps, [1, 2], "a 201 in a battle event page adds its target");
  assert.deepEqual(report.edges, [], "but draws no edge");
  assert.deepEqual(report.deadPages, [
    { kind: "troop", eventId: 1, page: 1, reason: "switch 9 is never switched ON by any reachable event" },
    {
      kind: "troop",
      eventId: 2,
      page: 0,
      reason: "troop 2 is never fought: no reachable map encounters it and no reachable event starts a battle with it",
    },
  ]);
});

test("a troop page's actor condition is not a party check (MV only tests the actor's HP), so it is not required", async () => {
  const { report } = await run(
    {
      maps: { 1: { encounterList: [{ troopId: 1, regionSet: [], weight: 10 }] } },
      troops: [null, troop(1, [troopPage([switchOn(2)], { actorValid: true, actorId: 7, actorHp: 100 })])],
    },
    { goal: { switch: 2 } },
  );
  assert.equal(report.goal.reachable, true);
});

// ---- map graph ----

test("cyclic maps terminate and every distinct direct transfer is one edge", async () => {
  const { report } = await run({
    maps: {
      1: { events: [null, door(1, 2), door(2, 2)] },
      2: { events: [null, door(1, 1), door(2, 2)] },
      3: { events: [null, door(1, 1)] },
    },
  });
  assert.deepEqual(report.reachableMaps, [1, 2]);
  assert.deepEqual(report.unreachableMaps, [3]);
  assert.deepEqual(report.edges, [{ from: 1, to: 2 }, { from: 2, to: 1 }, { from: 2, to: 2 }]);
  assert.deepEqual(report.deadEndMaps, []);
});

test("dead ends: maps left only through a common event or a variable transfer are not dead ends", async () => {
  const { report } = await run({
    maps: {
      1: { events: [null, door(1, 2), door(2, 3), door(3, 4), door(4, 5)] },
      2: {},
      3: { events: [null, npc(1, [c(117, 0, 1)])] },
      4: { events: [null, npc(1, [c(201, 0, 1, 1, 2, 3, 0, 0)])] },
      5: { events: [null, npc(1, [c(202, 0, 1, 0, 1, 0, 0)])] },
    },
    commonEvents: [null, ce(1, [c(117, 0, 2)]), ce(2, [transfer(1)])],
  });
  assert.deepEqual(report.reachableMaps, [1, 2, 3, 4, 5]);
  assert.deepEqual(report.deadEndMaps, [2, 5], "a 202 (vehicle location) is not a way out");
});

test("a 202 vehicle location does not make its map reachable", async () => {
  const { report } = await run({ maps: { 1: { events: [null, npc(1, [c(202, 0, 0, 0, 2, 3, 4)])] }, 2: {} } });
  assert.deepEqual(report.reachableMaps, [1]);
});

test("switch writes: big 121 ranges reach high ids, move-route switch ON counts", async () => {
  const gate = (list, id) => ({ maps: { 1: { events: [null, npc(1, list), door(2, 2, sw(id))] }, 2: {} } });
  assert.deepEqual((await run(gate([switchOn(1, 100000)], 50000))).report.reachableMaps, [1, 2]);
  const route = c(205, 0, -1, { list: [{ code: 27, parameters: [12] }, { code: 0 }], repeat: false, skippable: false, wait: true });
  assert.deepEqual((await run(gate([route], 12))).report.reachableMaps, [1, 2]);
});

// ---- references, uncertainty, goals ----

test("neverSet / neverRead come from every page, reachable or not", async () => {
  const { report } = await run({
    maps: {
      1: { events: [null, npc(1, [c(111, 0, 0, 3, 0), c(0, 1), c(412, 0), switchOn(4), c(122, 0, 5, 5, 0, 0, 1)])] },
      2: { events: [null, npc(1, [c(111, 0, 1, 6, 0, 2, 1), c(0, 1), c(412, 0), switchOn(7)]), door(2, 1, sw(7))] },
    },
  });
  assert.deepEqual(report.switches, { neverSet: [3], neverRead: [4] });
  assert.deepEqual(report.variables, { neverSet: [6], neverRead: [5] });
});

test("confidence is low when the project has script, plugin or variable-designated commands (counted over all pages)", async () => {
  const clean = (await run({ maps: { 1: { events: [null, npc(1, [switchOn(1)])] } } })).report;
  assert.deepEqual(clean.uncertainty, { scriptCommands: 0, pluginCommands: 0, variableTransfers: 0, variableBattles: 0, confidence: "high" });
  const cases = [
    [c(355, 0, "$gameSwitches.setValue(5, true)"), "scriptCommands"],
    [c(356, 0, "OpenDoor 5"), "pluginCommands"],
    [c(201, 0, 1, 1, 2, 3, 0, 0), "variableTransfers"],
    [c(301, 0, 1, 4, false, false), "variableBattles"],
  ];
  for (const [command, field] of cases) {
    for (const where of [1, 2]) {
      const maps = { 1: { events: [null, npc(1, where === 1 ? [command] : [])] }, 2: { events: [null, npc(1, where === 2 ? [command] : [])] } };
      const { report } = await run({ maps });
      assert.equal(report.uncertainty[field], 1);
      assert.equal(report.uncertainty.confidence, "low", `${field} on map ${where}`);
      assert.ok(report.notes.some((n) => n.includes("counted over all pages")), report.notes.join("\n"));
    }
  }
});

test("a reachable map that cannot be read makes the confidence low and is noted", async () => {
  const { report } = await run({ maps: { 1: { events: [null, door(1, 2)] }, 2: null } });
  assert.deepEqual(report.reachableMaps, [1, 2]);
  assert.equal(report.uncertainty.confidence, "low");
  assert.ok(report.notes.some((n) => n.includes("map 2") && n.includes("could not be read")), report.notes.join("\n"));
  const unreachable = (await run({ maps: { 1: {}, 2: null } })).report;
  assert.equal(unreachable.uncertainty.confidence, "high");
});

test("goal event: reachable when some page can trigger, else the reasons", async () => {
  const spec = {
    maps: {
      1: { events: [null, event(1, [page([END], { conditions: sw(2) }), page([END], { conditions: { itemValid: true, itemId: 3 } })]), npc(2, [])] },
      2: { events: [null, npc(1, [])] },
    },
  };
  assert.deepEqual((await run(spec, { goal: { event: { mapId: 1, eventId: 2 } } })).report.goal, { target: "map 1 event 2", reachable: true, blockedBy: [] });
  assert.deepEqual((await run(spec, { goal: { event: { mapId: 1, eventId: 1 } } })).report.goal, {
    target: "map 1 event 1",
    reachable: false,
    blockedBy: ["page 1: switch 2 is never switched ON by any reachable event", "page 2: item 3 can never be obtained"],
  });
  assert.deepEqual((await run(spec, { goal: { event: { mapId: 2, eventId: 1 } } })).report.goal, {
    target: "map 2 event 1",
    reachable: false,
    blockedBy: ["map 2 is unreachable", "no event transfers to map 2"],
  });
  assert.deepEqual((await run(spec, { goal: { event: { mapId: 1, eventId: 9 } } })).report.goal, {
    target: "map 1 event 9",
    reachable: false,
    blockedBy: ["map 1 has no event 9"],
  });
});

test("goal switch with no setter at all, and blockedBy capped at 10", async () => {
  assert.deepEqual((await run({}, { goal: { switch: 3 } })).report.goal, { target: "switch 3", reachable: false, blockedBy: ["no event ever sets switch 3"] });
  const setters = Array.from({ length: 12 }, (_, i) => event(i + 1, [page([switchOn(3), END], { conditions: sw(4) })]));
  const { report } = await run({ maps: { 1: { events: [null, ...setters] } } }, { goal: { switch: 3 } });
  assert.equal(report.goal.blockedBy.length, 10);
  assert.equal(report.goal.blockedBy[0], "Map001 event 1 page 1: switch 4 is never switched ON by any reachable event");
});

test("lists are sorted and capped at limit with truncated set", async () => {
  const maps = { 1: {} };
  for (let id = 2; id <= 6; id++) maps[id] = {};
  const { index, report } = await run({ maps }, { limit: 2 });
  assert.deepEqual(report.unreachableMaps, [2, 3]);
  assert.equal(report.truncated, true);
  assert.equal(analyzeProgression(index, { limit: 10 }).truncated, false);
});

test("pure and idempotent: two calls give equal reports and the index is not changed", async () => {
  const { index } = await run({
    maps: { 1: { events: [null, npc(1, [switchOn(5), c(117, 0, 1)]), door(2, 2, sw(5))] }, 2: { events: [null, door(1, 1)] } },
    commonEvents: [null, ce(1, [c(123, 0, "A", 0)])],
  });
  const before = JSON.stringify(index);
  const a = analyzeProgression(index, { limit: 100, goal: { mapId: 2 } });
  const b = analyzeProgression(index, { limit: 100, goal: { mapId: 2 } });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(index), before);
});

// ---- size ----

test("a 200-map chain of switch-gated doors is analysed in under 2 s", async () => {
  const maps = {};
  for (let id = 1; id <= 200; id++) {
    maps[id] = { events: [null, npc(1, [switchOn(id)]), door(2, id < 200 ? id + 1 : 1, sw(id))] };
  }
  const index = await buildProjectIndex(memoryProject({ maps }));
  const t0 = performance.now();
  const report = analyzeProgression(index, { limit: 500, goal: { mapId: 200 } });
  const ms = performance.now() - t0;
  assert.equal(report.reachableMaps.length, 200);
  assert.equal(report.goal.reachable, true);
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
});

test("the fixpoint is bounded: a dependency chain longer than 10 000 steps stops, says so and lowers confidence", async () => {
  const maps = {};
  const n = 10_005;
  for (let id = 1; id <= n; id++) maps[id] = { events: [null, ...(id < n ? [door(1, id + 1)] : [])] };
  const index = await buildProjectIndex(memoryProject({ maps }));
  const report = analyzeProgression(index, { limit: 10 });
  assert.equal(report.truncated, true);
  assert.equal(report.uncertainty.confidence, "low");
  assert.ok(report.notes.some((n) => n.includes("10000")), report.notes.join("\n"));
});

// ---- randomized differential test against an independent brute-force explorer ----

/**
 * Random small project in fixture-spec form. The "heavy" profile has few maps and several common events, map pages
 * that mostly call them and many self-switch conditions, so nested calls whose 123 sets the caller's self switch occur.
 */
function randomSpec(rng, heavy) {
  const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const chance = (p) => rng() < p;
  const nMaps = heavy ? int(1, 2) : int(1, 6);
  const nCE = heavy ? int(2, 4) : int(0, 3);
  const nTroops = int(0, 2);
  const command = () => {
    switch (int(0, 11)) {
      case 0:
      case 1: {
        const a = int(1, 8);
        return c(121, 0, a, Math.min(8, a + int(0, 2)), chance(0.8) ? 0 : 1);
      }
      case 2:
        return c(122, 0, int(1, 4), int(1, 4), 0, 0, int(0, 5));
      case 3:
        return c(123, 0, chance(0.7) ? "A" : "B", chance(0.8) ? 0 : 1);
      case 4:
        return c(126, 0, int(1, 4), chance(0.8) ? 0 : 1, 0, 1);
      case 5:
        return c(302, 0, 0, int(1, 4), 0, 0, false);
      case 6:
      case 7:
        return transfer(int(1, nMaps));
      case 8:
        return nCE > 0 ? c(117, 0, int(1, nCE)) : c(101, 0, "", 0, 0, 2);
      case 9:
        return c(129, 0, int(1, 3), chance(0.7) ? 0 : 1, false);
      case 10:
        return nTroops > 0 ? c(301, 0, 0, int(1, nTroops), false, false) : c(230, 0, 1);
      default:
        return c(205, 0, -1, { list: [{ code: chance(0.5) ? 27 : 28, parameters: [int(1, 8)] }, { code: 0 }], repeat: false, skippable: false, wait: true });
    }
  };
  const mapCommand = () => (heavy && chance(0.4) ? c(117, 0, int(1, nCE)) : command());
  const commands = (max) => Array.from({ length: int(0, max) }, command);
  // Common event bodies lean on 123 and 117 so the caller-context path (a called 123 sets the caller's self switch) is hit.
  const ceCommand = () => (chance(0.3) ? c(123, 0, chance(0.7) ? "A" : "B", chance(0.8) ? 0 : 1) : chance(0.3) ? c(117, 0, int(1, nCE)) : command());
  const ceCommands = (max) => Array.from({ length: int(0, max) }, ceCommand);
  const conditions = () => {
    const out = {};
    if (chance(0.3)) Object.assign(out, { switch1Valid: true, switch1Id: int(1, 8) });
    if (chance(0.1)) Object.assign(out, { switch2Valid: true, switch2Id: int(1, 8) });
    if (chance(0.2)) Object.assign(out, { variableValid: true, variableId: int(1, 4), variableValue: int(0, 3) });
    if (chance(heavy ? 0.5 : 0.3)) Object.assign(out, { selfSwitchValid: true, selfSwitchCh: chance(0.7) ? "A" : "B" });
    if (chance(0.15)) Object.assign(out, { itemValid: true, itemId: int(1, 4) });
    if (chance(0.1)) Object.assign(out, { actorValid: true, actorId: int(1, 3) });
    return out;
  };
  const maps = {};
  for (let m = 1; m <= nMaps; m++) {
    const events = [null];
    for (let e = 1, n = int(0, 4); e <= n; e++) {
      events.push(event(e, Array.from({ length: int(1, 3) }, () => page([...Array.from({ length: int(0, 3) }, mapCommand), END], { conditions: conditions() }))));
    }
    const encounterList = nTroops > 0 && chance(0.3) ? [{ troopId: int(1, nTroops), regionSet: [], weight: 5 }] : [];
    maps[m] = { events, encounterList };
  }
  const commonEvents = [null];
  for (let id = 1; id <= nCE; id++) commonEvents.push(ce(id, ceCommands(3), { trigger: int(0, 2), switchId: int(0, 8) }));
  const troops = [null];
  for (let id = 1; id <= nTroops; id++) {
    troops.push(
      troop(
        id,
        Array.from({ length: int(1, 2) }, () => troopPage(commands(2), chance(0.4) ? { switchValid: true, switchId: int(1, 8) } : { turnEnding: true })),
      ),
    );
  }
  const enemies = [null, { id: 1, name: "E", actions: [], dropItems: chance(0.5) ? [{ kind: 1, dataId: int(1, 4), denominator: 1 }] : [] }];
  const items = [null];
  for (let id = 1; id <= 4; id++) items.push({ id, name: `I${id}`, effects: nCE > 0 && chance(0.2) ? [{ code: 44, dataId: int(1, nCE) }] : [] });
  const skills = [null, { id: 1, name: "S", effects: nCE > 0 && chance(0.2) ? [{ code: 44, dataId: int(1, nCE) }] : [] }];
  return { system: { startMapId: int(1, nMaps), partyMembers: chance(0.5) ? [1] : [1, 2] }, maps, commonEvents, troops, enemies, items, skills };
}

/**
 * Independent brute force over the same abstraction, working on the raw spec (not the index): fire every
 * triggerable page (in a shuffled order each round, running called common events inline with the caller's
 * event as context) until a full round changes nothing.
 */
function explore(spec, rng) {
  const st = { R: new Set([spec.system.startMapId]), S: new Set(), W: new Set(), G: new Set(), A: new Set(spec.system.partyMembers), F: new Set(), C: new Set(), T: new Set() };
  const edges = new Set();
  const size = () => Object.values(st).reduce((n, s) => n + s.size, 0) + edges.size;
  for (const e of spec.enemies) for (const d of e?.dropItems ?? []) if (d.kind === 1) st.G.add(d.dataId);
  for (const s of spec.skills) for (const ef of s?.effects ?? []) if (ef.code === 44) st.C.add(ef.dataId);
  const pages = [];
  for (const [m, map] of Object.entries(spec.maps)) {
    for (const ev of map.events) if (ev) ev.pages.forEach((pg, i) => pages.push({ kind: "map", mapId: Number(m), eventId: ev.id, page: i, raw: pg }));
  }
  for (const e of spec.commonEvents) if (e) pages.push({ kind: "commonEvent", eventId: e.id, page: 0, raw: e });
  for (const t of spec.troops) if (t) t.pages.forEach((pg, i) => pages.push({ kind: "troop", eventId: t.id, page: i, raw: pg }));

  const triggerable = (p) => {
    if (p.kind === "map") {
      const k = p.raw.conditions;
      return (
        st.R.has(p.mapId) &&
        (!k.switch1Valid || st.S.has(k.switch1Id)) &&
        (!k.switch2Valid || st.S.has(k.switch2Id)) &&
        (!k.variableValid || st.W.has(k.variableId) || 0 >= k.variableValue) &&
        (!k.selfSwitchValid || st.F.has(`${p.mapId}:${p.eventId}:${k.selfSwitchCh}`)) &&
        (!k.itemValid || st.G.has(k.itemId)) &&
        (!k.actorValid || st.A.has(k.actorId))
      );
    }
    if (p.kind === "commonEvent") {
      const e = p.raw;
      return st.C.has(e.eventId ?? e.id) || ((e.trigger === 1 || e.trigger === 2) && (e.switchId < 1 || st.S.has(e.switchId)));
    }
    return st.T.has(p.eventId) && (!p.raw.conditions.switchValid || st.S.has(p.raw.conditions.switchId));
  };
  const runList = (list, ctx, own, mapId, active) => {
    for (const cmd of list) {
      const q = cmd.parameters;
      switch (cmd.code) {
        case 121:
          if (q[2] === 0) for (let i = q[0]; i <= q[1]; i++) st.S.add(i);
          break;
        case 122:
          for (let i = q[0]; i <= q[1]; i++) st.W.add(i);
          break;
        case 123:
          if (q[1] === 0 && ctx) st.F.add(`${ctx}:${q[0]}`);
          break;
        case 126:
          if (q[1] === 0) st.G.add(q[0]);
          break;
        case 302:
          if (q[0] === 0) st.G.add(q[1]);
          break;
        case 129:
          if (q[1] === 0) st.A.add(q[0]);
          break;
        case 117: {
          st.C.add(q[0]);
          const key = `${q[0]}@${ctx}`;
          const callee = spec.commonEvents[q[0]];
          if (callee && !active.has(key)) {
            active.add(key);
            runList(callee.list, ctx, false, mapId, active);
          }
          break;
        }
        case 201:
          st.R.add(q[1]);
          if (own) edges.add(`${mapId}>${q[1]}`);
          break;
        case 301:
          st.T.add(q[1]);
          break;
        case 205:
          for (const r of q[1].list) if (r.code === 27 || r.code === 28) st.S.add(r.parameters[0]);
          break;
      }
    }
  };
  const fired = new Set();
  for (;;) {
    const before = size();
    for (const m of st.R) for (const enc of spec.maps[m]?.encounterList ?? []) st.T.add(enc.troopId);
    for (const id of st.G) for (const ef of spec.items[id]?.effects ?? []) if (ef.code === 44) st.C.add(ef.dataId);
    const order = pages.map((p, i) => [rng(), i]).sort((x, y) => x[0] - y[0]).map(([, i]) => pages[i]);
    for (const p of order) {
      if (!triggerable(p)) continue;
      fired.add(p);
      const ctx = p.kind === "map" ? `${p.mapId}:${p.eventId}` : null;
      runList(p.raw.list, ctx, p.kind === "map", p.mapId, new Set());
    }
    if (size() === before) break;
  }
  return { st, edges, fired, pages };
}

const pageKey = (p) => `${p.kind}:${p.mapId ?? "-"}:${p.eventId}:${p.page}`;

test("randomized differential: analyzeProgression equals a brute-force explorer on 250 seeded projects", async () => {
  const t0 = performance.now();
  for (let seed = 1; seed <= 250; seed++) {
    const rng = mulberry32(seed);
    const spec = randomSpec(rng, seed % 2 === 0);
    const index = await buildProjectIndex(memoryProject(spec));
    const report = analyzeProgression(index, { limit: 10_000 });
    const truth = explore(spec, mulberry32(seed * 7919));
    const msg = `seed ${seed}`;
    const mapIds = Object.keys(spec.maps).map(Number);

    assert.deepEqual(report.reachableMaps, [...truth.st.R].filter((m) => mapIds.includes(m)).sort((a, b) => a - b), msg);
    assert.deepEqual(report.unreachableMaps, mapIds.filter((m) => !truth.st.R.has(m)), msg);
    assert.deepEqual(
      report.edges.map((e) => `${e.from}>${e.to}`).sort(),
      [...truth.edges].sort(),
      msg,
    );
    const isEmpty = (p) => p.raw.list.every((cmd) => cmd.code === 0);
    const expectedDead = truth.pages
      .filter((p) => !truth.fired.has(p))
      .filter((p) => (p.kind === "map" ? truth.st.R.has(p.mapId) : !isEmpty(p)))
      .map(pageKey)
      .sort();
    assert.deepEqual(report.deadPages.map(pageKey).sort(), expectedDead, msg);
    for (let s = 1; s <= 8; s++) {
      assert.equal(analyzeProgression(index, { limit: 10, goal: { switch: s } }).goal.reachable, truth.st.S.has(s), `${msg} switch ${s}`);
    }
    for (const p of truth.pages.filter((q) => q.kind === "map" && q.page === 0)) {
      const goal = analyzeProgression(index, { limit: 10, goal: { event: { mapId: p.mapId, eventId: p.eventId } } }).goal;
      const any = truth.pages.some((q) => q.kind === "map" && q.mapId === p.mapId && q.eventId === p.eventId && truth.fired.has(q));
      assert.equal(goal.reachable, any, `${msg} event ${p.mapId}/${p.eventId}`);
    }
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 15000, `differential test took ${ms.toFixed(0)} ms`);
});

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildProjectIndex } from "../dist/eventIndex.js";
import { describeWhere, findUsages } from "../dist/usages.js";
import { c, END, createFixtureProject, event, page } from "./helpers/fixtureProject.mjs";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/** MV table from a { id: record } object: index = id, null everywhere else. */
const table = (records) => {
  const out = [null];
  for (const [id, rec] of Object.entries(records)) out[Number(id)] = { id: Number(id), ...rec };
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = null;
  return out;
};

/** A small world that touches every reference kind the tests below look at. */
const world = () => ({
  system: {
    startMapId: 1,
    switches: ["", "Opened Chest", "", "Never Set", "Never Read"],
    variables: ["", "Quest Progress"],
  },
  maps: {
    1: {
      events: [
        null,
        event(1, [page([c(121, 0, 1, 1, 0), c(126, 0, 5, 0, 0, 1), c(117, 0, 4), c(313, 0, 0, 1, 0, 7), c(201, 0, 0, 2, 0, 0, 0, 0), END])]),
        event(2, [page([END]), page([c(111, 0, 0, 1, 0), END], { conditions: { switch1Valid: true, switch1Id: 1 } })]),
        event(3, [page([c(111, 0, 0, 3, 0), c(0, 1), c(412, 0), END])]),
        event(4, [page([c(302, 0, 0, 5, 0, 0, false), END])]),
        event(5, [page([c(121, 0, 4, 4, 0), END])]),
      ],
    },
    2: { encounterList: [{ troopId: 1, regionSet: [], weight: 10 }] },
    3: {},
  },
  commonEvents: table({
    4: { name: "Heal", trigger: 0, switchId: 1, list: [END] },
    5: { name: "Auto", trigger: 1, switchId: 2, list: [c(121, 0, 4, 4, 0), END] },
    6: { name: "Orphan", trigger: 0, switchId: 1, list: [END] },
  }),
  troops: table({ 1: { name: "Slimes", members: [], pages: [] } }),
  enemies: table({ 4: { name: "Slime", dropItems: [{ kind: 1, dataId: 5, denominator: 1 }], actions: [] } }),
  items: table({
    5: { name: "Potion", effects: [] },
    6: { name: "Scroll", effects: [{ code: 21, dataId: 7, value1: 1, value2: 0 }, { code: 44, dataId: 4, value1: 0, value2: 0 }] },
  }),
});

async function withIndex(spec, fn) {
  const fx = await createFixtureProject(spec);
  try {
    return await fn(await buildProjectIndex(fx.project), fx);
  } finally {
    await fx.cleanup();
  }
}

/** Names default to "n" so tests do not trip the unknown id warning; pass `name: undefined` to test it. */
const usages = (index, kind, id, opts = {}) => findUsages(index, { kind, id }, { limit: 100, name: "n", ...opts });

test("describeWhere: map, common event, troop, database and system locations", () => {
  assert.equal(describeWhere({ source: "map", mapId: 3, eventId: 5, page: 0, index: 12 }), "Map003 event 5 page 1 command index 12");
  assert.equal(describeWhere({ source: "map", mapId: 3, eventId: 5, page: 1 }), "Map003 event 5 page 2 conditions");
  assert.equal(describeWhere({ source: "map", mapId: 12, field: "encounterList" }), "Map012 encounterList");
  assert.equal(describeWhere({ source: "map", mapId: 1234, eventId: 2, page: 0, index: 0 }), "Map1234 event 2 page 1 command index 0");
  assert.equal(describeWhere({ source: "commonEvent", eventId: 4, page: 0, index: 7 }), "CommonEvent 4 command index 7");
  assert.equal(describeWhere({ source: "commonEvent", eventId: 4, page: 0 }), "CommonEvent 4 conditions");
  assert.equal(describeWhere({ source: "troop", eventId: 2, page: 0, index: 3 }), "Troop 2 page 1 command index 3");
  assert.equal(describeWhere({ source: "troop", eventId: 2, page: 2 }), "Troop 2 page 3 conditions");
  assert.equal(describeWhere({ source: "database", table: "Enemies", recordId: 4, field: "dropItems" }), "Enemies #4 dropItems");
  assert.equal(describeWhere({ source: "system", field: "startMapId" }), "System startMapId");
  assert.equal(describeWhere({ source: "system", field: "partyMembers", index: 1 }), "System partyMembers");
});

test("describeWhere tolerates incomplete locations", () => {
  assert.equal(describeWhere({ source: "map" }), "Map");
  assert.equal(describeWhere({ source: "database" }), "Database");
  assert.equal(describeWhere({ source: "system" }), "System");
});

test("switch: reads and writes are listed with exact locations and counted", async () => {
  await withIndex(world(), (index) => {
    const r = usages(index, "switch", 1, { name: "Opened Chest" });
    assert.deepEqual(r.target, { kind: "switch", id: 1, name: "Opened Chest" });
    assert.deepEqual(r.writes, ["Map001 event 1 page 1 command index 0"]);
    assert.deepEqual(r.reads, ["Map001 event 2 page 2 conditions", "Map001 event 2 page 2 command index 0"]);
    assert.deepEqual(r.uses, []);
    assert.deepEqual(r.counts, { reads: 2, writes: 1, uses: 0 });
    assert.deepEqual(r.truncated, { reads: 0, writes: 0, uses: 0 });
    assert.deepEqual(r.warnings, []);
  });
});

test("switch read but never set warns; set but never read warns; common event conditions count as reads", async () => {
  await withIndex(world(), (index) => {
    const never = usages(index, "switch", 3, { name: "Never Set" });
    assert.deepEqual(never.reads, ["Map001 event 3 page 1 command index 0"]);
    assert.deepEqual(never.warnings, ["switch 3 is read but never set anywhere (always OFF/0 unless a script or plugin sets it)"]);

    const unread = usages(index, "switch", 4, { name: "Never Read" });
    assert.deepEqual(unread.writes, ["Map001 event 5 page 1 command index 0", "CommonEvent 5 command index 0"]);
    assert.deepEqual(unread.warnings, ["switch 4 is set but never read"]);

    const ceCond = usages(index, "switch", 2);
    assert.deepEqual(ceCond.reads, ["CommonEvent 5 conditions"]);
    assert.equal(ceCond.warnings.some((w) => w.startsWith("switch 2 is read but never set anywhere")), true);
  });
});

test("variable warnings use the variable kind", async () => {
  await withIndex(
    { maps: { 1: { events: [null, event(1, [page([c(122, 0, 7, 7, 0, 0, 1), END])]), event(2, [page([c(111, 0, 1, 9, 0, 0, 0), END])])] } } },
    (index) => {
      assert.deepEqual(usages(index, "variable", 7).warnings, ["variable 7 is set but never read"]);
      assert.deepEqual(usages(index, "variable", 9).warnings, [
        "variable 9 is read but never set anywhere (always OFF/0 unless a script or plugin sets it)",
      ]);
    },
  );
});

test("a switch that is neither read nor written has no usage warnings", async () => {
  await withIndex(world(), (index) => {
    const r = usages(index, "switch", 99);
    assert.deepEqual(r.counts, { reads: 0, writes: 0, uses: 0 });
    assert.deepEqual(r.warnings.filter((w) => !w.startsWith("unknown id")), []);
  });
});

test("item: gained by 126, sold by 302, dropped by an enemy", async () => {
  await withIndex(world(), (index) => {
    const r = usages(index, "item", 5, { name: "Potion" });
    assert.deepEqual(r.writes, ["Map001 event 1 page 1 command index 1"]);
    assert.deepEqual(r.uses, ["Map001 event 4 page 1 command index 0", "Enemies #4 dropItems"]);
    assert.deepEqual(r.counts, { reads: 0, writes: 1, uses: 2 });
    assert.deepEqual(r.warnings, []);
  });
});

test("state: written by 313 and used by an item effect", async () => {
  await withIndex(world(), (index) => {
    const r = usages(index, "state", 7, { name: "Poison" });
    assert.deepEqual(r.writes, ["Map001 event 1 page 1 command index 3"]);
    assert.deepEqual(r.uses, ["Items #6 effects"]);
  });
});

test("common event: called by 117 and by an item effect; never called warns", async () => {
  await withIndex(world(), (index) => {
    const called = usages(index, "commonEvent", 4, { name: "Heal" });
    assert.deepEqual(called.uses, ["Map001 event 1 page 1 command index 2", "Items #6 effects"]);
    assert.deepEqual(called.warnings, []);

    const orphan = usages(index, "commonEvent", 6, { name: "Orphan" });
    assert.deepEqual(orphan.uses, []);
    assert.deepEqual(orphan.warnings, ["common event 6 is never called"]);
  });
});

test("common event with an autorun or parallel trigger runs by itself: no never-called warning", async () => {
  await withIndex(world(), (index) => {
    const auto = usages(index, "commonEvent", 5, { name: "Auto" });
    assert.deepEqual(auto.uses, []);
    assert.deepEqual(auto.warnings, []);
  });
});

test("map: used by 201 and by System startMapId; unused map warns; troop used by an encounter list", async () => {
  await withIndex(world(), (index) => {
    assert.deepEqual(usages(index, "map", 2).uses, ["Map001 event 1 page 1 command index 4"]);
    assert.deepEqual(usages(index, "map", 2).warnings, []);

    const start = usages(index, "map", 1);
    assert.deepEqual(start.uses, ["System startMapId"]);
    assert.deepEqual(start.warnings, []);

    const lonely = usages(index, "map", 3);
    assert.deepEqual(lonely.uses, []);
    assert.deepEqual(lonely.warnings, ["no event transfers the player here and it is not the start map"]);

    assert.deepEqual(usages(index, "troop", 1).uses, ["Map002 encounterList"]);
  });
});

test("actor: party member, 313 target and equip references show their locations", async () => {
  await withIndex(world(), (index) => {
    const r = usages(index, "actor", 1);
    assert.deepEqual(r.uses, ["System partyMembers", "Map001 event 1 page 1 command index 3"]);
  });
});

test("limit caps each role and truncated counts the rest", async () => {
  const many = [c(121, 0, 9, 9, 0), c(121, 0, 9, 9, 0), c(121, 0, 9, 9, 0), c(121, 0, 9, 9, 0), c(121, 0, 9, 9, 0), END];
  await withIndex({ maps: { 1: { events: [null, event(1, [page(many)])] } } }, (index) => {
    const r = usages(index, "switch", 9, { limit: 2 });
    assert.equal(r.writes.length, 2);
    assert.deepEqual(r.writes, ["Map001 event 1 page 1 command index 0", "Map001 event 1 page 1 command index 1"]);
    assert.deepEqual(r.counts, { reads: 0, writes: 5, uses: 0 });
    assert.deepEqual(r.truncated, { reads: 0, writes: 3, uses: 0 });
  });
});

test("unknown id: not an error, reported with an unknown id warning", async () => {
  await withIndex(world(), (index) => {
    const unknown = usages(index, "item", 40, { name: undefined });
    assert.equal("name" in unknown.target, false);
    assert.equal(unknown.warnings.some((w) => w.startsWith("unknown id")), true);

    // An empty name (a defined but unnamed switch) is known: no unknown id warning and no target name.
    const unnamed = usages(index, "switch", 2, { name: "" });
    assert.equal("name" in unnamed.target, false);
    assert.equal(unnamed.warnings.some((w) => w.startsWith("unknown id")), false);
  });
});

test("uncertainty suffix: script and plugin commands soften never-set / never-read / never-called", () => {
  const index = {
    refs: [
      { kind: "switch", id: 3, role: "read", where: { source: "map", mapId: 1, eventId: 1, page: 0, index: 0 } },
      { kind: "switch", id: 4, role: "write", where: { source: "map", mapId: 1, eventId: 1, page: 0, index: 1 } },
    ],
    pages: [],
    hidden: { scriptCommands: 2, pluginCommands: 1, variableTransfers: 0, variableBattles: 0, truncatedRanges: 0 },
  };
  const suffix = " — note: 3 script/plugin commands in this project could also set or read it.";
  assert.deepEqual(usages(index, "switch", 3, { name: "x" }).warnings, [
    "switch 3 is read but never set anywhere (always OFF/0 unless a script or plugin sets it)" + suffix,
  ]);
  assert.deepEqual(usages(index, "switch", 4, { name: "x" }).warnings, ["switch 4 is set but never read" + suffix]);
  assert.deepEqual(usages(index, "commonEvent", 8, { name: "x" }).warnings, ["common event 8 is never called" + suffix]);
});

test("uncertainty suffix: truncated ranges apply to switches and variables only; both suffixes combine", () => {
  const index = {
    refs: [
      { kind: "switch", id: 3, role: "read", where: { source: "map", mapId: 1, eventId: 1, page: 0, index: 0 } },
      { kind: "variable", id: 3, role: "write", where: { source: "map", mapId: 1, eventId: 1, page: 0, index: 0 } },
    ],
    pages: [],
    hidden: { scriptCommands: 1, pluginCommands: 0, variableTransfers: 0, variableBattles: 0, truncatedRanges: 2 },
  };
  const script = " — note: 1 script/plugin commands in this project could also set or read it.";
  const range = " — note: 2 range commands longer than 1000 ids were truncated.";
  assert.deepEqual(usages(index, "switch", 3, { name: "x" }).warnings, [
    "switch 3 is read but never set anywhere (always OFF/0 unless a script or plugin sets it)" + script + range,
  ]);
  assert.deepEqual(usages(index, "variable", 3, { name: "x" }).warnings, ["variable 3 is set but never read" + script + range]);
  // Common events and maps are not affected by range truncation.
  assert.deepEqual(usages(index, "commonEvent", 8, { name: "x" }).warnings, ["common event 8 is never called" + script]);
  assert.deepEqual(
    usages(index, "map", 8, { name: "x" }).warnings,
    ["no event transfers the player here and it is not the start map — note: 1 script, plugin or variable-designated transfer commands in this project could also send the player here."],
  );
});

test("a certain warning stays plain when the project has no hidden commands", async () => {
  await withIndex(world(), (index) => {
    assert.equal(index.hidden.scriptCommands + index.hidden.pluginCommands + index.hidden.truncatedRanges, 0);
    assert.equal(usages(index, "switch", 3).warnings[0].includes("note:"), false);
  });
});

// ---- the tool ----

async function withServer(spec, fn, { setProject = true } = {}) {
  const fx = await createFixtureProject(spec);
  const client = new Client({ name: "usages-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "ignore" }));
  const call = async (name, args) => {
    let res;
    try {
      res = await client.callTool({ name, arguments: args });
    } catch (err) {
      return { isError: true, text: String(err?.message ?? err), json: null };
    }
    const text = res.content?.[0]?.text ?? "";
    return { isError: !!res.isError, text, json: !res.isError && /^[{[]/.test(text) ? JSON.parse(text) : null };
  };
  try {
    if (setProject) assert.equal((await call("set_project", { path: fx.root })).isError, false);
    return await fn({ call, fx });
  } finally {
    await client.close();
    await fx.cleanup();
  }
}

const worldFiles = () => {
  const w = world();
  return { ...w, files: { "States.json": table({ 7: { name: "Poison" } }), "Weapons.json": [null], "Armors.json": [null], "Classes.json": [null, { id: 1, name: "Hero" }] } };
};

test("find_usages: no project selected", async () => {
  await withServer({}, async ({ call }) => {
    const r = await call("find_usages", { kind: "switch", id: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /No project selected/);
  }, { setProject: false });
});

test("find_usages: rejects an unknown kind and a bad id or limit", async () => {
  await withServer({}, async ({ call }) => {
    assert.equal((await call("find_usages", { kind: "monster", id: 1 })).isError, true);
    assert.equal((await call("find_usages", { kind: "switch", id: 0 })).isError, true);
    assert.equal((await call("find_usages", { kind: "switch", id: 1.5 })).isError, true);
    assert.equal((await call("find_usages", { kind: "switch", id: 1, limit: 0 })).isError, true);
    assert.equal((await call("find_usages", { kind: "switch", id: 1, limit: 501 })).isError, true);
  });
});

test("find_usages: reports a switch with its System name and the default limit", async () => {
  await withServer(worldFiles(), async ({ call }) => {
    const r = await call("find_usages", { kind: "switch", id: 1 });
    assert.equal(r.isError, false);
    assert.deepEqual(r.json.target, { kind: "switch", id: 1, name: "Opened Chest" });
    assert.deepEqual(r.json.counts, { reads: 2, writes: 1, uses: 0 });
    assert.deepEqual(r.json.writes, ["Map001 event 1 page 1 command index 0"]);
  });
});

test("find_usages: resolves names from the matching database arrays and maps from MapInfos", async () => {
  await withServer(worldFiles(), async ({ call }) => {
    const names = {
      item: [5, "Potion"],
      state: [7, "Poison"],
      enemy: [4, "Slime"],
      troop: [1, "Slimes"],
      commonEvent: [4, "Heal"],
      class: [1, "Hero"],
      map: [2, "Map2"],
      variable: [1, "Quest Progress"],
    };
    for (const [kind, [id, name]] of Object.entries(names)) {
      const r = await call("find_usages", { kind, id });
      assert.equal(r.isError, false, kind);
      assert.equal(r.json.target.name, name, kind);
      assert.equal(r.json.warnings.some((w) => w.startsWith("unknown id")), false, kind);
    }
  });
});

test("find_usages: an unknown id is a report with an unknown id warning, not an error", async () => {
  await withServer(worldFiles(), async ({ call }) => {
    for (const [kind, id] of [["item", 99], ["weapon", 1], ["switch", 50], ["map", 77], ["skill", 1]]) {
      const r = await call("find_usages", { kind, id });
      assert.equal(r.isError, false, kind);
      assert.equal("name" in r.json.target, false, kind);
      assert.equal(r.json.warnings.some((w) => w.startsWith("unknown id")), true, kind);
    }
  });
});

test("find_usages: a defined but unnamed switch is not unknown", async () => {
  await withServer(worldFiles(), async ({ call }) => {
    const r = await call("find_usages", { kind: "switch", id: 2 });
    assert.equal(r.json.warnings.some((w) => w.startsWith("unknown id")), false);
  });
});

test("find_usages: honours limit", async () => {
  await withServer(worldFiles(), async ({ call }) => {
    const r = await call("find_usages", { kind: "switch", id: 1, limit: 1 });
    assert.equal(r.json.reads.length, 1);
    assert.deepEqual(r.json.counts, { reads: 2, writes: 1, uses: 0 });
    assert.deepEqual(r.json.truncated, { reads: 1, writes: 0, uses: 0 });
  });
});

test("find_usages: sees staged changeset data", async () => {
  await withServer(worldFiles(), async ({ call }) => {
    assert.deepEqual((await call("find_usages", { kind: "map", id: 3 })).json.uses, []);
    assert.equal((await call("begin_changeset", { label: "stage" })).isError, false);
    assert.equal((await call("update_system", { data: { startMapId: 3 } })).isError, false);
    const r = await call("find_usages", { kind: "map", id: 3 });
    assert.deepEqual(r.json.uses, ["System startMapId"]);
    assert.deepEqual(r.json.warnings, []);
    await call("discard_changeset", {});
  });
});

test("find_usages: survives a missing database file and an unreadable map", async () => {
  await withServer({ maps: { 1: { events: [null] }, 2: null }, files: {} }, async ({ call }) => {
    const r = await call("find_usages", { kind: "weapon", id: 1 });
    assert.equal(r.isError, false);
    assert.equal(r.json.warnings.some((w) => w.startsWith("unknown id")), true);
  });
});

test("find_usages: the tool description documents the location format", async () => {
  const fx = await createFixtureProject({});
  const client = new Client({ name: "usages-desc", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "ignore" }));
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === "find_usages");
    assert.ok(tool);
    assert.match(tool.description, /command index/);
    assert.match(tool.description, /0-based/);
    assert.match(tool.description, /1-based|like the editor/);
    assert.equal(tool.inputSchema.properties.kind.enum.length, 13);
  } finally {
    await client.close();
    await fx.cleanup();
  }
});

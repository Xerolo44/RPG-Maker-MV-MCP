import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkReferences } from "../dist/references.js";
import { c, END, createFixtureProject, event, page } from "./helpers/fixtureProject.mjs";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/** MV table from a { id: record } object: index = id, null everywhere else. */
const table = (records) => {
  const out = [null];
  for (const [id, rec] of Object.entries(records)) out[Number(id)] = { id: Number(id), ...rec };
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = null;
  return out;
};

/** Every database file the check reads, with record 1 of each kind (and map 1) present. */
const base = (overrides = {}) => ({
  system: { partyMembers: [], ...(overrides.system ?? {}) },
  maps: overrides.maps ?? { 1: { events: [null] } },
  mapInfos: overrides.mapInfos,
  commonEvents: overrides.commonEvents ?? table({ 1: { name: "CE", list: [END] } }),
  troops: overrides.troops ?? table({ 1: { name: "T", members: [], pages: [] } }),
  actors: overrides.actors ?? table({ 1: { name: "Hero", classId: 1, equips: [] } }),
  classes: overrides.classes ?? table({ 1: { name: "Fighter", learnings: [] } }),
  enemies: overrides.enemies ?? table({ 1: { name: "Slime", dropItems: [], actions: [] } }),
  items: overrides.items ?? table({ 1: { name: "Potion", effects: [] } }),
  skills: overrides.skills ?? table({ 1: { name: "Attack", effects: [] } }),
  files: {
    "Weapons.json": table({ 1: { name: "Sword" } }),
    "Armors.json": table({ 1: { name: "Shield" } }),
    "States.json": table({ 1: { name: "Poison" } }),
    ...(overrides.files ?? {}),
  },
});

async function withCheck(spec, fn, opts) {
  const fx = await createFixtureProject(spec);
  try {
    return await fn(await checkReferences(fx.project, opts), fx);
  } finally {
    await fx.cleanup();
  }
}

/** One map event whose single page runs `list`. */
const mapWith = (list, extra = {}) => ({ 1: { events: [null, event(1, [page([...list, END], extra)])] } });

const find = (report, kind, id) => report.missing.find((m) => m.kind === kind && m.id === id);

test("reports missing records named by event commands, with count and location", async () => {
  const list = [
    c(301, 0, 0, 9, false, false), // troop 9
    c(302, 0, 0, 7, 0, 0, false), // shop item 7
    c(605, 0, 1, 3, 0, 0), // shop weapon 3
    c(127, 0, 4, 0, 1), // weapon 4
    c(318, 0, 0, 1, 0, 12), // learn skill 12
    c(129, 0, 5, 0, 0), // actor 5
    c(313, 0, 0, 1, 0, 8), // state 8
    c(117, 0, 6), // common event 6
    c(201, 0, 0, 4, 0, 0, 0, 0), // map 4
  ];
  await withCheck(base({ maps: mapWith(list) }), (r) => {
    assert.equal(r.missing.length, 9);
    assert.deepEqual(find(r, "troop", 9), { kind: "troop", id: 9, count: 1, locations: ["Map001 event 1 page 1 command index 0"], severity: "error" });
    assert.deepEqual(find(r, "item", 7).locations, ["Map001 event 1 page 1 command index 1"]);
    assert.deepEqual(find(r, "weapon", 3).locations, ["Map001 event 1 page 1 command index 2"]);
    assert.deepEqual(find(r, "weapon", 4).locations, ["Map001 event 1 page 1 command index 3"]);
    assert.deepEqual(find(r, "skill", 12).locations, ["Map001 event 1 page 1 command index 4"]);
    assert.deepEqual(find(r, "actor", 5).locations, ["Map001 event 1 page 1 command index 5"]);
    assert.deepEqual(find(r, "state", 8).locations, ["Map001 event 1 page 1 command index 6"]);
    assert.deepEqual(find(r, "commonEvent", 6).locations, ["Map001 event 1 page 1 command index 7"]);
    assert.deepEqual(find(r, "map", 4).locations, ["Map001 event 1 page 1 command index 8"]);
    assert.deepEqual(r.counts, { distinctMissing: 9, references: 9 });
    assert.equal(r.truncated, 0);
    assert.equal(r.summary, "9 references to 9 records that do not exist");
  });
});

test("an actor command also checks the actor, and a page condition checks its item and actor", async () => {
  const spec = base({ maps: mapWith([c(313, 0, 0, 3, 0, 1)], { conditions: { itemValid: true, itemId: 6, actorValid: true, actorId: 2 } }) });
  await withCheck(spec, (r) => {
    assert.deepEqual(r.missing.map((m) => `${m.kind} ${m.id}`), ["item 6", "actor 2", "actor 3"]);
    assert.deepEqual(find(r, "item", 6).locations, ["Map001 event 1 page 1 conditions"]);
  });
});

test("existing records and id 0 are never reported", async () => {
  const list = [
    c(301, 0, 0, 1, false, false),
    c(302, 0, 0, 1, 0, 0, false),
    c(126, 0, 1, 0, 1),
    c(127, 0, 1, 0, 1),
    c(128, 0, 1, 0, 1),
    c(313, 0, 0, 1, 0, 1),
    c(318, 0, 0, 1, 0, 1),
    c(129, 0, 1, 0, 0),
    c(117, 0, 1),
    c(201, 0, 0, 1, 0, 0, 0, 0),
    // id 0 / none: item 0, weapon 0, troop 0, shop item 0, "normal attack" state 0
    c(126, 0, 0, 0, 1),
    c(127, 0, 0, 0, 1),
    c(301, 0, 0, 0, false, false),
    c(302, 0, 0, 0, 0, 0, false),
    c(117, 0, 0),
    c(313, 0, 0, 1, 0, 0),
  ];
  const spec = base({
    system: { partyMembers: [1, 0] },
    maps: mapWith(list),
    actors: table({ 1: { name: "Hero", classId: 1, equips: [0, 0, 1, 0] } }),
    enemies: table({ 1: { name: "Slime", dropItems: [{ kind: 0, dataId: 0, denominator: 1 }, { kind: 1, dataId: 0, denominator: 1 }, { kind: 2, dataId: 1, denominator: 1 }], actions: [{ skillId: 1 }, { skillId: 0 }] } }),
    items: table({ 1: { name: "Potion", effects: [{ code: 21, dataId: 0, value1: 1, value2: 0 }, { code: 44, dataId: 1, value1: 0, value2: 0 }] } }),
  });
  await withCheck(spec, (r) => {
    assert.deepEqual(r.missing, []);
    assert.equal(r.summary, "no dangling references found");
    assert.deepEqual(r.counts, { distinctMissing: 0, references: 0 });
  });
});

test("covers enemy drops and actions, class learnings, actor class and equipment, troop members, effects, encounters and System", async () => {
  const spec = base({
    system: { startMapId: 9, partyMembers: [1, 6] },
    maps: { 1: { encounterList: [{ troopId: 8, regionSet: [], weight: 10 }], events: [null] } },
    actors: table({ 1: { name: "Hero", classId: 4, equips: [0, 2] } }),
    classes: table({ 1: { name: "Fighter", learnings: [{ level: 1, skillId: 40 }] } }),
    enemies: table({ 1: { name: "Slime", dropItems: [{ kind: 1, dataId: 5, denominator: 1 }, { kind: 3, dataId: 7, denominator: 1 }], actions: [{ skillId: 77 }] } }),
    troops: table({ 1: { name: "T", members: [{ enemyId: 3, x: 0, y: 0, hidden: false }], pages: [] } }),
    items: table({ 1: { name: "Potion", effects: [{ code: 21, dataId: 9, value1: 1, value2: 0 }, { code: 43, dataId: 11, value1: 0, value2: 0 }, { code: 44, dataId: 12, value1: 0, value2: 0 }] } }),
  });
  await withCheck(spec, (r) => {
    const got = Object.fromEntries(r.missing.map((m) => [`${m.kind} ${m.id}`, m.locations[0]]));
    assert.deepEqual(got, {
      "item 5": "Enemies #1 dropItems",
      "armor 2": "Actors #1 equips",
      "armor 7": "Enemies #1 dropItems",
      "skill 11": "Items #1 effects",
      "skill 40": "Classes #1 learnings",
      "skill 77": "Enemies #1 actions",
      "state 9": "Items #1 effects",
      "actor 6": "System partyMembers",
      "class 4": "Actors #1 classId",
      "enemy 3": "Troops #1 members",
      "troop 8": "Map001 encounterList",
      "commonEvent 12": "Items #1 effects",
      "map 9": "System startMapId",
    });
  });
});

test("groups by kind and id, orders by kind then id, keeps at most 3 distinct locations and counts every reference", async () => {
  const list = [c(127, 0, 9, 0, 1), c(126, 0, 9, 0, 1), c(126, 0, 4, 0, 1), c(126, 0, 4, 0, 1), c(126, 0, 4, 0, 1), c(126, 0, 4, 0, 1), c(301, 0, 0, 2, false, false)];
  await withCheck(base({ maps: mapWith(list) }), (r) => {
    // item (4, 9), weapon (9), troop (2): REF_KINDS order, ids ascending
    assert.deepEqual(r.missing.map((m) => `${m.kind} ${m.id}`), ["item 4", "item 9", "weapon 9", "troop 2"]);
    const item4 = find(r, "item", 4);
    assert.equal(item4.count, 4);
    assert.deepEqual(item4.locations, ["Map001 event 1 page 1 command index 2", "Map001 event 1 page 1 command index 3", "Map001 event 1 page 1 command index 4"]);
    assert.deepEqual(r.counts, { distinctMissing: 4, references: 7 });
  });
});

test("the same field repeated in one record lists its location once", async () => {
  const spec = base({ actors: table({ 1: { name: "Hero", classId: 1, equips: [0, 8, 8, 8] } }) });
  await withCheck(spec, (r) => {
    assert.deepEqual(find(r, "armor", 8), { kind: "armor", id: 8, count: 3, locations: ["Actors #1 equips"], severity: "error" });
  });
});

test("limit cuts the groups and truncated says how many; counts stay exact", async () => {
  const list = [1, 2, 3, 4, 5].map((id) => c(126, 0, id + 10, 0, 1));
  await withCheck(
    base({ maps: mapWith(list) }),
    (r) => {
      assert.deepEqual(r.missing.map((m) => m.id), [11, 12]);
      assert.equal(r.truncated, 3);
      assert.deepEqual(r.counts, { distinctMissing: 5, references: 5 });
    },
    { limit: 2 },
  );
  await withCheck(base({ maps: mapWith(list) }), (r) => {
    assert.equal(r.missing.length, 5);
    assert.equal(r.truncated, 0);
  });
});

test("a database file that cannot be read is named in the notes and not reported as missing", async () => {
  const list = [c(126, 0, 7, 0, 1), c(127, 0, 7, 0, 1), c(301, 0, 0, 5, false, false)];
  const spec = base({ maps: mapWith(list), files: { "Items.json": "{ not json", "Weapons.json": undefined } });
  delete spec.files["Weapons.json"]; // never written: a missing file
  await withCheck(spec, (r) => {
    // Items.json is overridden by files (broken JSON), Weapons.json does not exist, the troop is checked as usual
    assert.deepEqual(r.missing.map((m) => `${m.kind} ${m.id}`), ["troop 5"]);
    assert.ok(r.notes.some((n) => n.startsWith("Items.json is missing or could not be read") && n.includes("1 reference to item records was not checked")), r.notes.join("\n"));
    assert.ok(r.notes.some((n) => n.startsWith("Weapons.json is missing or could not be read")));
    assert.match(r.summary, /^1 reference to 1 record that does not exist \(some references could not be checked, see notes\)$/);
  });
  // Nothing missing and nothing checkable: still no false "all clear".
  await withCheck(base({ maps: mapWith([c(126, 0, 7, 0, 1)]), files: { "Items.json": "{ not json" } }), (r) => {
    assert.deepEqual(r.missing, []);
    assert.match(r.summary, /^no dangling references found \(some references could not be checked/);
  });
});

test("malformed data does not throw", async () => {
  const spec = base({
    maps: {
      1: {
        events: [null, { id: 1, pages: [null, { list: "nope" }, { conditions: null, list: [null, 7, { code: 126 }, { code: 126, parameters: "x" }, c(126, 0, 2147483647, 0, 1), c(126, 0, 2147483648, 0, 1), c(126, 0, -3, 0, 1), c(126, 0, 1.5, 0, 1), END] }] }, 5, null],
        encounterList: [null, 3, { troopId: "x" }],
      },
      2: null,
      3: "{ broken",
    },
    commonEvents: [null, null, { id: 2 }, { id: 3, list: null }],
    troops: [null, { id: 1, members: [null, {}, { enemyId: null }], pages: [null, { list: 4 }] }],
    actors: [null, { id: 1, classId: 1, equips: "x" }, null, 5],
    enemies: [null, { id: 1, dropItems: [null, { kind: 9, dataId: 1 }], actions: [7] }],
    classes: [null, { id: 1, learnings: null }],
    items: [null, { id: 1, effects: [null, { code: 21 }] }],
  });
  await withCheck(spec, (r) => {
    // Only the one valid out-of-range id is a reference: 2147483647 (the others are not ids)
    assert.deepEqual(r.missing.map((m) => `${m.kind} ${m.id}`), ["item 2147483647"]);
    assert.ok(r.notes.some((n) => n.includes("could not be read")), "unreadable maps are noted");
    assert.ok(r.notes.some((n) => n.includes("a transfer to such a map is not reported") && n.includes("validate_project")), "unreadable maps: transfers not reported");
    const text = r.notes.join("\n");
    assert.match(text, /Control Variables \(122\) game-data operands/);
    assert.match(text, /Conditional Branch enemy state test/);
    assert.match(text, /enemy action conditions of type state/);
  });
});

test("an empty project reports nothing", async () => {
  await withCheck(base(), (r) => {
    assert.equal(r.summary, "no dangling references found");
    assert.deepEqual(r.missing, []);
    assert.equal(r.truncated, 0);
    assert.ok(r.notes.length >= 3);
  });
  await withCheck({ system: { partyMembers: [] } }, (r) => {
    assert.equal(r.summary, "no dangling references found");
  });
});

test("notes say what is not checked and count script, plugin and variable-designated commands", async () => {
  const list = [c(355, 0, "$gameParty.gainItem($dataItems[9], 1)"), c(356, 0, "Foo bar"), c(201, 0, 1, 1, 2, 3, 0, 0), c(301, 0, 1, 4, false, false), END];
  await withCheck(base({ maps: mapWith(list.slice(0, -1)) }), (r) => {
    const text = r.notes.join("\n");
    assert.match(text, /Switches and variables are not checked/);
    assert.match(text, /script commands, plugin commands, notetags, plugin parameters, damage formulas/);
    assert.match(text, /1 script command and 1 plugin command/);
    assert.match(text, /1 Transfer Player and 1 Battle Processing commands designate their target by variable/);
    assert.deepEqual(r.missing, []);
  });
});

test("switches and variables are not checked", async () => {
  const list = [c(121, 0, 500, 500, 0), c(122, 0, 400, 400, 0, 0, 1), c(111, 0, 0, 600, 0)];
  await withCheck(base({ maps: mapWith(list) }), (r) => assert.deepEqual(r.missing, []));
});

// ---- the tool ----

async function withServer(spec, fn, { setProject = true } = {}) {
  const fx = await createFixtureProject(spec);
  const client = new Client({ name: "references-test", version: "0.0.0" });
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
    return await fn({ call, client, fx });
  } finally {
    await client.close();
    await fx.cleanup();
  }
}

test("check_references: no project selected", async () => {
  await withServer({}, async ({ call }) => {
    const r = await call("check_references", {});
    assert.equal(r.isError, true);
    assert.match(r.text, /No project selected/);
  }, { setProject: false });
});

test("check_references: reports through the tool, defaults the limit and rejects a bad one", async () => {
  await withServer(base({ maps: mapWith([c(301, 0, 0, 9, false, false)]) }), async ({ call, client }) => {
    const r = await call("check_references", {});
    assert.equal(r.isError, false);
    assert.equal(r.json.summary, "1 reference to 1 record that does not exist");
    assert.deepEqual(r.json.missing, [{ kind: "troop", id: 9, count: 1, locations: ["Map001 event 1 page 1 command index 0"], severity: "error" }]);
    assert.equal(r.json.truncated, 0);
    assert.ok(Array.isArray(r.json.notes));
    assert.equal((await call("check_references", { limit: 0 })).isError, true);
    assert.equal((await call("check_references", { limit: 1001 })).isError, true);
    assert.equal((await call("check_references", { limit: 1000 })).isError, false);
    const tool = (await client.listTools()).tools.find((t) => t.name === "check_references");
    assert.match(tool.description, /Switches and variables are not checked/);
  });
});

test("check_references sees staged changeset data", async () => {
  await withServer(base(), async ({ call }) => {
    assert.deepEqual((await call("check_references", {})).json.missing, []);
    assert.equal((await call("begin_changeset", { label: "stage" })).isError, false);
    assert.equal((await call("update_system", { data: { startMapId: 3 } })).isError, false);
    const r = await call("check_references", {});
    assert.deepEqual(r.json.missing.map((m) => `${m.kind} ${m.id}`), ["map 3"]);
    assert.deepEqual(r.json.missing[0].locations, ["System startMapId"]);
    await call("discard_changeset", {});
  });
});

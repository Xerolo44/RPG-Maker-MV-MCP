import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateCommandList } from "../dist/commandList.js";
import { buildTemplate, templateParamsSchema } from "../dist/eventTemplates.js";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const codes = (list) => list.map((c) => c.code);
const build = (params) => {
  const parsed = templateParamsSchema.parse(params);
  const built = buildTemplate(parsed);
  for (const page of built.pages) {
    assert.deepEqual(validateCommandList(page.list), []);
    assert.deepEqual(page.list.at(-1), { code: 0, indent: 0, parameters: [] });
  }
  return built;
};

const CHEST = { template: "chest", reward: { gold: 100 }, message: "Found 100G!" };

test("every template builds valid, terminated pages", () => {
  const all = [
    CHEST,
    { template: "locked_door", keyItemId: 3, destination: { mapId: 2, x: 4, y: 5 } },
    { template: "inn", price: 50 },
    { template: "shop", goods: [{ type: "item", id: 1 }] },
    { template: "save_point" },
    { template: "npc", lines: ["Hello."] },
  ];
  for (const p of all) {
    const { defaultName, pages } = build(p);
    assert.ok(defaultName.length > 0);
    assert.ok(pages.length >= 1);
  }
});

test("pages are independent deep clones of the default page", () => {
  const a = build(CHEST);
  const b = build(CHEST);
  a.pages[0].image.characterName = "mutated";
  a.pages[1].conditions.switch1Valid = true;
  assert.equal(b.pages[0].image.characterName, "");
  assert.equal(b.pages[1].conditions.switch1Valid, false);
  assert.notEqual(a.pages[0].moveRoute, a.pages[1].moveRoute);
});

test("graphics default to none", () => {
  for (const page of build(CHEST).pages) assert.equal(page.image.characterName, "");
});

test("chest page 1 is message, gold, self switch A; page 2 is the opened state", () => {
  const { defaultName, pages } = build(CHEST);
  assert.equal(defaultName, "Chest");
  assert.equal(pages.length, 2);
  assert.deepEqual(codes(pages[0].list), [101, 401, 125, 123, 0]);
  assert.equal(pages[0].trigger, 0);
  assert.deepEqual(pages[0].list[0].parameters, ["", 0, 0, 2]);
  assert.deepEqual(pages[0].list[1].parameters, ["Found 100G!"]);
  assert.deepEqual(pages[0].list[2].parameters, [0, 0, 100]);
  assert.deepEqual(pages[0].list[3].parameters, ["A", 0]);
  assert.equal(pages[1].conditions.selfSwitchValid, true);
  assert.equal(pages[1].conditions.selfSwitchCh, "A");
  assert.deepEqual(pages[1].list, [{ code: 0, indent: 0, parameters: [] }]);
});

test("chest images go on the matching page", () => {
  const closedImage = { characterName: "!Chest", characterIndex: 0 };
  const openImage = { characterName: "!Chest", characterIndex: 0, direction: 4, pattern: 2 };
  const { pages } = build({ ...CHEST, closedImage, openImage });
  assert.equal(pages[0].image.characterName, "!Chest");
  assert.equal(pages[0].image.direction, 2);
  assert.equal(pages[0].image.pattern, 1);
  assert.equal(pages[1].image.direction, 4);
  assert.equal(pages[1].image.pattern, 2);
});

test("a chest with only closedImage reuses it, facing up, for the opened page", () => {
  const closedImage = { characterName: "!Chest", characterIndex: 2, direction: 2, pattern: 1 };
  const { pages } = build({ ...CHEST, closedImage });
  assert.equal(pages[1].image.characterName, "!Chest");
  assert.equal(pages[1].image.characterIndex, 2);
  assert.equal(pages[1].image.direction, 8);
  assert.equal(pages[0].image.direction, 2);
  const none = build(CHEST).pages;
  assert.equal(none[1].image.characterName, "", "no images given: stays invisible");
});

test("chest with an item reward uses 126 [id, 0, 0, count]; weapons and armors use 127/128", () => {
  const item = build({ template: "chest", reward: { item: { type: "item", id: 7, count: 3 } } }).pages[0].list;
  const at = item.find((c) => c.code === 126);
  assert.deepEqual(at.parameters, [7, 0, 0, 3]);
  const dflt = build({ template: "chest", reward: { item: { type: "item", id: 7 } } }).pages[0].list;
  assert.deepEqual(dflt.find((c) => c.code === 126).parameters, [7, 0, 0, 1]);
  const weapon = build({ template: "chest", reward: { item: { type: "weapon", id: 2 } } }).pages[0].list;
  assert.deepEqual(weapon.find((c) => c.code === 127).parameters, [2, 0, 0, 1, false]);
  const armor = build({ template: "chest", reward: { item: { type: "armor", id: 4, count: 2 } } }).pages[0].list;
  assert.deepEqual(armor.find((c) => c.code === 128).parameters, [4, 0, 0, 2, false]);
  const both = build({ template: "chest", reward: { gold: 5, item: { type: "item", id: 1 } } }).pages[0].list;
  assert.deepEqual(codes(both), [101, 401, 125, 126, 123, 0]);
});

test("chest without a message gets a default, and a multi-line message makes several 401s", () => {
  assert.deepEqual(codes(build({ template: "chest", reward: { gold: 1 } }).pages[0].list), [101, 401, 125, 123, 0]);
  const multi = build({ template: "chest", reward: { gold: 1 }, message: "a\nb" }).pages[0].list;
  assert.deepEqual(codes(multi), [101, 401, 401, 125, 123, 0]);
});

test("locked_door codes with and without consumeKey", () => {
  const params = { template: "locked_door", keyItemId: 3, destination: { mapId: 2, x: 4, y: 5, direction: 8 } };
  const plain = build(params);
  assert.equal(plain.defaultName, "Door");
  assert.equal(plain.pages.length, 1);
  assert.deepEqual(codes(plain.pages[0].list), [111, 201, 411, 101, 401, 412, 0]);
  assert.deepEqual(plain.pages[0].list[0].parameters, [8, 3]);
  assert.deepEqual(plain.pages[0].list[1].parameters, [0, 2, 4, 5, 8, 0]);
  assert.equal(plain.pages[0].list[1].indent, 1);
  assert.deepEqual(plain.pages[0].list[4].parameters, ["It's locked."]);

  const consume = build({ ...params, consumeKey: true, lockedMessage: "You need the rusty key." });
  assert.deepEqual(codes(consume.pages[0].list), [111, 126, 201, 411, 101, 401, 412, 0]);
  assert.deepEqual(consume.pages[0].list[1].parameters, [3, 1, 0, 1]);
  assert.deepEqual(consume.pages[0].list[5].parameters, ["You need the rusty key."]);
});

test("inn charges the price, heals, and fades the screen", () => {
  const { defaultName, pages } = build({ template: "inn", price: 50, greeting: "Welcome!" });
  assert.equal(defaultName, "Inn");
  const list = pages[0].list;
  assert.deepEqual(codes(list), [101, 401, 102, 402, 111, 125, 221, 230, 314, 222, 101, 401, 411, 101, 401, 412, 402, 404, 0]);
  assert.deepEqual(list[2].parameters, [["Stay (50G)", "Leave"], 1, 0, 2, 0]);
  assert.deepEqual(list[4].parameters, [7, 50, 0]);
  assert.deepEqual(list[5].parameters, [1, 0, 50]);
  assert.deepEqual(list[7].parameters, [30]);
  assert.deepEqual(list[8].parameters, [0, 0]);
  assert.deepEqual(list[14].parameters, ["Not enough gold."]);
  assert.deepEqual(list.map((c) => c.indent), [0, 0, 0, 0, 1, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2, 1, 0, 0, 0]);
  assert.ok(codes(list).includes(314));
});

test("shop: first entry is 302, the rest are 605", () => {
  const { defaultName, pages } = build({
    template: "shop",
    goods: [
      { type: "item", id: 1 },
      { type: "weapon", id: 2, price: 300 },
      { type: "armor", id: 3 },
    ],
    purchaseOnly: true,
  });
  assert.equal(defaultName, "Shop");
  const list = pages[0].list;
  assert.deepEqual(codes(list), [302, 605, 605, 0]);
  assert.deepEqual(list[0].parameters, [0, 1, 0, 0, true]);
  assert.deepEqual(list[1].parameters, [1, 2, 1, 300]);
  assert.deepEqual(list[2].parameters, [2, 3, 0, 0]);
  const dflt = build({ template: "shop", goods: [{ type: "item", id: 1 }] }).pages[0].list;
  assert.deepEqual(dflt[0].parameters, [0, 1, 0, 0, false]);
});

test("save_point list is [352, 0]", () => {
  const { defaultName, pages } = build({ template: "save_point" });
  assert.equal(defaultName, "Save Point");
  assert.deepEqual(codes(pages[0].list), [352, 0]);
});

test("npc splits 5 lines into two boxes and applies face and image", () => {
  const { defaultName, pages } = build({
    template: "npc",
    lines: ["1", "2", "3", "4", "5"],
    face: { name: "Actor1", index: 2 },
    image: { characterName: "People1", characterIndex: 1, direction: 6, pattern: 0 },
  });
  assert.equal(defaultName, "NPC");
  assert.deepEqual(codes(pages[0].list), [101, 401, 401, 401, 401, 101, 401, 0]);
  assert.deepEqual(pages[0].list[0].parameters, ["Actor1", 2, 0, 2]);
  assert.deepEqual(pages[0].image, { tileId: 0, characterName: "People1", direction: 6, pattern: 0, characterIndex: 1 });
});

test("schema rejects shop with zero goods and inn with a negative price", () => {
  assert.equal(templateParamsSchema.safeParse({ template: "shop", goods: [] }).success, false);
  assert.equal(templateParamsSchema.safeParse({ template: "shop", goods: Array(41).fill({ type: "item", id: 1 }) }).success, false);
  assert.equal(templateParamsSchema.safeParse({ template: "shop", goods: Array(40).fill({ type: "item", id: 1 }) }).success, true);
  assert.equal(templateParamsSchema.safeParse({ template: "inn", price: -1 }).success, false);
  assert.equal(templateParamsSchema.safeParse({ template: "inn", price: 0 }).success, true);
});

test("schema rejects empty rewards, empty npc lines, unknown templates and stray keys", () => {
  assert.equal(templateParamsSchema.safeParse({ template: "chest", reward: {} }).success, false);
  assert.equal(templateParamsSchema.safeParse({ template: "npc", lines: [] }).success, false);
  assert.equal(templateParamsSchema.safeParse({ template: "bogus" }).success, false);
  assert.equal(templateParamsSchema.safeParse({ template: "save_point", price: 5 }).success, false);
  assert.equal(
    templateParamsSchema.safeParse({ template: "locked_door", keyItemId: 1, destination: { mapId: 1, x: 0, y: 0, direction: 3 } }).success,
    false,
  );
});

// ------------------------------------------------------------- tool

async function withServer(fn) {
  const client = new Client({ name: "template-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...process.env, RPGMV_TOOLS: "" },
      stderr: "ignore",
    }),
  );
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function withProject(events, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-template-"));
  await fs.mkdir(path.join(dir, "data"));
  const mapFile = path.join(dir, "data", "Map001.json");
  await fs.writeFile(mapFile, JSON.stringify({ width: 5, height: 4, data: [], events }), "utf8");
  try {
    await withServer(async (client) => {
      const set = await client.callTool({ name: "set_project", arguments: { path: dir } });
      assert.ok(!set.isError, set.content[0].text);
      await fn(client, mapFile);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const create = async (client, args) => {
  const res = await client.callTool({ name: "create_event_from_template", arguments: args });
  return { res, text: res.content[0].text, body: res.isError ? null : JSON.parse(res.content[0].text) };
};
const npcAt = (x, y) => ({ id: 1, name: "NPC", x, y, pages: [] });

test("create_event_from_template before set_project returns No project selected", async () => {
  await withServer(async (client) => {
    const { res, text } = await create(client, { mapId: 1, x: 0, y: 0, template: "save_point" });
    assert.equal(res.isError, true);
    assert.match(text, /No project selected/);
  });
});

test("a map with events: [null] gets event id 1 and a single write", async () => {
  await withProject([null], async (client, mapFile) => {
    const { body } = await create(client, { mapId: 1, x: 1, y: 2, template: "chest", reward: { gold: 10 } });
    assert.deepEqual(body, { eventId: 1, name: "Chest", pages: 2 });
    const map = JSON.parse(await fs.readFile(mapFile, "utf8"));
    assert.equal(map.events.length, 2);
    assert.equal(map.events[1].id, 1);
    assert.equal(map.events[1].x, 1);
    assert.equal(map.events[1].y, 2);
    assert.equal(map.events[1].pages.length, 2);
    assert.equal(map.events[1].note, "");
    for (const p of map.events[1].pages) assert.deepEqual(validateCommandList(p.list), []);
  });
});

test("a custom name and the next free id are used", async () => {
  await withProject([null, npcAt(0, 0)], async (client) => {
    const { body } = await create(client, { mapId: 1, x: 3, y: 3, name: "Inn Keeper", template: "inn", price: 20 });
    assert.deepEqual(body, { eventId: 2, name: "Inn Keeper", pages: 1 });
  });
});

test("an occupied tile is refused and nothing is written; allowStack succeeds", async () => {
  await withProject([null, npcAt(2, 2)], async (client, mapFile) => {
    const before = await fs.readFile(mapFile, "utf8");
    const refused = await create(client, { mapId: 1, x: 2, y: 2, template: "save_point" });
    assert.equal(refused.res.isError, true);
    assert.match(refused.text, /occupied|allowStack/);
    assert.equal(await fs.readFile(mapFile, "utf8"), before);

    const stacked = await create(client, { mapId: 1, x: 2, y: 2, template: "save_point", allowStack: true });
    assert.equal(stacked.body.eventId, 2);
    assert.equal(JSON.parse(await fs.readFile(mapFile, "utf8")).events.length, 3);
  });
});

test("out-of-bounds positions are refused and nothing is written", async () => {
  await withProject([null], async (client, mapFile) => {
    const before = await fs.readFile(mapFile, "utf8");
    for (const [x, y] of [[5, 0], [0, 4], [9, 9]]) {
      const { res, text } = await create(client, { mapId: 1, x, y, template: "save_point" });
      assert.equal(res.isError, true);
      assert.match(text, /outside map/);
    }
    assert.equal(await fs.readFile(mapFile, "utf8"), before);
  });
});

test("invalid template params are refused with a readable message and nothing is written", async () => {
  await withProject([null], async (client, mapFile) => {
    const before = await fs.readFile(mapFile, "utf8");
    const shop = await create(client, { mapId: 1, x: 0, y: 0, template: "shop", goods: [] });
    assert.equal(shop.res.isError, true);
    assert.match(shop.text, /goods/);
    const inn = await create(client, { mapId: 1, x: 0, y: 0, template: "inn", price: -5 });
    assert.equal(inn.res.isError, true);
    assert.match(inn.text, /price/);
    const missing = await create(client, { mapId: 1, x: 0, y: 0, template: "locked_door" });
    assert.equal(missing.res.isError, true);
    assert.match(missing.text, /keyItemId/);
    const stray = await create(client, { mapId: 1, x: 0, y: 0, template: "save_point", price: 5 });
    assert.equal(stray.res.isError, true);
    assert.equal(await fs.readFile(mapFile, "utf8"), before);
  });
});

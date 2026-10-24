import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const FLOOR = { sheet: "A2", kind: 16 };
const WALL = { sheet: "A2", kind: 17 };
const PROFILE = { floor: FLOOR, wall: WALL };

// A2 kind 17 is impassable in every autotile shape; B tile 5 is impassable.
const flags = new Array(8192).fill(0);
for (let s = 0; s < 48; s++) flags[2048 + 17 * 48 + s] = 0xf;
flags[5] = 0xf;

const MAP1 = JSON.stringify({
  width: 10, height: 10, tilesetId: 1, displayName: "Town", events: [null],
  data: new Array(10 * 10 * 6).fill(0), note: "",
});
const INFOS = JSON.stringify([null, { id: 1, name: "Town", parentId: 0, order: 1, expanded: false, scrollX: 0, scrollY: 0 }]);

async function tempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-genmap-"));
  const data = path.join(dir, "data");
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(dir, "Game.rpgproject"), "RPGMV 1.6.2");
  await fs.writeFile(path.join(data, "Tilesets.json"), JSON.stringify([null, {
    id: 1, mode: 1, name: "Test World", note: "", flags,
    tilesetNames: ["", "Test_A2", "", "", "", "Test_B", "", "", ""],
  }]));
  await fs.writeFile(path.join(data, "System.json"), JSON.stringify({ gameTitle: "T", startMapId: 1 }));
  await fs.writeFile(path.join(data, "MapInfos.json"), INFOS);
  await fs.writeFile(path.join(data, "Map001.json"), MAP1);
  return dir;
}

async function withServer(fn, { setProject = true } = {}) {
  const dir = await tempProject();
  const client = new Client({ name: "genmap-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "ignore" }));
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    return { isError: !!res.isError, text, json: !res.isError && /^[{[]/.test(text) ? JSON.parse(text) : null };
  };
  try {
    if (setProject) assert.equal((await call("set_project", { path: dir })).isError, false);
    await fn({ dir, call, file: (name) => path.join(dir, "data", name) });
  } finally {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const gen = (extra) => ({ kind: "dungeon", create: { name: "Crypt", width: 40, height: 30, tilesetId: 1 }, profile: PROFILE, seed: 7, ...extra });

test("dungeon with an explicit profile creates a map and reports reachable == expected", async () => {
  await withServer(async ({ call, file }) => {
    const r = await call("generate_map", gen());
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.mapId, 2);
    assert.equal(r.json.seed, 7);
    assert.ok(r.json.reachability.expected > 0);
    assert.equal(r.json.reachability.reachable, r.json.reachability.expected);
    assert.deepEqual(r.json.profileUsed, PROFILE);
    assert.deepEqual(r.json.chests, []);
    assert.ok(Array.isArray(r.json.notes));
    const map = JSON.parse(await fs.readFile(file("Map002.json"), "utf8"));
    assert.equal(map.width, 40);
    assert.equal(map.height, 30);
    assert.equal(map.data.length, 40 * 30 * 6);
    assert.ok(map.data.some((id) => id !== 0));
    const names = map.events.filter(Boolean).map((e) => e.name);
    assert.deepEqual(names, ["Entrance", "Exit"]);
    const [entrance, exit] = map.events.filter(Boolean);
    assert.deepEqual({ x: entrance.x, y: entrance.y }, r.json.entrance);
    assert.deepEqual({ x: exit.x, y: exit.y }, r.json.exit);
    assert.deepEqual(entrance.pages[0].list, [{ code: 0, indent: 0, parameters: [] }]);
    const infos = JSON.parse(await fs.readFile(file("MapInfos.json"), "utf8"));
    assert.equal(infos[2].name, "Crypt");
    assert.equal(infos[2].order, 2);
  });
});

test("same seed twice returns identical entrance and exit", async () => {
  await withServer(async ({ call }) => {
    const a = await call("generate_map", gen());
    const b = await call("generate_map", gen());
    assert.equal(a.isError, false, a.text);
    assert.equal(b.isError, false, b.text);
    assert.notEqual(a.json.mapId, b.json.mapId);
    assert.deepEqual(a.json.entrance, b.json.entrance);
    assert.deepEqual(a.json.exit, b.json.exit);
  });
});

test("an omitted seed is picked at random and returned", async () => {
  await withServer(async ({ call }) => {
    const r = await call("generate_map", gen({ seed: undefined }));
    assert.equal(r.isError, false, r.text);
    assert.ok(Number.isInteger(r.json.seed));
    const again = await call("generate_map", { ...gen({ seed: undefined }), seed: r.json.seed });
    assert.deepEqual(again.json.entrance, r.json.entrance);
  });
});

test("mapId onto a painted map without overwrite errors and leaves the file byte-identical", async () => {
  await withServer(async ({ call, file }) => {
    const painted = JSON.parse(MAP1);
    painted.data[0] = 2816;
    const text = JSON.stringify(painted);
    await fs.writeFile(file("Map001.json"), text);
    const r = await call("generate_map", { kind: "dungeon", mapId: 1, profile: PROFILE, seed: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /overwrite/);
    assert.equal(await fs.readFile(file("Map001.json"), "utf8"), text);
  });
});

test("mapId onto an empty map that has an event is refused without overwrite", async () => {
  await withServer(async ({ call, file }) => {
    const m = JSON.parse(MAP1);
    m.events.push({ id: 1, name: "Keep", x: 1, y: 1, note: "", pages: [] });
    const text = JSON.stringify(m);
    await fs.writeFile(file("Map001.json"), text);
    const r = await call("generate_map", { kind: "dungeon", mapId: 1, profile: PROFILE, seed: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /overwrite/);
    assert.equal(await fs.readFile(file("Map001.json"), "utf8"), text);
  });
});

test("mapId onto an empty map generates in place, using the map's own size", async () => {
  await withServer(async ({ call, file }) => {
    const m = JSON.parse(MAP1);
    m.width = 30;
    m.height = 20;
    m.data = new Array(30 * 20 * 6).fill(0);
    await fs.writeFile(file("Map001.json"), JSON.stringify(m));
    const r = await call("generate_map", { kind: "dungeon", mapId: 1, profile: PROFILE, seed: 3 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.mapId, 1);
    const map = JSON.parse(await fs.readFile(file("Map001.json"), "utf8"));
    assert.equal(map.width, 30);
    assert.equal(map.displayName, "Town");
    assert.equal(map.events.filter(Boolean).length, 2);
    const infos = JSON.parse(await fs.readFile(file("MapInfos.json"), "utf8"));
    assert.equal(infos.length, 2, "an existing map is not registered again");
  });
});

test("overwrite:true regenerates a painted map and removes its old events", async () => {
  await withServer(async ({ call, file }) => {
    const m = JSON.parse(MAP1);
    m.width = 30;
    m.height = 20;
    m.data = new Array(30 * 20 * 6).fill(0);
    m.data[0] = 2816;
    m.data[30 * 20 * 3] = 77; // an upper layer tile
    m.events.push({ id: 1, name: "OldNpc", x: 1, y: 1, note: "", pages: [] });
    await fs.writeFile(file("Map001.json"), JSON.stringify(m));
    const r = await call("generate_map", { kind: "dungeon", mapId: 1, profile: PROFILE, seed: 5, overwrite: true });
    assert.equal(r.isError, false, r.text);
    const map = JSON.parse(await fs.readFile(file("Map001.json"), "utf8"));
    assert.deepEqual(map.events.filter(Boolean).map((e) => e.name), ["Entrance", "Exit"]);
    assert.equal(map.data[30 * 20 * 3], 0, "upper layers are reset");
  });
});

test("a profile whose wall is passable errors and writes nothing", async () => {
  await withServer(async ({ call, file }) => {
    const before = await fs.readFile(file("MapInfos.json"), "utf8");
    const r = await call("generate_map", gen({ profile: { floor: FLOOR, wall: FLOOR } }));
    assert.equal(r.isError, true);
    assert.match(r.text, /block/);
    assert.match(r.text, /walk/);
    assert.equal(await fs.readFile(file("MapInfos.json"), "utf8"), before);
    await assert.rejects(fs.access(file("Map002.json")));
  });
});

test("a profile using a sheet without an image errors and writes nothing", async () => {
  await withServer(async ({ call, file }) => {
    const r = await call("generate_map", gen({ profile: { floor: FLOOR, wall: { sheet: "A4", kind: 80 } } }));
    assert.equal(r.isError, true);
    assert.match(r.text, /image/);
    await assert.rejects(fs.access(file("Map002.json")));
  });
});

test("cave kind works", async () => {
  await withServer(async ({ call }) => {
    const r = await call("generate_map", gen({ kind: "cave" }));
    assert.equal(r.isError, false, r.text);
    assert.ok(r.json.reachability.expected > 0);
    assert.equal(r.json.reachability.reachable, r.json.reachability.expected);
  });
});

test("the default profile comes from suggestTileProfile and is reported", async () => {
  await withServer(async ({ call }) => {
    const r = await call("generate_map", gen({ profile: undefined }));
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.profileUsed.floor, FLOOR);
    assert.deepEqual(r.json.profileUsed.wall, { sheet: "B", index: 5 });
    assert.ok(r.json.profileNotes.length > 0);
    assert.equal(r.json.reachability.reachable, r.json.reachability.expected);
  });
});

test("create and mapId together is rejected, and so is neither", async () => {
  await withServer(async ({ call, file }) => {
    const both = await call("generate_map", gen({ mapId: 1 }));
    assert.equal(both.isError, true);
    assert.match(both.text, /exactly one/i);
    const neither = await call("generate_map", { kind: "dungeon", profile: PROFILE });
    assert.equal(neither.isError, true);
    assert.match(neither.text, /exactly one/i);
    await assert.rejects(fs.access(file("Map002.json")));
  });
});

test("chests: 3 creates exactly 3 events named Chest 1..3 on distinct floor cells", async () => {
  await withServer(async ({ call, file }) => {
    const r = await call("generate_map", gen({ markers: { chests: 3 } }));
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.chests.length, 3);
    const map = JSON.parse(await fs.readFile(file("Map002.json"), "utf8"));
    const events = map.events.filter(Boolean);
    assert.deepEqual(events.map((e) => e.name), ["Entrance", "Exit", "Chest 1", "Chest 2", "Chest 3"]);
    assert.deepEqual(events.map((e) => e.id), [1, 2, 3, 4, 5]);
    const cells = new Set(events.map((e) => `${e.x},${e.y}`));
    assert.equal(cells.size, 5);
    for (const c of r.json.chests) {
      assert.ok(Math.max(Math.abs(c.x - r.json.entrance.x), Math.abs(c.y - r.json.entrance.y)) > 1);
      assert.ok(Math.max(Math.abs(c.x - r.json.exit.x), Math.abs(c.y - r.json.exit.y)) > 1);
    }
  });
});

test("markers can be switched off", async () => {
  await withServer(async ({ call, file }) => {
    const r = await call("generate_map", gen({ markers: { entrance: false, exit: false, chests: 1 } }));
    assert.equal(r.isError, false, r.text);
    const map = JSON.parse(await fs.readFile(file("Map002.json"), "utf8"));
    assert.deepEqual(map.events.filter(Boolean).map((e) => e.name), ["Chest 1"]);
    assert.ok(r.json.entrance && r.json.exit, "coordinates are still returned");
  });
});

test("more chests than eligible cells creates as many as possible and notes the shortfall", async () => {
  await withServer(async ({ call }) => {
    const r = await call("generate_map", {
      kind: "cave", create: { name: "Tiny", width: 9, height: 9, tilesetId: 1 },
      profile: PROFILE, seed: 2, markers: { chests: 20 },
    });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.json.chests.length < 20);
    assert.match(r.json.notes.join("\n"), /chest/i);
  });
});

test("a map too small for a room errors clearly and writes nothing", async () => {
  await withServer(async ({ call, file }) => {
    const before = await fs.readFile(file("MapInfos.json"), "utf8");
    const r = await call("generate_map", gen({ create: { name: "Thin", width: 5, height: 5, tilesetId: 1 } }));
    assert.equal(r.isError, true);
    assert.match(r.text, /room/);
    assert.equal(await fs.readFile(file("MapInfos.json"), "utf8"), before);
    await assert.rejects(fs.access(file("Map002.json")));
  });
});

test("an unknown tileset is an error and writes nothing", async () => {
  await withServer(async ({ call, file }) => {
    const r = await call("generate_map", gen({ create: { name: "X", width: 20, height: 20, tilesetId: 9 } }));
    assert.equal(r.isError, true);
    assert.match(r.text, /[Tt]ileset 9/);
    await assert.rejects(fs.access(file("Map002.json")));
  });
});

test("generate_map before set_project returns the No project selected error", async () => {
  await withServer(async ({ call }) => {
    const r = await call("generate_map", gen());
    assert.equal(r.isError, true);
    assert.match(r.text, /No project selected/);
  }, { setProject: false });
});

test("inside an open changeset nothing reaches disk until commit", async () => {
  await withServer(async ({ call, file }) => {
    assert.equal((await call("begin_changeset", { label: "gen" })).isError, false);
    const r = await call("generate_map", gen());
    assert.equal(r.isError, false, r.text);
    await assert.rejects(fs.access(file("Map002.json")), "map file not on disk yet");
    assert.equal(await fs.readFile(file("MapInfos.json"), "utf8"), INFOS);
    const commit = await call("commit_changeset", {});
    assert.equal(commit.isError, false, commit.text);
    const map = JSON.parse(await fs.readFile(file("Map002.json"), "utf8"));
    assert.equal(map.width, 40);
    const infos = JSON.parse(await fs.readFile(file("MapInfos.json"), "utf8"));
    assert.equal(infos[2].name, "Crypt");
  });
});

// ---- final-review fixes ----

const dist = (name) => import(`../dist/${name}`);

/** Walkable cells of a saved map after blocking `blocked`: are all of them reachable from `from`? */
async function reachableAfterBlocking(map, from, blocked) {
  const { passableGrid } = await dist("passability.js");
  const walk = passableGrid(map, flags);
  const { width, height } = map;
  for (const c of blocked) walk[c.y * width + c.x] = 0;
  const seen = new Uint8Array(width * height);
  const queue = [from.y * width + from.x];
  seen[queue[0]] = 1;
  for (let h = 0; h < queue.length; h++) {
    const cur = queue[h];
    const x = cur % width;
    const nbrs = [x > 0 ? cur - 1 : -1, x < width - 1 ? cur + 1 : -1, cur - width, cur + width];
    for (const n of nbrs) {
      if (n >= 0 && n < width * height && walk[n] && !seen[n]) {
        seen[n] = 1;
        queue.push(n);
      }
    }
  }
  let total = 0;
  let reached = 0;
  for (let i = 0; i < width * height; i++) if (walk[i]) { total++; if (seen[i]) reached++; }
  return { total, reached, startWalkable: walk[from.y * width + from.x] === 1 };
}

test("chest markers never cut the walkable floor, and every marker has priorityType 0", async () => {
  await withServer(async ({ call, file }) => {
    const cases = [
      ["dungeon", 17, 13],
      ["dungeon", 40, 30],
      ["cave", 30, 30],
    ];
    let chestsSeen = 0;
    for (const [kind, width, height] of cases) {
      for (let seed = 1; seed <= 8; seed++) {
        const r = await call("generate_map", {
          kind, create: { name: `${kind}${seed}`, width, height, tilesetId: 1 }, profile: PROFILE, seed, markers: { chests: 20 },
        });
        assert.equal(r.isError, false, r.text);
        const map = JSON.parse(await fs.readFile(file(`Map${String(r.json.mapId).padStart(3, "0")}.json`), "utf8"));
        for (const e of map.events.filter(Boolean)) assert.equal(e.pages[0].priorityType, 0, e.name);
        const blocked = r.json.chests;
        chestsSeen += blocked.length;
        const res = await reachableAfterBlocking(map, r.json.entrance, blocked);
        assert.ok(res.startWalkable);
        assert.equal(res.reached, res.total, `${kind} ${width}x${height} seed ${seed}: chests cut off ${res.total - res.reached} cells`);
      }
    }
    assert.ok(chestsSeen > 100, `chests were created (${chestsSeen})`);
  });
});

test("marker ids are returned and match the saved events", async () => {
  await withServer(async ({ call, file }) => {
    const r = await call("generate_map", gen({ markers: { chests: 2 } }));
    assert.equal(r.isError, false, r.text);
    const map = JSON.parse(await fs.readFile(file("Map002.json"), "utf8"));
    const m = r.json.markers;
    for (const [marker, name] of [[m.entrance, "Entrance"], [m.exit, "Exit"], [m.chests[0], "Chest 1"], [m.chests[1], "Chest 2"]]) {
      const e = map.events[marker.eventId];
      assert.equal(e.name, name);
      assert.deepEqual({ x: e.x, y: e.y }, { x: marker.x, y: marker.y });
    }
    assert.deepEqual({ x: m.exit.x, y: m.exit.y }, r.json.exit);
    assert.deepEqual(m.chests.map(({ x, y }) => ({ x, y })), r.json.chests);
  });
});

test("connect_maps at the returned exit works with allowOverlap, and after delete_event without it", async () => {
  await withServer(async ({ call, file }) => {
    const g = await call("generate_map", gen());
    assert.equal(g.isError, false, g.text);
    const blocked = await call("connect_maps", {
      a: { mapId: 2, door: g.json.exit }, b: { mapId: 1, door: { x: 5, y: 5 } },
    });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /Exit/);
    const ok = await call("connect_maps", {
      a: { mapId: 2, door: g.json.exit }, b: { mapId: 1, door: { x: 5, y: 5 } }, allowOverlap: true,
    });
    assert.equal(ok.isError, false, ok.text);
    let map = JSON.parse(await fs.readFile(file("Map002.json"), "utf8"));
    assert.ok(map.events.some((e) => e && e.name.startsWith("To ") && e.x === g.json.exit.x && e.y === g.json.exit.y));

    const del = await call("delete_event", { mapId: 2, eventId: g.json.markers.entrance.eventId });
    assert.equal(del.isError, false, del.text);
    const viaDelete = await call("connect_maps", {
      a: { mapId: 2, door: g.json.entrance }, b: { mapId: 1, door: { x: 6, y: 6 } },
    });
    assert.equal(viaDelete.isError, false, viaDelete.text);
    map = JSON.parse(await fs.readFile(file("Map002.json"), "utf8"));
    assert.ok(map.events.some((e) => e && e.name.startsWith("To ") && e.x === g.json.entrance.x && e.y === g.json.entrance.y));
  });
});

test("create_event_from_template at a returned chest cell works with allowStack", async () => {
  await withServer(async ({ call, file }) => {
    const g = await call("generate_map", gen({ markers: { chests: 1 } }));
    assert.equal(g.isError, false, g.text);
    const at = g.json.chests[0];
    const refused = await call("create_event_from_template", { mapId: 2, ...at, template: "chest", reward: { gold: 5 } });
    assert.equal(refused.isError, true);
    const ok = await call("create_event_from_template", { mapId: 2, ...at, template: "chest", reward: { gold: 5 }, allowStack: true });
    assert.equal(ok.isError, false, ok.text);
    const map = JSON.parse(await fs.readFile(file("Map002.json"), "utf8"));
    assert.equal(map.events[ok.json.eventId].x, at.x);
  });
});

test("an existing map with events: [] gets Entrance as a non-zero event id", async () => {
  await withServer(async ({ call, file }) => {
    const m = JSON.parse(MAP1);
    m.width = 30;
    m.height = 20;
    m.data = new Array(30 * 20 * 6).fill(0);
    m.events = [];
    await fs.writeFile(file("Map001.json"), JSON.stringify(m));
    const r = await call("generate_map", { kind: "dungeon", mapId: 1, profile: PROFILE, seed: 3 });
    assert.equal(r.isError, false, r.text);
    const map = JSON.parse(await fs.readFile(file("Map001.json"), "utf8"));
    assert.equal(map.events[0], null);
    assert.equal(map.events[1].name, "Entrance");
    assert.equal(r.json.markers.entrance.eventId, 1);
  });
});

test("overwrite together with create is rejected and writes nothing", async () => {
  await withServer(async ({ call, file }) => {
    const r = await call("generate_map", gen({ overwrite: true }));
    assert.equal(r.isError, true);
    assert.match(r.text, /overwrite/);
    assert.equal(await fs.readFile(file("MapInfos.json"), "utf8"), INFOS);
    await assert.rejects(fs.access(file("Map002.json")));
  });
});

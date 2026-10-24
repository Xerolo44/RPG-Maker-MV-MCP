import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProjectError } from "../dist/project.js";
import { stampFile } from "../dist/stamps.js";
import { applyPaintOps } from "../dist/tiles.js";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const A2 = { sheet: "A2", kind: 16 };

function blank(width, height, tilesetId = 1, events = [null]) {
  return { width, height, tilesetId, displayName: "", events, data: new Array(width * height * 6).fill(0), note: "" };
}
const layerOf = (map, z) => map.data.slice(z * map.width * map.height, (z + 1) * map.width * map.height);

function event(id, name, x, y) {
  return { id, name, x, y, note: "keep", pages: [{ list: [{ code: 101, indent: 0, parameters: ["", 0, 0, 2] }, { code: 0, indent: 0, parameters: [] }] }] };
}

async function tempProject(maps) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-stamps-"));
  const data = path.join(dir, "data");
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(dir, "Game.rpgproject"), "RPGMV 1.6.2");
  const flags = new Array(8192).fill(0);
  const tileset = (id) => ({ id, mode: 1, name: `Set ${id}`, note: "", flags, tilesetNames: ["", "Test_A2", "", "", "", "Test_B", "", "", ""] });
  await fs.writeFile(path.join(data, "Tilesets.json"), JSON.stringify([null, tileset(1), tileset(2)]));
  await fs.writeFile(path.join(data, "System.json"), JSON.stringify({ gameTitle: "T", startMapId: 1 }));
  const infos = [null];
  for (const [i, map] of maps.entries()) {
    infos.push({ id: i + 1, name: `Map ${i + 1}`, parentId: 0, order: i + 1, expanded: false, scrollX: 0, scrollY: 0 });
    await fs.writeFile(path.join(data, `Map${String(i + 1).padStart(3, "0")}.json`), JSON.stringify(map));
  }
  await fs.writeFile(path.join(data, "MapInfos.json"), JSON.stringify(infos));
  return dir;
}

async function withServer(maps, fn, { setProject = true } = {}) {
  const dir = await tempProject(maps);
  const client = new Client({ name: "stamps-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "ignore" }));
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    return { isError: !!res.isError, text, json: !res.isError && /^[{[]/.test(text) ? JSON.parse(text) : null };
  };
  try {
    if (setProject) assert.equal((await call("set_project", { path: dir })).isError, false);
    const file = (name) => path.join(dir, "data", name);
    const readMap = async (n) => JSON.parse(await fs.readFile(file(`Map${String(n).padStart(3, "0")}.json`), "utf8"));
    await fn({ dir, call, file, readMap });
  } finally {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("stampFile rejects ../x, a/b, a\\b, C:x, CON, empty and 65-char names", () => {
  const root = path.join(os.tmpdir(), "proj");
  for (const bad of ["../x", "a/b", "a\\b", "C:x", "CON", "", "a".repeat(65), "..", "x.", "x ", "nul", "COM1 ", "Lpt9", "-x", " x", "a.json"]) {
    assert.throws(() => stampFile(root, bad), (err) => err instanceof ProjectError, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assert.equal(stampFile(root, "tree_1-a b"), path.join(root, ".mcp-stamps", "tree_1-a b.json"));
  assert.equal(stampFile(root, "a".repeat(64)), path.join(root, ".mcp-stamps", `${"a".repeat(64)}.json`));
  assert.equal(stampFile(root, "COM10"), path.join(root, ".mcp-stamps", "COM10.json"));
});

test("tools before a project is selected say so", async () => {
  await withServer([], async ({ call }) => {
    for (const [name, args] of [
      ["capture_stamp", { mapId: 1, x: 0, y: 0, width: 1, height: 1, name: "a" }],
      ["place_stamp", { mapId: 1, x: 0, y: 0, name: "a" }],
      ["list_stamps", {}],
    ]) {
      const r = await call(name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.text, /No project selected/, name);
    }
  }, { setProject: false });
});

test("capture then place on a second map reproduces B-sheet tile ids exactly", async () => {
  const src = blank(10, 10);
  const ids = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    const id = 10 + y * 3 + x;
    ids.push(id);
    src.data[(2 * 10 + 2 + y) * 10 + 3 + x] = id; // layer 2 at (3+x, 2+y)
  }
  src.data[(4 * 10 + 2) * 10 + 3] = 9; // shadow bits (layer 4)
  src.data[(5 * 10 + 3) * 10 + 4] = 77; // region (layer 5)
  const dst = blank(12, 12);
  dst.data[(0 * 12 + 6) * 12 + 6] = 1; // layer 0 cell inside the target area, gets overwritten by the zero
  await withServer([src, dst], async ({ call, readMap }) => {
    const cap = await call("capture_stamp", { mapId: 1, x: 3, y: 2, width: 3, height: 3, name: "Bits" });
    assert.equal(cap.isError, false, cap.text);
    const placed = await call("place_stamp", { mapId: 2, x: 6, y: 6, name: "Bits" });
    assert.equal(placed.isError, false, placed.text);
    const map = await readMap(2);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      assert.equal(map.data[(2 * 12 + 6 + y) * 12 + 6 + x], ids[y * 3 + x]);
    }
    assert.equal(map.data[(4 * 12 + 6) * 12 + 6], 9);
    assert.equal(map.data[(5 * 12 + 7) * 12 + 7], 77);
    assert.equal(map.data[(0 * 12 + 6) * 12 + 6], 0, "the stamp replaces the target on every layer");
    assert.equal(map.data.filter((v) => v !== 0).length, 11);
  });
});


test("placed events get fresh ids and offset coordinates", async () => {
  const src = blank(10, 10, 1, [null, event(1, "Inside", 4, 3), event(2, "Outside", 8, 8), event(3, "Edge", 5, 4)]);
  const dst = blank(12, 12, 1, [null, event(1, "Old", 0, 0), null, event(3, "Old3", 1, 1)]);
  await withServer([src, dst], async ({ dir, call, readMap }) => {
    const cap = await call("capture_stamp", { mapId: 1, x: 3, y: 3, width: 3, height: 2, name: "Ev" });
    assert.equal(cap.isError, false, cap.text);
    const stamp = JSON.parse(await fs.readFile(path.join(dir, ".mcp-stamps", "Ev.json"), "utf8"));
    assert.deepEqual(stamp.events.map((e) => [e.dx, e.dy]), [[1, 0], [2, 1]]);
    assert.equal("id" in stamp.events[0].event, false, "stored events carry no id");
    assert.equal(stamp.layers.length, 6);
    assert.ok(stamp.layers.every((l) => l.length === 6));

    const placed = await call("place_stamp", { mapId: 2, x: 7, y: 8, name: "Ev" });
    assert.equal(placed.isError, false, placed.text);
    assert.deepEqual(placed.json.eventIds, [4, 5]);
    const map = await readMap(2);
    assert.equal(map.events[0], null);
    assert.equal(map.events[2], null, "existing holes are untouched");
    const [a, b] = [map.events[4], map.events[5]];
    assert.deepEqual([a.id, a.name, a.x, a.y, a.note], [4, "Inside", 8, 8, "keep"]);
    assert.deepEqual([b.id, b.name, b.x, b.y], [5, "Edge", 9, 9]);
    assert.deepEqual(a.pages, src.events[1].pages);
    assert.equal(map.events.length, 6);
  });
});

test("includeEvents false neither captures nor places events", async () => {
  const src = blank(6, 6, 1, [null, event(1, "E", 1, 1)]);
  const dst = blank(6, 6);
  await withServer([src, dst], async ({ dir, call, readMap }) => {
    assert.equal((await call("capture_stamp", { mapId: 1, x: 0, y: 0, width: 3, height: 3, name: "NoEv", includeEvents: false })).isError, false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, ".mcp-stamps", "NoEv.json"), "utf8")).events, []);
    assert.equal((await call("capture_stamp", { mapId: 1, x: 0, y: 0, width: 3, height: 3, name: "WithEv" })).isError, false);
    const r = await call("place_stamp", { mapId: 2, x: 0, y: 0, name: "WithEv", includeEvents: false });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual((await readMap(2)).events, [null]);
  });
});

test("place outside the bounds errors and does not modify the map", async () => {
  const src = blank(10, 10);
  src.data[2 * 100 + 11] = 12;
  const dst = blank(8, 8);
  await withServer([src, dst], async ({ call, file }) => {
    assert.equal((await call("capture_stamp", { mapId: 1, x: 0, y: 0, width: 4, height: 4, name: "Big" })).isError, false);
    const before = await fs.readFile(file("Map002.json"));
    for (const [x, y] of [[5, 0], [0, 5], [-1, 0]]) {
      const r = await call("place_stamp", { mapId: 2, x, y, name: "Big" });
      assert.equal(r.isError, true, `(${x}, ${y})`);
    }
    assert.match((await call("place_stamp", { mapId: 2, x: 5, y: 0, name: "Big" })).text, /not fully inside/);
    assert.ok(before.equals(await fs.readFile(file("Map002.json"))), "map file is byte-identical");
    assert.equal((await call("place_stamp", { mapId: 2, x: 4, y: 4, name: "Big" })).isError, false, "a placement that exactly fits works");
  });
});

test("capture outside the map, with bad sizes or names errors", async () => {
  await withServer([blank(10, 10)], async ({ dir, call }) => {
    const base = { mapId: 1, x: 0, y: 0, width: 2, height: 2, name: "ok" };
    assert.equal((await call("capture_stamp", { ...base, x: 9 })).isError, true);
    assert.equal((await call("capture_stamp", { ...base, width: 0 })).isError, true);
    assert.equal((await call("capture_stamp", { ...base, width: 65 })).isError, true);
    assert.equal((await call("capture_stamp", { ...base, name: "../evil" })).isError, true);
    assert.equal((await call("capture_stamp", { ...base, name: "nul" })).isError, true);
    assert.equal((await call("capture_stamp", { ...base, mapId: 9 })).isError, true);
    await assert.rejects(fs.access(path.join(dir, ".mcp-stamps")), "nothing was created");
  });
});

test("different tileset is rejected", async () => {
  await withServer([blank(6, 6, 1), blank(6, 6, 2)], async ({ call, file }) => {
    assert.equal((await call("capture_stamp", { mapId: 1, x: 0, y: 0, width: 2, height: 2, name: "T1" })).isError, false);
    const before = await fs.readFile(file("Map002.json"));
    const r = await call("place_stamp", { mapId: 2, x: 0, y: 0, name: "T1" });
    assert.equal(r.isError, true);
    assert.match(r.text, /tileset 1/);
    assert.match(r.text, /tileset 2/);
    assert.ok(before.equals(await fs.readFile(file("Map002.json"))));
  });
});

test("placing a missing stamp errors", async () => {
  await withServer([blank(6, 6)], async ({ call }) => {
    const r = await call("place_stamp", { mapId: 1, x: 0, y: 0, name: "nothing" });
    assert.equal(r.isError, true);
    assert.match(r.text, /nothing/);
  });
});

test("autotile edges are recomputed against existing neighbours", async () => {
  const src = blank(10, 10);
  applyPaintOps(src, [{ type: "rect", tile: A2, layer: 0, x: 1, y: 1, width: 3, height: 3 }]);
  const dst = blank(10, 10);
  applyPaintOps(dst, [{ type: "rect", tile: A2, layer: 0, x: 6, y: 3, width: 3, height: 3 }]);
  const expected = blank(10, 10);
  applyPaintOps(expected, [{ type: "rect", tile: A2, layer: 0, x: 3, y: 3, width: 6, height: 3 }]);
  await withServer([src, dst], async ({ call, readMap }) => {
    assert.equal((await call("capture_stamp", { mapId: 1, x: 1, y: 1, width: 3, height: 3, name: "Pond" })).isError, false);
    const r = await call("place_stamp", { mapId: 2, x: 3, y: 3, name: "Pond" });
    assert.equal(r.isError, false, r.text);
    const map = await readMap(2);
    assert.deepEqual(layerOf(map, 0), layerOf(expected, 0), "the two blocks now read as one 6x3 block");
    assert.notEqual(map.data[3 * 10 + 3], 0);
  });
});

test("a stamp that removes an autotile cell reshapes the neighbours outside it", async () => {
  const src = blank(10, 10);
  const dst = blank(10, 10);
  applyPaintOps(dst, [{ type: "rect", tile: A2, layer: 0, x: 2, y: 2, width: 5, height: 5 }]);
  const expected = blank(10, 10);
  applyPaintOps(expected, [
    { type: "rect", tile: A2, layer: 0, x: 2, y: 2, width: 5, height: 5 },
    { type: "cells", tile: 0, layer: 0, cells: [{ x: 2, y: 4 }] },
  ]);
  await withServer([src, dst], async ({ call, readMap }) => {
    assert.equal((await call("capture_stamp", { mapId: 1, x: 0, y: 0, width: 1, height: 1, name: "Hole" })).isError, false);
    assert.equal((await call("place_stamp", { mapId: 2, x: 2, y: 4, name: "Hole" })).isError, false);
    assert.deepEqual(layerOf(await readMap(2), 0), layerOf(expected, 0));
  });
});

test("autotile stamps cut from inside a larger block blend with the target like a fresh paint", async () => {
  // The captured window sits inside a bigger block, so its edge cells carry "interior" shapes.
  const src = blank(12, 12);
  applyPaintOps(src, [{ type: "rect", tile: A2, layer: 0, x: 1, y: 1, width: 8, height: 8 }]);
  const dst = blank(12, 12);
  const expected = blank(12, 12);
  applyPaintOps(expected, [{ type: "rect", tile: A2, layer: 0, x: 5, y: 5, width: 3, height: 3 }]);
  await withServer([src, dst], async ({ call, readMap }) => {
    assert.equal((await call("capture_stamp", { mapId: 1, x: 3, y: 3, width: 3, height: 3, name: "Cut" })).isError, false);
    assert.equal((await call("place_stamp", { mapId: 2, x: 5, y: 5, name: "Cut" })).isError, false);
    assert.deepEqual(layerOf(await readMap(2), 0), layerOf(expected, 0));
  });
});

test("list_stamps returns captured names", async () => {
  await withServer([blank(8, 8, 1, [null, event(1, "E", 0, 0)])], async ({ call }) => {
    const empty = await call("list_stamps", {});
    assert.equal(empty.isError, false, empty.text);
    assert.deepEqual(empty.json.stamps, []);
    await call("capture_stamp", { mapId: 1, x: 0, y: 0, width: 4, height: 2, name: "beta" });
    await call("capture_stamp", { mapId: 1, x: 0, y: 0, width: 2, height: 2, name: "Alpha 1" });
    const r = await call("list_stamps", {});
    assert.deepEqual(r.json.stamps.map((s) => s.name), ["Alpha 1", "beta"]);
    assert.deepEqual(r.json.stamps[1], { name: "beta", width: 4, height: 2, tilesetId: 1, events: 1 });
  });
});

test("capture from a map with events [null] works", async () => {
  const src = blank(5, 5);
  src.data[2 * 25 + 6] = 33;
  await withServer([src], async ({ call, dir }) => {
    const r = await call("capture_stamp", { mapId: 1, x: 1, y: 1, width: 2, height: 2, name: "NoEvents" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.events, 0);
    const stamp = JSON.parse(await fs.readFile(path.join(dir, ".mcp-stamps", "NoEvents.json"), "utf8"));
    assert.deepEqual(stamp.layers[2], [33, 0, 0, 0]);
    assert.equal(stamp.tilesetId, 1);
  });
});

test("an event already standing in the target refuses the whole placement", async () => {
  const src = blank(6, 6, 1, [null, event(1, "S", 1, 1)]);
  src.data[2 * 36 + 7] = 21;
  const dst = blank(6, 6, 1, [null, event(1, "Taken", 3, 3)]);
  await withServer([src, dst], async ({ call, file, readMap }) => {
    assert.equal((await call("capture_stamp", { mapId: 1, x: 0, y: 0, width: 2, height: 2, name: "Clash" })).isError, false);
    const before = await fs.readFile(file("Map002.json"));
    const r = await call("place_stamp", { mapId: 2, x: 2, y: 2, name: "Clash" });
    assert.equal(r.isError, true);
    assert.match(r.text, /\(3, 3\)/);
    assert.match(r.text, /includeEvents: false/);
    assert.ok(before.equals(await fs.readFile(file("Map002.json"))), "nothing was written");
    const ok = await call("place_stamp", { mapId: 2, x: 2, y: 2, name: "Clash", includeEvents: false });
    assert.equal(ok.isError, false, ok.text);
    assert.equal((await readMap(2)).data[2 * 36 + 3 * 6 + 3], 21);
  });
});

test("capture refuses to replace a stamp unless overwrite is true", async () => {
  await withServer([blank(6, 6)], async ({ call, dir }) => {
    const args = { mapId: 1, x: 0, y: 0, width: 2, height: 2, name: "Same" };
    assert.equal((await call("capture_stamp", args)).isError, false);
    const again = await call("capture_stamp", { ...args, width: 3 });
    assert.equal(again.isError, true);
    assert.match(again.text, /overwrite: true/);
    const file = path.join(dir, ".mcp-stamps", "Same.json");
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).width, 2);
    assert.equal((await call("capture_stamp", { ...args, width: 3, overwrite: true })).isError, false);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).width, 3);
  });
});

test("stamps captured in an open changeset stay off disk until commit", async () => {
  const src = blank(6, 6);
  src.data[2 * 36 + 7] = 14;
  const dst = blank(6, 6);
  await withServer([src, dst], async ({ dir, call, readMap, file }) => {
    const stampPath = path.join(dir, ".mcp-stamps", "Staged.json");
    const exists = () => fs.access(stampPath).then(() => true, () => false);
    assert.equal((await call("begin_changeset", { label: "stamps" })).isError, false);
    assert.equal((await call("capture_stamp", { mapId: 1, x: 0, y: 0, width: 3, height: 3, name: "Staged" })).isError, false);
    assert.equal(await exists(), false, "stamp file is only staged");
    assert.deepEqual((await call("list_stamps", {})).json.stamps, [], "staged stamps are not listed");
    const mapBefore = await fs.readFile(file("Map002.json"));
    const placed = await call("place_stamp", { mapId: 2, x: 1, y: 1, name: "Staged" });
    assert.equal(placed.isError, false, placed.text);
    assert.ok(mapBefore.equals(await fs.readFile(file("Map002.json"))), "map is only staged");
    assert.equal((await call("commit_changeset", {})).isError, false);
    assert.equal(await exists(), true);
    assert.equal((await readMap(2)).data[2 * 36 + 2 * 6 + 2], 14);
    assert.equal((await call("list_stamps", {})).json.stamps.length, 1);
  });
});

async function damagedStampTest(content) {
  await withServer([blank(6, 6)], async ({ call, dir, readMap, file }) => {
    assert.equal((await call("capture_stamp", { mapId: 1, x: 0, y: 0, width: 2, height: 2, name: "Bad" })).isError, false);
    const stampPath = path.join(dir, ".mcp-stamps", "Bad.json");
    const stamp = JSON.parse(await fs.readFile(stampPath, "utf8"));
    await fs.writeFile(stampPath, typeof content === "function" ? JSON.stringify(content(stamp)) : content);
    const before = await fs.readFile(file("Map001.json"));
    const r = await call("place_stamp", { mapId: 1, x: 0, y: 0, name: "Bad" });
    assert.equal(r.isError, true);
    assert.match(r.text, /damaged/);
    assert.ok(before.equals(await fs.readFile(file("Map001.json"))));
  });
}

test("a stamp file holding a literal null is reported as damaged", () => damagedStampTest("null"));

test("a stamp with an out-of-range shadow value (layer 4) is reported as damaged", () =>
  damagedStampTest((s) => ((s.layers[4][0] = 16), s)));

test("a stamp with an out-of-range region value (layer 5) is reported as damaged", () =>
  damagedStampTest((s) => ((s.layers[5][0] = 256), s)));

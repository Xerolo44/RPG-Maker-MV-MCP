import assert from "node:assert/strict";
import test from "node:test";
import { generateCave } from "../dist/gen/cave.js";
import { generateDungeon } from "../dist/gen/dungeon.js";
import { layoutToPaintOps, verifyReachable } from "../dist/gen/materialize.js";
import { applyPaintOps, autotileId, autotileKind, LAYER_COUNT } from "../dist/tiles.js";

// Synthetic tileset: A2 kind 16 floor (walkable), A4 kind 88 wall side and A4 kind 80 wall top
// (both blocking), B #5 a blocking decor tile.
const FLOOR = 16;
const WALL = 88;
const WALL_TOP = 80;
const DECOR_ID = 5;
const flags = new Array(8192).fill(0);
for (const kind of [WALL, WALL_TOP]) for (let s = 0; s < 48; s++) flags[autotileId(kind, s)] = 0x0f;
flags[DECOR_ID] = 0x0f;

const plain = { floor: { sheet: "A2", kind: FLOOR }, wall: { sheet: "A4", kind: WALL }, wallTop: { sheet: "A4", kind: WALL_TOP } };
const withDecor = { ...plain, decor: [{ tile: { sheet: "B", index: DECOR_ID }, weight: 1 }] };

const blankMap = (width, height) => ({ width, height, data: new Array(width * height * LAYER_COUNT).fill(0) });
const at = (map, x, y, z) => map.data[(z * map.height + y) * map.width + x];
const paint = (layout, profile, seed) => {
  const map = blankMap(layout.width, layout.height);
  applyPaintOps(map, layoutToPaintOps(layout, profile, seed));
  return map;
};
const decorCells = (map) => {
  const cells = [];
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (at(map, x, y, 2) === DECOR_ID) cells.push({ x, y });
  return cells;
};

/** Hand-made layout from rows of "#" (wall) and "." (floor). */
function layoutFrom(rows, entrance, exit) {
  const height = rows.length;
  const width = rows[0].length;
  const floor = new Uint8Array(width * height);
  rows.forEach((row, y) => [...row].forEach((c, x) => (floor[y * width + x] = c === "." ? 1 : 0)));
  return { width, height, floor, rooms: [], entrance, exit };
}

const room = layoutFrom(
  [
    "##########",
    "#....#####",
    "#....#...#",
    "#........#",
    "#....#####",
    "##########",
  ],
  { x: 1, y: 1 },
  { x: 8, y: 2 },
);

const dungeons = [1, 2, 3, 4, 5].map((seed) => generateDungeon({ width: 40, height: 30, seed }));
const caves = [1, 2, 3, 4, 5].map((seed) => generateCave({ width: 30, height: 24, seed }));

test("ops paint every floor cell with the floor tile", () => {
  for (const layout of [room, dungeons[0], caves[0]]) {
    const map = paint(layout, plain, 1);
    for (let y = 0; y < layout.height; y++) {
      for (let x = 0; x < layout.width; x++) {
        const kind = autotileKind(at(map, x, y, 0));
        if (layout.floor[y * layout.width + x]) assert.equal(kind, FLOOR, `floor at ${x},${y}`);
        else assert.ok(kind === WALL || kind === WALL_TOP, `wall at ${x},${y} is kind ${kind}`);
      }
    }
  }
});

test("wall faces only appear south of floor-adjacent wall cells", () => {
  for (const layout of [room, ...dungeons, ...caves]) {
    const { width, height, floor } = layout;
    const map = paint(layout, plain, 1);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const face = !floor[i] && y + 1 < height && floor[i + width] === 1;
        assert.equal(autotileKind(at(map, x, y, 0)) === WALL, face, `cell ${x},${y}`);
      }
    }
  }
});

test("without a wallTop the whole wall uses the wall tile", () => {
  const { wallTop, ...noTop } = plain;
  const map = paint(room, noTop, 1);
  for (let i = 0; i < room.floor.length; i++) {
    if (!room.floor[i]) assert.equal(autotileKind(map.data[i]), WALL);
  }
});

test("decor never lands on entrance or exit", () => {
  let placed = 0;
  for (const layout of [...dungeons, ...caves]) {
    const cells = decorCells(paint(layout, withDecor, 3));
    placed += cells.length;
    for (const c of cells) {
      for (const p of [layout.entrance, layout.exit]) {
        assert.ok(Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y)) > 1, `decor ${c.x},${c.y} next to ${p.x},${p.y}`);
      }
    }
  }
  assert.ok(placed > 0, "some decor was placed");
});

test("decor tiles are interior and never 8-adjacent", () => {
  for (const layout of [...dungeons, ...caves]) {
    const { width, floor } = layout;
    const cells = decorCells(paint(layout, withDecor, 9));
    for (const c of cells) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) assert.equal(floor[(c.y + dy) * width + c.x + dx], 1, `decor ${c.x},${c.y} is not interior`);
      }
    }
    for (const a of cells) {
      for (const b of cells) {
        if (a !== b) assert.ok(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) > 1, `decor ${a.x},${a.y} touches ${b.x},${b.y}`);
      }
    }
  }
});

test("decor density is about 3% and weights pick between tiles", () => {
  const profile = { ...plain, decor: [{ tile: { sheet: "B", index: 5 }, weight: 3 }, { tile: { sheet: "B", index: 6 }, weight: 1 }] };
  const layout = generateCave({ width: 120, height: 90, seed: 4, fillPercent: 35 });
  const map = paint(layout, profile, 2);
  let five = 0;
  let six = 0;
  for (let i = 0; i < layout.width * layout.height; i++) {
    const id = map.data[2 * layout.width * layout.height + i];
    if (id === 5) five++;
    else if (id === 6) six++;
  }
  const floorCells = layout.floor.reduce((n, v) => n + v, 0);
  const share = (five + six) / floorCells;
  assert.ok(share > 0.01 && share < 0.04, `decor share ${share}`);
  assert.ok(five > six && six > 0, `weights 3:1 gave ${five}:${six}`);
});

test("same seed same ops, one cells op per distinct tile", () => {
  const layout = dungeons[1];
  const a = layoutToPaintOps(layout, withDecor, 42);
  assert.deepEqual(layoutToPaintOps(layout, withDecor, 42), a);
  assert.notDeepEqual(layoutToPaintOps(layout, withDecor, 43), a);
  assert.deepEqual(a[0], { type: "rect", tile: plain.wallTop, layer: 0, x: 0, y: 0, width: layout.width, height: layout.height });
  const cellsOps = a.filter((op) => op.type === "cells");
  const tiles = cellsOps.map((op) => JSON.stringify(op.tile));
  assert.equal(new Set(tiles).size, tiles.length);
  for (const op of cellsOps) {
    const order = op.cells.map((c) => c.y * layout.width + c.x);
    assert.deepEqual(order, [...order].sort((p, q) => p - q), "cells are row-major");
  }
});

test("verifyReachable reports an enclosed floor cell as unreachable", () => {
  const layout = layoutFrom(
    [
      "#######",
      "#...#.#",
      "#...###",
      "#######",
    ],
    { x: 1, y: 1 },
    { x: 3, y: 2 },
  );
  const map = paint(layout, plain, 1);
  assert.deepEqual(verifyReachable(map, flags, layout.entrance, layout), { reachable: 6, expected: 7, unreachable: [{ x: 5, y: 1 }] });
  assert.deepEqual(verifyReachable(map, flags, { x: 0, y: 0 }, layout).reachable, 0);
  assert.equal(verifyReachable(map, flags, { x: 0, y: 0 }, layout).unreachable.length, 7);
});

test("blocking decor never disconnects generated dungeons and caves", () => {
  for (const layout of [...dungeons, ...caves]) {
    for (const seed of [1, 2, 3]) {
      const map = paint(layout, withDecor, seed);
      const result = verifyReachable(map, flags, layout.entrance, layout);
      const floorCells = layout.floor.reduce((n, v) => n + v, 0);
      assert.equal(result.expected, floorCells - decorCells(map).length);
      assert.equal(result.reachable, result.expected);
      assert.deepEqual(result.unreachable, []);
    }
  }
});

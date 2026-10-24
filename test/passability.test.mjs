import assert from "node:assert/strict";
import test from "node:test";
import { floorWalkable, passableGrid, wallBlocking } from "../dist/passability.js";

// 2x1 map, 6 layers: data index = (z * height + y) * width + x.
const map = (cells) => {
  const data = new Array(6 * 2).fill(0);
  for (const [z, x, id] of cells) data[z * 2 + x] = id;
  return { width: 2, height: 1, data };
};

test("a cell with a 0x0f tile is blocked", () => {
  const flags = [0, 0x0f];
  assert.deepEqual([...passableGrid(map([[0, 0, 1]]), flags)], [0, 1]);
});

test("a star-flag (0x10) tile on top is transparent and the tile below decides", () => {
  const flags = [0, 0x0f, 0x10];
  assert.deepEqual([...passableGrid(map([[0, 0, 1], [3, 0, 2]]), flags)], [0, 1]);
});

test("an empty cell is walkable", () => {
  assert.deepEqual([...passableGrid(map([]), [0])], [1, 1]);
});

test("tile ids beyond the flags array are walkable", () => {
  assert.deepEqual([...passableGrid(map([[0, 0, 99]]), [0, 0x0f])], [1, 1]);
});

test("layer 3 outranks layer 0", () => {
  const flags = [0, 0x0f, 0];
  assert.deepEqual([...passableGrid(map([[0, 0, 1], [3, 0, 2]]), flags)], [1, 1]);
  assert.deepEqual([...passableGrid(map([[0, 0, 2], [3, 0, 1]]), flags)], [0, 1]);
});

test("floorWalkable and wallBlocking follow passableGrid's rule", () => {
  for (const [flag, walk, block] of [[0, true, false], [0x01, false, true], [0x0e, false, true], [0x0f, false, true], [0x10, true, false], [0x1f, false, false]]) {
    assert.equal(floorWalkable(flag), walk, `floorWalkable(0x${flag.toString(16)})`);
    assert.equal(wallBlocking(flag), block, `wallBlocking(0x${flag.toString(16)})`);
  }
});

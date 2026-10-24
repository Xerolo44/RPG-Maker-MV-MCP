import assert from "node:assert/strict";
import test from "node:test";
import { floodDistances, isFullyConnected, farthestFrom } from "../dist/gen/layout.js";

/** Builds a layout from rows of "#" (wall) and "." (floor). */
function layoutFrom(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const floor = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) floor[y * width + x] = rows[y][x] === "." ? 1 : 0;
  }
  return { width, height, floor, rooms: [], entrance: { x: 0, y: 0 }, exit: { x: 0, y: 0 } };
}

test("distances count 4-neighbour steps on a corridor", () => {
  const layout = layoutFrom(["#####", "#...#", "#####"]);
  const dist = floodDistances(layout, { x: 1, y: 1 });
  assert.ok(dist instanceof Int32Array);
  assert.equal(dist[1 * 5 + 1], 0);
  assert.equal(dist[1 * 5 + 2], 1);
  assert.equal(dist[1 * 5 + 3], 2);
  // a diagonal is two steps, not one
  const open = layoutFrom(["...", "...", "..."]);
  assert.equal(floodDistances(open, { x: 0, y: 0 })[2 * 3 + 2], 4);
});

test("unreachable floor cells are -1", () => {
  const layout = layoutFrom(["..#.."]);
  const dist = floodDistances(layout, { x: 0, y: 0 });
  assert.equal(dist[1], 1);
  assert.equal(dist[2], -1); // wall
  assert.equal(dist[3], -1); // floor cut off by the wall
  assert.equal(dist[4], -1);
  // starting on a wall or off the grid reaches nothing
  assert.ok(floodDistances(layout, { x: 2, y: 0 }).every((d) => d === -1));
  assert.ok(floodDistances(layout, { x: 9, y: 9 }).every((d) => d === -1));
});

test("isFullyConnected true for one blob, false for two", () => {
  assert.equal(isFullyConnected(layoutFrom(["###", "#.#", "#.#", "###"])), true);
  assert.equal(isFullyConnected(layoutFrom(["#.#.#"])), false);
  assert.equal(isFullyConnected(layoutFrom(["###", "###"])), true); // no floor, vacuously connected
});

test("farthestFrom returns the end of a corridor", () => {
  const layout = layoutFrom(["#######", "#.....#", "#######"]);
  assert.deepEqual(farthestFrom(layout, { x: 1, y: 1 }), { x: 5, y: 1 });
  assert.deepEqual(farthestFrom(layout, { x: 5, y: 1 }), { x: 1, y: 1 });
  // a start with nothing reachable returns the start itself
  assert.deepEqual(farthestFrom(layout, { x: 0, y: 0 }), { x: 0, y: 0 });
});

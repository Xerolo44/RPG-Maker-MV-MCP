import assert from "node:assert/strict";
import test from "node:test";
import { generateDungeon } from "../dist/gen/dungeon.js";
import { GenError, floodDistances, isFullyConnected } from "../dist/gen/layout.js";

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

test("same seed gives identical floor masks", () => {
  const a = generateDungeon({ width: 40, height: 30, seed: 7 });
  const b = generateDungeon({ width: 40, height: 30, seed: 7 });
  assert.ok(same(a.floor, b.floor));
  assert.deepEqual(a.rooms, b.rooms);
  assert.deepEqual(a.entrance, b.entrance);
  assert.deepEqual(a.exit, b.exit);
});

test("different seeds give different masks", () => {
  const a = generateDungeon({ width: 40, height: 30, seed: 1 });
  const b = generateDungeon({ width: 40, height: 30, seed: 2 });
  assert.ok(!same(a.floor, b.floor));
});

test("a 40x30 map has at least 3 rooms", () => {
  const layout = generateDungeon({ width: 40, height: 30, seed: 3 });
  assert.ok(layout.rooms.length >= 3, `got ${layout.rooms.length} rooms`);
  assert.equal(layout.floor.length, 40 * 30);
});

test("every floor cell is reachable from the entrance", () => {
  for (let seed = 1; seed <= 50; seed++) {
    for (let size = 15; size <= 60; size += 5) {
      // Square, plus a non-square variant derived from the same size.
      for (const [width, height] of [[size, size], [size, 15 + ((size * 7) % 46)]]) {
        const layout = generateDungeon({ width, height, seed });
        const dist = floodDistances(layout, layout.entrance);
        for (let i = 0; i < layout.floor.length; i++) {
          if (layout.floor[i]) assert.ok(dist[i] >= 0, `unreachable cell ${i} (seed ${seed}, ${width}x${height})`);
        }
        assert.ok(isFullyConnected(layout));
      }
    }
  }
});

test("the border ring is never floor", () => {
  for (let seed = 1; seed <= 30; seed++) {
    for (const [width, height] of [[15, 15], [40, 30], [23, 61], [60, 17]]) {
      const { floor } = generateDungeon({ width, height, seed });
      for (let x = 0; x < width; x++) {
        assert.equal(floor[x], 0);
        assert.equal(floor[(height - 1) * width + x], 0);
      }
      for (let y = 0; y < height; y++) {
        assert.equal(floor[y * width], 0);
        assert.equal(floor[y * width + width - 1], 0);
      }
    }
  }
});

test("entrance and exit are floor cells and differ", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const layout = generateDungeon({ width: 30, height: 30, seed });
    const at = (p) => layout.floor[p.y * layout.width + p.x];
    assert.equal(at(layout.entrance), 1);
    assert.equal(at(layout.exit), 1);
    assert.ok(layout.entrance.x !== layout.exit.x || layout.entrance.y !== layout.exit.y);
  }
});

test("rooms respect minRoom and maxRoom", () => {
  const layout = generateDungeon({ width: 80, height: 60, seed: 9, minRoom: 6, maxRoom: 9 });
  for (const r of layout.rooms) {
    assert.ok(r.width >= 6 && r.width <= 9 && r.height >= 6 && r.height <= 9, JSON.stringify(r));
  }
});

test("throws GenError for a 6x6 map with minRoom 5", () => {
  assert.throws(() => generateDungeon({ width: 6, height: 6, seed: 1, minRoom: 5 }), GenError);
});

test("throws GenError when the map fits only one room, or the size is unsupported", () => {
  assert.throws(() => generateDungeon({ width: 10, height: 10, seed: 1 }), GenError);
  assert.throws(() => generateDungeon({ width: 4, height: 40, seed: 1 }), GenError);
  assert.throws(() => generateDungeon({ width: 300, height: 40, seed: 1 }), GenError);
  assert.throws(() => generateDungeon({ width: 40, height: 40, seed: 1, minRoom: 8, maxRoom: 5 }), GenError);
});

test("256x256 generates in under 3000 ms", () => {
  // Design target is about 1 s on a normal machine; the assertion leaves headroom for slow CI runners.
  const start = Date.now();
  const layout = generateDungeon({ width: 256, height: 256, seed: 1 });
  const elapsed = Date.now() - start;
  assert.ok(layout.rooms.length > 10);
  assert.ok(elapsed < 3000, `took ${elapsed} ms`);
});

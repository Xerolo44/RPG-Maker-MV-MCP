import assert from "node:assert/strict";
import test from "node:test";
import { generateCave } from "../dist/gen/cave.js";
import { GenError, isFullyConnected } from "../dist/gen/layout.js";

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const count = (floor) => floor.reduce((n, v) => n + v, 0);
const borderIsWall = (layout) => {
  const { width, height, floor } = layout;
  for (let x = 0; x < width; x++) if (floor[x] || floor[(height - 1) * width + x]) return false;
  for (let y = 0; y < height; y++) if (floor[y * width] || floor[y * width + width - 1]) return false;
  return true;
};

test("same seed gives identical layouts", () => {
  const a = generateCave({ width: 50, height: 40, seed: 7 });
  const b = generateCave({ width: 50, height: 40, seed: 7 });
  assert.ok(same(a.floor, b.floor));
  assert.deepEqual(a.entrance, b.entrance);
  assert.deepEqual(a.exit, b.exit);
  assert.deepEqual(a.rooms, []);
});

test("different seeds give different masks", () => {
  const a = generateCave({ width: 50, height: 40, seed: 1 });
  const b = generateCave({ width: 50, height: 40, seed: 2 });
  assert.ok(!same(a.floor, b.floor));
});

test("connected for seeds 1-50", () => {
  for (let seed = 1; seed <= 50; seed++) {
    const layout = generateCave({ width: 60, height: 45, seed });
    assert.equal(layout.floor.length, 60 * 45);
    assert.ok(isFullyConnected(layout), `seed ${seed}`);
  }
});

test("floor ratio is at least minFloorRatio", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const layout = generateCave({ width: 60, height: 45, seed, minFloorRatio: 0.4 });
    assert.ok(count(layout.floor) / (60 * 45) >= 0.4, `seed ${seed}`);
  }
  const dflt = generateCave({ width: 60, height: 45, seed: 3 });
  assert.ok(count(dflt.floor) / (60 * 45) >= 0.3);
});

test("border is wall", () => {
  for (let seed = 1; seed <= 20; seed++) {
    for (const [width, height] of [[30, 30], [47, 23], [23, 61]]) {
      assert.ok(borderIsWall(generateCave({ width, height, seed })), `${width}x${height} seed ${seed}`);
    }
  }
});

test("entrance and exit are distinct floor cells, entrance near the top-left", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const layout = generateCave({ width: 40, height: 40, seed });
    const at = (p) => layout.floor[p.y * layout.width + p.x];
    assert.equal(at(layout.entrance), 1);
    assert.equal(at(layout.exit), 1);
    assert.ok(layout.entrance.x !== layout.exit.x || layout.entrance.y !== layout.exit.y);
    // No floor cell has a smaller x + y than the entrance.
    for (let i = 0; i < layout.floor.length; i++) {
      if (layout.floor[i]) assert.ok((i % 40) + Math.floor(i / 40) >= layout.entrance.x + layout.entrance.y, `seed ${seed}`);
    }
  }
});

test("throws GenError when fillPercent is 95", () => {
  assert.throws(() => generateCave({ width: 40, height: 40, seed: 1, fillPercent: 95 }), GenError);
});

test("throws GenError for out-of-range options", () => {
  const base = { width: 40, height: 40, seed: 1 };
  for (const bad of [
    { width: 4 }, { width: 257 }, { height: 4.5 }, { height: 300 }, { width: Number.NaN },
    { fillPercent: -1 }, { fillPercent: 101 }, { fillPercent: Number.NaN },
    { smoothing: -1 }, { smoothing: 1.5 }, { smoothing: 21 },
    { minFloorRatio: 0 }, { minFloorRatio: 1.1 }, { minFloorRatio: -0.2 }, { minFloorRatio: Number.NaN },
  ]) {
    assert.throws(() => generateCave({ ...base, ...bad }), GenError, JSON.stringify(bad));
  }
});

test("throws GenError when no attempt reaches minFloorRatio", () => {
  assert.throws(() => generateCave({ width: 40, height: 40, seed: 1, minFloorRatio: 1 }), GenError);
});

test("every size from 5 to 40 either throws GenError or yields a valid layout", () => {
  for (const seed of [1, 2, 3]) {
    for (let width = 5; width <= 40; width++) {
      for (let height = 5; height <= 40; height++) {
        const label = `${width}x${height} seed ${seed}`;
        let layout;
        try {
          layout = generateCave({ width, height, seed });
        } catch (e) {
          assert.ok(e instanceof GenError, `${label}: ${e}`);
          continue;
        }
        assert.ok(borderIsWall(layout), `${label}: border`);
        assert.ok(isFullyConnected(layout), `${label}: not connected`);
        assert.ok(count(layout.floor) >= 2, `${label}: fewer than 2 floor cells`);
        const at = (p) => layout.floor[p.y * width + p.x];
        assert.equal(at(layout.entrance), 1, `${label}: entrance`);
        assert.equal(at(layout.exit), 1, `${label}: exit`);
        assert.ok(layout.entrance.x !== layout.exit.x || layout.entrance.y !== layout.exit.y, `${label}: entrance == exit`);
        assert.deepEqual(layout.rooms, [], label);
      }
    }
  }
});

test("256x256 generates in under 3000 ms", () => {
  // Design target is well under 1 s; the assertion leaves headroom for slow CI runners.
  const start = Date.now();
  const layout = generateCave({ width: 256, height: 256, seed: 1 });
  const elapsed = Date.now() - start;
  assert.ok(isFullyConnected(layout));
  assert.ok(elapsed < 3000, `took ${elapsed} ms`);
});

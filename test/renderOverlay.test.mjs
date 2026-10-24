import assert from "node:assert/strict";
import test from "node:test";
import { renderMapBitmap } from "../dist/render.js";

// 3x1 map, 6 layers: data index = (z * height + y) * width + x. Tile id 5 on layer 2 at x=1.
const input = (over) => {
  const data = new Array(6 * 3).fill(0);
  data[2 * 3 + 1] = 5;
  const flags = new Array(8).fill(0);
  flags[5] = 0x0f;
  return {
    width: 3, height: 1, data, flags, sheets: {}, tileSize: 24, grid: false, regions: false, passability: false,
    tileEvents: [], sprites: [], markers: [], region: { x: 0, y: 0, width: 3, height: 1 }, ...over,
  };
};
const pixel = (bmp, x, y) => [...bmp.data.slice((y * bmp.width + x) * 4, (y * bmp.width + x) * 4 + 3)];

test("passability overlay tints only blocked cells red", () => {
  const off = renderMapBitmap(input({ passability: false })).bitmap;
  const on = renderMapBitmap(input({ passability: true })).bitmap;
  const ts = 24;
  for (const cell of [0, 2]) {
    for (let y = 0; y < ts; y++) {
      for (let x = cell * ts; x < (cell + 1) * ts; x++) {
        assert.deepEqual(pixel(on, x, y), pixel(off, x, y), `walkable cell ${cell} untouched`);
      }
    }
  }
  const [r0, g0, b0] = pixel(off, ts + ts / 2, ts / 2);
  const [r1, g1, b1] = pixel(on, ts + ts / 2, ts / 2);
  assert.ok(r1 > r0, "red channel rises");
  assert.ok(g1 <= g0 && b1 <= b0, "green/blue do not rise");
});

test("passability overlay: missing flags array does not throw", () => {
  assert.doesNotThrow(() => renderMapBitmap(input({ passability: true, flags: [] })));
  assert.doesNotThrow(() => renderMapBitmap(input({ passability: true, flags: undefined })));
});

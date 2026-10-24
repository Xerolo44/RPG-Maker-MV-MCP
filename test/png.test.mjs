import assert from "node:assert/strict";
import test from "node:test";
import { encodePng, pngInfo, PngError, scaleDownNearest } from "../dist/png.js";

const solid = (width, height, rgba = [10, 20, 30, 255]) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
};

test("pngInfo reads width and height from a real 1x1 PNG built with encodePng", () => {
  assert.deepEqual(pngInfo(encodePng(solid(1, 1))), { width: 1, height: 1 });
  assert.deepEqual(pngInfo(encodePng(solid(7, 3))), { width: 7, height: 3 });
});

test("pngInfo reads only the header, so a cut-off file still reports its size", () => {
  const png = encodePng(solid(5, 4));
  assert.deepEqual(pngInfo(png.subarray(0, 29)), { width: 5, height: 4 });
});

test("pngInfo rejects a truncated header, a wrong signature and a first chunk that is not IHDR", () => {
  const png = encodePng(solid(2, 2));
  assert.throws(() => pngInfo(png.subarray(0, 28)), PngError);
  assert.throws(() => pngInfo(png.subarray(0, 4)), PngError);
  assert.throws(() => pngInfo(Buffer.alloc(0)), PngError);
  const badSig = Buffer.from(png);
  badSig[1] = 0x51;
  assert.throws(() => pngInfo(badSig), PngError);
  const notIhdr = Buffer.from(png);
  notIhdr.write("IDAT", 12, "ascii");
  assert.throws(() => pngInfo(notIhdr), PngError);
  const badLen = Buffer.from(png);
  badLen.writeUInt32BE(12, 8);
  assert.throws(() => pngInfo(badLen), PngError);
  const zero = Buffer.from(png);
  zero.writeUInt32BE(0, 16);
  assert.throws(() => pngInfo(zero), PngError);
});

test("scaleDownNearest leaves a small bitmap untouched and returns the same object", () => {
  const b = solid(40, 20);
  assert.equal(scaleDownNearest(b, 40), b);
  assert.equal(scaleDownNearest(b, 512), b);
});

test("scaleDownNearest shrinks 200x100 to maxEdge 50 as 50x25 and keeps the nearest source pixel", () => {
  const b = solid(200, 100, [0, 0, 0, 255]);
  // Mark the source pixel at the centre of the 4x4 block that becomes output pixel (3, 2).
  const sx = 3 * 4 + 2;
  const sy = 2 * 4 + 2;
  b.data.set([200, 100, 50, 255], (sy * 200 + sx) * 4);
  const out = scaleDownNearest(b, 50);
  assert.equal(out.width, 50);
  assert.equal(out.height, 25);
  assert.equal(out.data.length, 50 * 25 * 4);
  assert.deepEqual([...out.data.slice((2 * 50 + 3) * 4, (2 * 50 + 3) * 4 + 4)], [200, 100, 50, 255]);
  assert.deepEqual([...out.data.slice(0, 4)], [0, 0, 0, 255]);
});

test("scaleDownNearest never goes below 1 px and handles tall bitmaps", () => {
  const out = scaleDownNearest(solid(1000, 3), 10);
  assert.equal(out.width, 10);
  assert.equal(out.height, 1);
  const tall = scaleDownNearest(solid(3, 1000), 10);
  assert.equal(tall.width, 1);
  assert.equal(tall.height, 10);
  assert.throws(() => scaleDownNearest(solid(4, 4), 0), PngError);
});

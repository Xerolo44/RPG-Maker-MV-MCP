import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { decodePng, encodePng, pngInfo, pngIsInterlaced, PngError, scaleDownNearest } from "../dist/png.js";

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

// ---- decodePng: bounded inflate ----

/** PNG with the given IHDR fields and raw IDAT payload. The CRCs are zero: decodePng does not check them. */
function craftedPng({ width, height, depth = 8, colorType = 6, interlace = 0, idat }) {
  const chunkOf = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunkOf("IHDR", ihdr),
    chunkOf("IDAT", idat),
    chunkOf("IEND", Buffer.alloc(0)),
  ]);
}

test("decodePng refuses an IDAT that inflates far beyond what the header allows, quickly", () => {
  const idat = zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024)); // ~64 KB on disk, 64 MB inflated
  const file = craftedPng({ width: 1, height: 1, idat });
  const started = Date.now();
  assert.throws(() => decodePng(file), (e) => e instanceof PngError && /larger than its header allows/.test(e.message));
  assert.ok(Date.now() - started < 1000);
});

test("decodePng refuses data for a bigger image than the header claims, and corrupt data, with PngError", () => {
  const big = zlib.deflateSync(Buffer.alloc(100 * 101 * 4));
  assert.throws(() => decodePng(craftedPng({ width: 4, height: 4, idat: big })), PngError);
  assert.throws(() => decodePng(craftedPng({ width: 4, height: 4, idat: Buffer.from("not zlib data") })), (e) => e instanceof PngError && /corrupt/.test(e.message));
});

test("decodePng still decodes 1-bit grayscale, 16-bit RGB and a few trailing bytes", () => {
  // 1-bit gray 8x2: row filters 0, bits 10100000 and 01010000 -> white/black alternating
  const gray = decodePng(craftedPng({ width: 8, height: 2, depth: 1, colorType: 0, idat: zlib.deflateSync(Buffer.from([0, 0xa0, 0, 0x50])) }));
  assert.deepEqual([...gray.data.slice(0, 8)], [255, 255, 255, 255, 0, 0, 0, 255]);
  assert.deepEqual([...gray.data.slice(8 * 4, 8 * 4 + 8)], [0, 0, 0, 255, 255, 255, 255, 255]);
  const rgb16 = decodePng(craftedPng({ width: 1, height: 1, depth: 16, colorType: 2, idat: zlib.deflateSync(Buffer.from([0, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00])) }));
  assert.deepEqual([...rgb16.data], [255, 128, 0, 255]);
  const padded = decodePng(craftedPng({ width: 1, height: 1, idat: zlib.deflateSync(Buffer.concat([Buffer.from([0, 1, 2, 3, 4]), Buffer.alloc(100)])) }));
  assert.deepEqual([...padded.data], [1, 2, 3, 4]);
});

test("pngIsInterlaced reads the IHDR interlace byte from the first 29 bytes", () => {
  const plain = craftedPng({ width: 1, height: 1, idat: zlib.deflateSync(Buffer.alloc(5)) });
  const adam7 = craftedPng({ width: 1, height: 1, interlace: 1, idat: zlib.deflateSync(Buffer.alloc(5)) });
  assert.equal(pngIsInterlaced(plain.subarray(0, 29)), false);
  assert.equal(pngIsInterlaced(adam7.subarray(0, 29)), true);
  assert.equal(pngIsInterlaced(adam7.subarray(0, 20)), false);
  assert.equal(pngIsInterlaced(Buffer.from("not a png at all, really, no")), false);
});

// ---- decodePng: header rules ----

/** A PNG whose chunks are the given [type, data] pairs (zero CRCs: decodePng does not check them). */
function pngOfChunks(chunks) {
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])];
  for (const [type, data] of chunks) {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    parts.push(out);
  }
  return Buffer.concat(parts);
}
const ihdrOf = (width, height) => {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b[8] = 8;
  b[9] = 6;
  return b;
};

test("decodePng and pngInfo reject a second IHDR (a 2x2 header followed by a 6000x6000 one), quickly", () => {
  const idat = zlib.deflateSync(Buffer.alloc(2 * (2 * 4 + 1)));
  const file = pngOfChunks([["IHDR", ihdrOf(2, 2)], ["IHDR", ihdrOf(6000, 6000)], ["IDAT", idat], ["IEND", Buffer.alloc(0)]]);
  const started = Date.now();
  assert.throws(() => decodePng(file), (e) => e instanceof PngError && /second image header/.test(e.message));
  assert.throws(() => pngInfo(file.subarray(0, 64)), (e) => e instanceof PngError && /second image header/.test(e.message));
  assert.ok(Date.now() - started < 1000);
});

test("decodePng rejects a PNG whose first chunk is not IHDR, or whose IHDR has the wrong length", () => {
  const idat = zlib.deflateSync(Buffer.alloc(9));
  assert.throws(() => decodePng(pngOfChunks([["tEXt", Buffer.from("a\0b")], ["IHDR", ihdrOf(1, 1)], ["IDAT", idat]])), (e) => e instanceof PngError && /start with an image header/.test(e.message));
  assert.throws(() => decodePng(pngOfChunks([["IHDR", ihdrOf(1, 1).subarray(0, 8)], ["IDAT", idat]])), (e) => e instanceof PngError && /wrong length/.test(e.message));
});

test("decodePng honours maxPixels", () => {
  const png = encodePng(solid(100, 100));
  assert.equal(decodePng(png, 10_000).width, 100);
  assert.throws(() => decodePng(png, 9_999), (e) => e instanceof PngError && /too large/.test(e.message));
});

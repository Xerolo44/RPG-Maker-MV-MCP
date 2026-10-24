// Minimal PNG reader/writer (no dependencies). Reads the non-interlaced variants RPG Maker
// tilesets and character sheets come in (grayscale, RGB, palette, +alpha, 1-16 bit) and
// writes 8-bit RGBA. Used by the map renderer.
import zlib from "node:zlib";

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array;
}

export class PngError extends Error {}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

export function encodePng(bitmap: Bitmap): Buffer {
  const { width, height, data } = bitmap;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Bytes of trailing data tolerated after the image data when inflating. */
const INFLATE_SLACK = 4096;

export function decodePng(buf: Buffer): Bitmap {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError("Not a PNG file.");
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];

  let pos = 8;
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!width || !height) throw new PngError("PNG has no image header.");
  if (interlace !== 0) throw new PngError("Interlaced PNGs are not supported.");
  const channels = CHANNELS[colorType];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) {
    throw new PngError(`Unsupported PNG format (color type ${colorType}, ${depth}-bit).`);
  }
  if (colorType === 3 && !palette) throw new PngError("Palette PNG without a palette.");
  if (width * height > 64_000_000) throw new PngError("PNG is too large.");

  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  // The header says how many bytes the image data must inflate to; refuse to inflate more than
  // that (plus a little slack for encoders that pad the stream), so a small file cannot expand
  // into gigabytes. Corrupt streams and over-long ones both become PngError.
  const expected = (stride + 1) * height;
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected + INFLATE_SLACK });
  } catch (e) {
    throw new PngError(
      (e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "PNG data is larger than its header allows." : "PNG data is corrupt."
    );
  }
  if (raw.length < expected) throw new PngError("PNG data is truncated.");

  // Undo the per-row filters in place.
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? pixels[dst + i - bpp] : 0;
      const b = y > 0 ? pixels[dst - stride + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[dst - stride + i - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new PngError(`Unknown PNG filter ${filter}.`);
      }
      pixels[dst + i] = v & 0xff;
    }
  }

  // Raw sample (full precision) number `n` of row y; used for tRNS comparison.
  const sample = (y: number, n: number): number => {
    const row = y * stride;
    if (depth === 8) return pixels[row + n];
    if (depth === 16) return (pixels[row + n * 2] << 8) | pixels[row + n * 2 + 1];
    const bit = n * depth;
    return (pixels[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const to8 = (v: number): number => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));

  const out = new Uint8Array(width * height * 4);
  const trnsGray = trns && colorType === 0 && trns.length >= 2 ? trns.readUInt16BE(0) : -1;
  const trnsRgb =
    trns && colorType === 2 && trns.length >= 6
      ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]
      : null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = sample(y, x);
        out[o] = palette![idx * 3] ?? 0;
        out[o + 1] = palette![idx * 3 + 1] ?? 0;
        out[o + 2] = palette![idx * 3 + 2] ?? 0;
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0) {
        const g = sample(y, x);
        out[o] = out[o + 1] = out[o + 2] = to8(g);
        out[o + 3] = g === trnsGray ? 0 : 255;
      } else if (colorType === 4) {
        out[o] = out[o + 1] = out[o + 2] = to8(sample(y, x * 2));
        out[o + 3] = to8(sample(y, x * 2 + 1));
      } else if (colorType === 2) {
        const r = sample(y, x * 3);
        const g = sample(y, x * 3 + 1);
        const b = sample(y, x * 3 + 2);
        out[o] = to8(r);
        out[o + 1] = to8(g);
        out[o + 2] = to8(b);
        out[o + 3] = trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2] ? 0 : 255;
      } else {
        out[o] = to8(sample(y, x * 4));
        out[o + 1] = to8(sample(y, x * 4 + 1));
        out[o + 2] = to8(sample(y, x * 4 + 2));
        out[o + 3] = to8(sample(y, x * 4 + 3));
      }
    }
  }
  return { width, height, data: out };
}

/**
 * Reads width and height from the PNG header only (signature + the first chunk, which must be
 * a 13-byte IHDR), so callers can inspect a file from its first 29 bytes without decoding it.
 */
export function pngInfo(buf: Buffer): { width: number; height: number } {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError("Not a PNG file.");
  if (buf.length < 29) throw new PngError("PNG header is truncated.");
  if (buf.readUInt32BE(8) !== 13 || buf.toString("ascii", 12, 16) !== "IHDR") {
    throw new PngError("PNG does not start with an image header.");
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) {
    throw new PngError("PNG header has invalid dimensions.");
  }
  return { width, height };
}

/**
 * True when the IHDR interlace byte (offset 28, inside the first 29 bytes) is set. False for
 * anything that is too short or not a PNG; use `pngInfo` to validate the header itself.
 */
export function pngIsInterlaced(buf: Buffer): boolean {
  return buf.length >= 29 && buf.subarray(0, 8).equals(SIGNATURE) && buf[28] !== 0;
}

/**
 * Nearest-neighbour downscale so the longer edge equals `maxEdge` (aspect kept, at least 1 px
 * per side). Returns `b` itself when it already fits.
 */
export function scaleDownNearest(b: Bitmap, maxEdge: number): Bitmap {
  if (!Number.isInteger(maxEdge) || maxEdge < 1) throw new PngError("maxEdge must be a positive integer.");
  const longest = Math.max(b.width, b.height);
  if (longest <= maxEdge) return b;
  const width = Math.max(1, Math.round((b.width * maxEdge) / longest));
  const height = Math.max(1, Math.round((b.height * maxEdge) / longest));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(b.height - 1, Math.floor(((y + 0.5) * b.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(b.width - 1, Math.floor(((x + 0.5) * b.width) / width));
      const s = (sy * b.width + sx) * 4;
      data.set(b.data.subarray(s, s + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

// Software renderer for RPG Maker MV maps: composes tileset sheets, autotiles, shadows and
// event sprites into an RGBA bitmap the same way the engine's Tilemap does (frame 0 of the
// water animation). Pure functions, no file access.
import { passableGrid } from "./passability.js";
import type { Bitmap } from "./png.js";
import {
  Sheet,
  autotileKind,
  autotileShape,
  isAutotile,
  kindBlock,
  sheetOfAutotileKind,
  sheetOfTile,
  tableType,
} from "./tiles.js";

// Quarter-tile source offsets per autotile shape, copied from the engine (rpg_core.js).
const FLOOR_TABLE: number[][][] = [
  [[2,4],[1,4],[2,3],[1,3]],[[2,0],[1,4],[2,3],[1,3]],
  [[2,4],[3,0],[2,3],[1,3]],[[2,0],[3,0],[2,3],[1,3]],
  [[2,4],[1,4],[2,3],[3,1]],[[2,0],[1,4],[2,3],[3,1]],
  [[2,4],[3,0],[2,3],[3,1]],[[2,0],[3,0],[2,3],[3,1]],
  [[2,4],[1,4],[2,1],[1,3]],[[2,0],[1,4],[2,1],[1,3]],
  [[2,4],[3,0],[2,1],[1,3]],[[2,0],[3,0],[2,1],[1,3]],
  [[2,4],[1,4],[2,1],[3,1]],[[2,0],[1,4],[2,1],[3,1]],
  [[2,4],[3,0],[2,1],[3,1]],[[2,0],[3,0],[2,1],[3,1]],
  [[0,4],[1,4],[0,3],[1,3]],[[0,4],[3,0],[0,3],[1,3]],
  [[0,4],[1,4],[0,3],[3,1]],[[0,4],[3,0],[0,3],[3,1]],
  [[2,2],[1,2],[2,3],[1,3]],[[2,2],[1,2],[2,3],[3,1]],
  [[2,2],[1,2],[2,1],[1,3]],[[2,2],[1,2],[2,1],[3,1]],
  [[2,4],[3,4],[2,3],[3,3]],[[2,4],[3,4],[2,1],[3,3]],
  [[2,0],[3,4],[2,3],[3,3]],[[2,0],[3,4],[2,1],[3,3]],
  [[2,4],[1,4],[2,5],[1,5]],[[2,0],[1,4],[2,5],[1,5]],
  [[2,4],[3,0],[2,5],[1,5]],[[2,0],[3,0],[2,5],[1,5]],
  [[0,4],[3,4],[0,3],[3,3]],[[2,2],[1,2],[2,5],[1,5]],
  [[0,2],[1,2],[0,3],[1,3]],[[0,2],[1,2],[0,3],[3,1]],
  [[2,2],[3,2],[2,3],[3,3]],[[2,2],[3,2],[2,1],[3,3]],
  [[2,4],[3,4],[2,5],[3,5]],[[2,0],[3,4],[2,5],[3,5]],
  [[0,4],[1,4],[0,5],[1,5]],[[0,4],[3,0],[0,5],[1,5]],
  [[0,2],[3,2],[0,3],[3,3]],[[0,2],[1,2],[0,5],[1,5]],
  [[0,4],[3,4],[0,5],[3,5]],[[2,2],[3,2],[2,5],[3,5]],
  [[0,2],[3,2],[0,5],[3,5]],[[0,0],[1,0],[0,1],[1,1]],
];
const WALL_TABLE: number[][][] = [
  [[2,2],[1,2],[2,1],[1,1]],[[0,2],[1,2],[0,1],[1,1]],
  [[2,0],[1,0],[2,1],[1,1]],[[0,0],[1,0],[0,1],[1,1]],
  [[2,2],[3,2],[2,1],[3,1]],[[0,2],[3,2],[0,1],[3,1]],
  [[2,0],[3,0],[2,1],[3,1]],[[0,0],[3,0],[0,1],[3,1]],
  [[2,2],[1,2],[2,3],[1,3]],[[0,2],[1,2],[0,3],[1,3]],
  [[2,0],[1,0],[2,3],[1,3]],[[0,0],[1,0],[0,3],[1,3]],
  [[2,2],[3,2],[2,3],[3,3]],[[0,2],[3,2],[0,3],[3,3]],
  [[2,0],[3,0],[2,3],[3,3]],[[0,0],[3,0],[0,3],[3,3]],
];
const WATERFALL_TABLE: number[][][] = [
  [[2,0],[1,0],[2,1],[1,1]],[[0,0],[1,0],[0,1],[1,1]],
  [[2,0],[3,0],[2,1],[3,1]],[[0,0],[3,0],[0,1],[3,1]],
];

const SRC_TILE = 48;
const SRC_HALF = SRC_TILE / 2;

export type Rgb = [number, number, number];

export interface SpriteDraw {
  /** Cell the sprite stands on. */
  x: number;
  y: number;
  bitmap: Bitmap;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface MarkerDraw {
  x: number;
  y: number;
  label?: number;
  color: Rgb;
}

export interface RenderInput {
  width: number;
  height: number;
  /** Map tile data: 6 layers of width*height entries. */
  data: number[];
  /** Tileset flags, indexed by tile id. */
  flags: number[];
  sheets: Partial<Record<Sheet, Bitmap>>;
  region: { x: number; y: number; width: number; height: number };
  /** Output pixels per map tile. */
  tileSize: number;
  grid: boolean;
  regions: boolean;
  /** Tint cells the engine rule marks as blocked translucent red. */
  passability: boolean;
  /** Tile-image events: an extra tile drawn on top of the lower layers. */
  tileEvents: { x: number; y: number; tileId: number }[];
  sprites: SpriteDraw[];
  markers: MarkerDraw[];
  /** Cells to outline with a 2 px inner border, drawn after the markers. May be omitted by plain callers. */
  outlines: { x: number; y: number; color: Rgb }[];
}

export interface RenderOutput {
  bitmap: Bitmap;
  /** Sheets that had tiles on the map but no usable image (drawn as flat placeholder colours). */
  missingSheets: Sheet[];
}

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------

function blend(dst: Uint8Array, o: number, r: number, g: number, b: number, a: number): void {
  if (a >= 255) {
    dst[o] = r;
    dst[o + 1] = g;
    dst[o + 2] = b;
    dst[o + 3] = 255;
  } else if (a > 0) {
    const k = a / 255;
    dst[o] = Math.round(dst[o] * (1 - k) + r * k);
    dst[o + 1] = Math.round(dst[o + 1] * (1 - k) + g * k);
    dst[o + 2] = Math.round(dst[o + 2] * (1 - k) + b * k);
    dst[o + 3] = 255;
  }
}

function fillRect(dst: Bitmap, x0: number, y0: number, x1: number, y1: number, color: Rgb, alpha: number): void {
  const a = Math.round(alpha * 255);
  for (let y = Math.max(0, y0); y < Math.min(dst.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(dst.width, x1); x++) {
      blend(dst.data, (y * dst.width + x) * 4, color[0], color[1], color[2], a);
    }
  }
}

/**
 * Copy a source rectangle into the integer destination rectangle [dx0,dx1) x [dy0,dy1),
 * scaling with a box filter and alpha-blending over what is already there.
 */
function blit(
  dst: Bitmap,
  src: Bitmap,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx0: number,
  dy0: number,
  dx1: number,
  dy1: number
): void {
  const dw = dx1 - dx0;
  const dh = dy1 - dy0;
  if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
  if (sx < 0 || sy < 0 || sx + sw > src.width || sy + sh > src.height) return;
  for (let py = Math.max(0, dy0); py < Math.min(dst.height, dy1); py++) {
    const sy0 = sy + Math.floor(((py - dy0) * sh) / dh);
    const sy1 = Math.max(sy0 + 1, sy + Math.ceil(((py - dy0 + 1) * sh) / dh));
    for (let px = Math.max(0, dx0); px < Math.min(dst.width, dx1); px++) {
      const sx0 = sx + Math.floor(((px - dx0) * sw) / dw);
      const sx1 = Math.max(sx0 + 1, sx + Math.ceil(((px - dx0 + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        for (let xx = sx0; xx < sx1; xx++) {
          const i = (yy * src.width + xx) * 4;
          const al = src.data[i + 3];
          r += src.data[i] * al;
          g += src.data[i + 1] * al;
          b += src.data[i + 2] * al;
          a += al;
          n++;
        }
      }
      if (a === 0) continue;
      blend(dst.data, (py * dst.width + px) * 4, Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / n));
    }
  }
}

const DIGITS = [
  "111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001",
  "111100111001111", "111100111101111", "111001001001001", "111101111101111", "111101111001111",
];

function drawNumber(dst: Bitmap, x: number, y: number, n: number, scale: number, fg: Rgb, bg: Rgb): number {
  const text = String(Math.max(0, Math.floor(n)));
  const w = text.length * 4 * scale + scale;
  fillRect(dst, x, y, x + w, y + 6 * scale + scale, bg, 0.75);
  text.split("").forEach((ch, i) => {
    const glyph = DIGITS[Number(ch)];
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy * 3 + gx] === "1") {
          const px = x + scale + (i * 4 + gx) * scale;
          const py = y + scale + gy * scale;
          fillRect(dst, px, py, px + scale, py + scale, fg, 1);
        }
      }
    }
  });
  return w;
}

function hashColor(n: number): Rgb {
  const h = ((n * 47) % 360) / 60;
  const s = 0.55;
  const l = 0.5;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// ---------------------------------------------------------------------------
// Map rendering
// ---------------------------------------------------------------------------

export function renderMapBitmap(input: RenderInput): RenderOutput {
  const { width, height, data, sheets, region, tileSize: ts } = input;
  const flags = input.flags ?? [];
  const out: Bitmap = {
    width: region.width * ts,
    height: region.height * ts,
    data: new Uint8Array(region.width * ts * region.height * ts * 4),
  };
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;

  const missing = new Set<Sheet>();
  const at = (x: number, y: number, z: number): number => data[(z * height + y) * width + x];
  const flagOf = (id: number): number => flags[id] ?? 0;
  // Destination pixel for a position measured in 48px source units, relative to the region origin.
  const px = (cell: number, units: number): number => Math.round(((cell + units / SRC_TILE) * ts));

  const placeholder = (tileId: number, cx: number, cy: number, sheet: Sheet | null): void => {
    if (sheet) missing.add(sheet);
    const key = isAutotile(tileId) ? autotileKind(tileId) + 500 : tileId;
    fillRect(out, px(cx, 0), px(cy, 0), px(cx + 1, 0), px(cy + 1, 0), hashColor(key), 0.85);
  };

  const drawTile = (tileId: number, cx: number, cy: number): void => {
    // cx, cy are cells relative to the region origin
    if (tileId <= 0 || tileId >= 8192) return;
    const sheet = sheetOfTile(tileId);
    if (!sheet) return;
    const bitmap = sheets[sheet];
    if (!bitmap) return placeholder(tileId, cx, cy, sheet);

    if (isAutotile(tileId)) {
      const kind = autotileKind(tileId);
      const shape = autotileShape(tileId);
      const type = tableType(kind);
      const table = (type === "wall" ? WALL_TABLE : type === "waterfall" ? WATERFALL_TABLE : FLOOR_TABLE)[shape];
      if (!table) return;
      const block = kindBlock(kind);
      const isTable = sheetOfAutotileKind(kind) === "A2" && (flagOf(tileId) & 0x80) !== 0;
      for (let i = 0; i < 4; i++) {
        const [qsx, qsy] = table[i];
        const sx = (block.x * 2 + qsx) * SRC_HALF;
        const sy = (block.y * 2 + qsy) * SRC_HALF;
        const x0 = px(cx, (i % 2) * SRC_HALF);
        const x1 = px(cx, (i % 2) * SRC_HALF + SRC_HALF);
        const y0 = px(cy, Math.floor(i / 2) * SRC_HALF);
        const y1 = px(cy, Math.floor(i / 2) * SRC_HALF + SRC_HALF);
        if (isTable && (qsy === 1 || qsy === 5)) {
          // Counters: the lower half of this quarter comes from the table's front face.
          const qsx2 = qsy === 1 ? [0, 3, 2, 1][qsx] : qsx;
          const sx2 = (block.x * 2 + qsx2) * SRC_HALF;
          const sy2 = (block.y * 2 + 3) * SRC_HALF;
          const ym = Math.round((y0 + y1) / 2);
          blit(out, bitmap, sx2, sy2, SRC_HALF, SRC_HALF, x0, y0, x1, y1);
          blit(out, bitmap, sx, sy, SRC_HALF, SRC_HALF / 2, x0, ym, x1, y1);
        } else {
          blit(out, bitmap, sx, sy, SRC_HALF, SRC_HALF, x0, y0, x1, y1);
        }
      }
    } else {
      const sx = (Math.floor(tileId / 128 ) % 2 * 8 + (tileId % 8)) * SRC_TILE;
      const sy = (Math.floor((tileId % 256) / 8) % 16) * SRC_TILE;
      blit(out, bitmap, sx, sy, SRC_TILE, SRC_TILE, px(cx, 0), px(cy, 0), px(cx + 1, 0), px(cy + 1, 0));
    }
  };

  const drawShadow = (bits: number, cx: number, cy: number): void => {
    if (!(bits & 0x0f)) return;
    for (let i = 0; i < 4; i++) {
      if (!(bits & (1 << i))) continue;
      const x0 = px(cx, (i % 2) * SRC_HALF);
      const y0 = px(cy, Math.floor(i / 2) * SRC_HALF);
      fillRect(out, x0, y0, px(cx, (i % 2) * SRC_HALF + SRC_HALF), px(cy, Math.floor(i / 2) * SRC_HALF + SRC_HALF), [0, 0, 0], 0.5);
    }
  };

  // Pass 1: everything below characters (tile layers 0-3 without the "star" flag, shadows between 1 and 2).
  // Pass 2 (after sprites): tiles flagged to draw above characters.
  const upper: [number, number, number][] = [];
  for (let cy = 0; cy < region.height; cy++) {
    for (let cx = 0; cx < region.width; cx++) {
      const mx = region.x + cx;
      const my = region.y + cy;
      for (let z = 0; z < 4; z++) {
        const id = at(mx, my, z);
        if (id > 0 && flagOf(id) & 0x10) upper.push([id, cx, cy]);
        else drawTile(id, cx, cy);
        if (z === 1) drawShadow(at(mx, my, 4), cx, cy);
      }
    }
  }

  for (const t of input.tileEvents) {
    if (t.x >= region.x && t.y >= region.y && t.x < region.x + region.width && t.y < region.y + region.height) {
      drawTile(t.tileId, t.x - region.x, t.y - region.y);
    }
  }
  for (const s of input.sprites) {
    if (s.x < region.x || s.y < region.y || s.x >= region.x + region.width || s.y >= region.y + region.height) continue;
    const scale = ts / SRC_TILE;
    const w = Math.max(1, Math.round(s.sw * scale));
    const h = Math.max(1, Math.round(s.sh * scale));
    const dx = Math.round((s.x - region.x) * ts + (ts - w) / 2);
    const dy = Math.round((s.y - region.y + 1) * ts - h);
    blit(out, s.bitmap, s.sx, s.sy, s.sw, s.sh, dx, dy, dx + w, dy + h);
  }
  for (const [id, cx, cy] of upper) drawTile(id, cx, cy);

  if (input.regions) {
    const scale = Math.max(1, Math.floor(ts / 12));
    for (let cy = 0; cy < region.height; cy++) {
      for (let cx = 0; cx < region.width; cx++) {
        const r = at(region.x + cx, region.y + cy, 5);
        if (!r) continue;
        fillRect(out, px(cx, 0), px(cy, 0), px(cx + 1, 0), px(cy + 1, 0), hashColor(r), 0.45);
        if (ts >= 16) drawNumber(out, px(cx, 0), px(cy + 1, 0) - 6 * scale - scale, r, scale, [255, 255, 255], [0, 0, 0]);
      }
    }
  }

  if (input.grid && ts >= 12) {
    for (let cx = 0; cx <= region.width; cx++) fillRect(out, cx * ts, 0, cx * ts + 1, out.height, [255, 255, 255], 0.18);
    for (let cy = 0; cy <= region.height; cy++) fillRect(out, 0, cy * ts, out.width, cy * ts + 1, [255, 255, 255], 0.18);
  }

  if (input.passability) {
    const walkable = passableGrid({ width, height, data }, flags);
    for (let cy = 0; cy < region.height; cy++) {
      for (let cx = 0; cx < region.width; cx++) {
        if (walkable[(region.y + cy) * width + region.x + cx]) continue;
        fillRect(out, px(cx, 0), px(cy, 0), px(cx + 1, 0), px(cy + 1, 0), [255, 0, 0], 90 / 255);
      }
    }
  }

  const outline = ts >= 24 ? 2 : 1;
  const labelScale = Math.max(1, Math.floor(ts / 16));
  for (const m of input.markers) {
    if (m.x < region.x || m.y < region.y || m.x >= region.x + region.width || m.y >= region.y + region.height) continue;
    const x0 = (m.x - region.x) * ts;
    const y0 = (m.y - region.y) * ts;
    fillRect(out, x0, y0, x0 + ts, y0 + outline, m.color, 1);
    fillRect(out, x0, y0 + ts - outline, x0 + ts, y0 + ts, m.color, 1);
    fillRect(out, x0, y0, x0 + outline, y0 + ts, m.color, 1);
    fillRect(out, x0 + ts - outline, y0, x0 + ts, y0 + ts, m.color, 1);
    if (m.label !== undefined && ts >= 12) drawNumber(out, x0 + outline, y0 + outline, m.label, labelScale, [255, 255, 255], m.color);
  }

  for (const o of input.outlines ?? []) {
    if (o.x < region.x || o.y < region.y || o.x >= region.x + region.width || o.y >= region.y + region.height) continue;
    const x0 = (o.x - region.x) * ts;
    const y0 = (o.y - region.y) * ts;
    const t = Math.min(2, Math.floor(ts / 2));
    fillRect(out, x0, y0, x0 + ts, y0 + t, o.color, 1);
    fillRect(out, x0, y0 + ts - t, x0 + ts, y0 + ts, o.color, 1);
    fillRect(out, x0, y0, x0 + t, y0 + ts, o.color, 1);
    fillRect(out, x0 + ts - t, y0, x0 + ts, y0 + ts, o.color, 1);
  }

  return { bitmap: out, missingSheets: [...missing] };
}

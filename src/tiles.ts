// Pure RPG Maker MV tile logic: tile-id encoding, autotile shapes, and map painting.
// No file access here, so everything is unit-testable and reusable by several tools.

export const TILE = {
  B: 0,
  C: 256,
  D: 512,
  E: 768,
  A5: 1536,
  A1: 2048,
  A2: 2816,
  A3: 4352,
  A4: 5888,
  MAX: 8192,
} as const;

export const SHEETS = ["A1", "A2", "A3", "A4", "A5", "B", "C", "D", "E"] as const;
export type Sheet = (typeof SHEETS)[number];
export type AutotileSheet = "A1" | "A2" | "A3" | "A4";

/** Position of each sheet's image name in a tileset's `tilesetNames` array. */
export const SHEET_NAME_INDEX: Record<Sheet, number> = {
  A1: 0,
  A2: 1,
  A3: 2,
  A4: 3,
  A5: 4,
  B: 5,
  C: 6,
  D: 7,
  E: 8,
};

/** Inclusive autotile kind range per A sheet. Each kind owns 48 consecutive tile ids. */
export const KIND_RANGE: Record<AutotileSheet, [number, number]> = {
  A1: [0, 15],
  A2: [16, 47],
  A3: [48, 79],
  A4: [80, 127],
};

export type TableType = "floor" | "wall" | "waterfall";

export const LAYER_COUNT = 6; // 0-3 tiles, 4 shadows, 5 regions

export class TileError extends Error {}

export function isAutotile(id: number): boolean {
  return id >= TILE.A1;
}
export function autotileKind(id: number): number {
  return Math.floor((id - TILE.A1) / 48);
}
export function autotileShape(id: number): number {
  return (id - TILE.A1) % 48;
}
export function autotileId(kind: number, shape = 0): number {
  return TILE.A1 + kind * 48 + shape;
}

export function sheetOfAutotileKind(kind: number): AutotileSheet {
  if (kind < 16) return "A1";
  if (kind < 48) return "A2";
  if (kind < 80) return "A3";
  return "A4";
}

/** Which sheet a tile id lives on, or null for 0 and the unused id gaps. */
export function sheetOfTile(id: number): Sheet | null {
  if (id <= 0 || id >= TILE.MAX) return null;
  if (id < TILE.C) return "B";
  if (id < TILE.D) return "C";
  if (id < TILE.E) return "D";
  if (id < 1024) return "E";
  if (id < TILE.A5) return null;
  if (id < TILE.A5 + 128) return "A5";
  if (id < TILE.A1) return null;
  if (id < TILE.A2) return "A1";
  if (id < TILE.A3) return "A2";
  if (id < TILE.A4) return "A3";
  return "A4";
}

/** Which neighbour table the engine uses to draw an autotile kind. */
export function tableType(kind: number): TableType {
  if (kind < 16) return kind >= 4 && kind % 2 === 1 ? "waterfall" : "floor";
  if (kind < 48) return "floor";
  if (kind < 80) return "wall";
  return Math.floor(kind / 8) % 2 === 0 ? "floor" : "wall";
}

export function kindDescription(kind: number): string {
  const sheet = sheetOfAutotileKind(kind);
  if (sheet === "A1") {
    if (kind < 4) return kind % 2 === 0 ? "water" : "deep water";
    return kind % 2 === 1 ? "waterfall" : "water/lake";
  }
  if (sheet === "A2") return "ground";
  if (sheet === "A3") return kind % 16 < 8 ? "building roof" : "building wall";
  return kind % 16 < 8 ? "wall top" : "wall side";
}

export interface Block {
  /** Top-left of the kind's preview block on its sheet, in tiles. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where an autotile kind is drawn on its sheet image (tile units, 48px per tile). */
export function kindBlock(kind: number): Block {
  const tx = kind % 8;
  const ty = Math.floor(kind / 8);
  if (kind < 16) {
    if (kind === 0) return { x: 0, y: 0, w: 2, h: 3 };
    if (kind === 1) return { x: 0, y: 3, w: 2, h: 3 };
    if (kind === 2) return { x: 6, y: 0, w: 2, h: 3 };
    if (kind === 3) return { x: 6, y: 3, w: 2, h: 3 };
    let x = Math.floor(tx / 4) * 8;
    const y = ty * 6 + (Math.floor(tx / 2) % 2) * 3;
    if (kind % 2 === 1) x += 6;
    return { x, y, w: 2, h: 3 };
  }
  if (kind < 48) return { x: tx * 2, y: (ty - 2) * 3, w: 2, h: 3 };
  if (kind < 80) return { x: tx * 2, y: (ty - 6) * 2, w: 2, h: 2 };
  const y = Math.floor((ty - 10) * 2.5 + (ty % 2 === 1 ? 0.5 : 0));
  return { x: tx * 2, y, w: 2, h: ty % 2 === 0 ? 3 : 2 };
}

/** Column/row of a non-autotile tile (A5, B-E) on its sheet image, in tiles. */
export function tilePosition(sheet: Sheet, index: number): { col: number; row: number } {
  if (sheet === "A5") return { col: index % 8, row: Math.floor(index / 8) % 16 };
  return {
    col: (Math.floor(index / 128) % 2) * 8 + (index % 8),
    row: Math.floor((index % 256) / 8) % 16,
  };
}

export function tileIndexAt(sheet: Sheet, col: number, row: number): number {
  if (sheet === "A5") return row * 8 + col;
  return Math.floor(col / 8) * 128 + row * 8 + (col % 8);
}

export function sheetBase(sheet: "A5" | "B" | "C" | "D" | "E"): number {
  return sheet === "A5" ? TILE.A5 : TILE[sheet];
}

export function sheetTileCount(sheet: "A5" | "B" | "C" | "D" | "E"): number {
  return sheet === "A5" ? 128 : 256;
}

/**
 * Pick the autotile shape (0-47) from which neighbours belong to the same kind.
 * `same(dx, dy)` reports whether the neighbouring cell connects to this one.
 * Mirrors the editor's behaviour: a "floor" kind uses 8 neighbours (47 shapes),
 * a "wall" kind uses the 4 edge neighbours (16 shapes), a waterfall only left/right (4).
 */
export function computeShape(table: TableType, same: (dx: number, dy: number) => boolean): number {
  const L = !same(-1, 0);
  const R = !same(1, 0);
  if (table === "waterfall") return (L ? 1 : 0) + (R ? 2 : 0);
  const T = !same(0, -1);
  const B = !same(0, 1);
  if (table === "wall") return (L ? 1 : 0) + (T ? 2 : 0) + (R ? 4 : 0) + (B ? 8 : 0);

  const TL = !same(-1, -1);
  const TR = !same(1, -1);
  const BR = !same(1, 1);
  const BL = !same(-1, 1);
  const missing = (L ? 1 : 0) + (T ? 1 : 0) + (R ? 1 : 0) + (B ? 1 : 0);
  const n = (c: boolean): number => (c ? 1 : 0);

  if (missing === 0) return n(TL) + n(TR) * 2 + n(BR) * 4 + n(BL) * 8;
  if (missing === 1) {
    if (L) return 16 + n(TR) + n(BR) * 2;
    if (T) return 20 + n(BR) + n(BL) * 2;
    if (R) return 24 + n(BL) + n(TL) * 2;
    return 28 + n(TL) + n(TR) * 2; // B
  }
  if (missing === 2) {
    if (L && R) return 32;
    if (T && B) return 33;
    if (L && T) return 34 + n(BR);
    if (T && R) return 36 + n(BL);
    if (R && B) return 38 + n(TL);
    return 40 + n(TR); // B && L
  }
  if (missing === 3) {
    if (!B) return 42;
    if (!R) return 43;
    if (!T) return 44;
    return 45; // !L
  }
  return 46; // isolated
}

// ---------------------------------------------------------------------------
// Tile specs and painting
// ---------------------------------------------------------------------------

export type TileSpec = number | { sheet: Sheet; kind?: number; index?: number };

export interface MapGrid {
  width: number;
  height: number;
  data: number[];
}

export type PaintOp =
  | { type: "cells"; tile: TileSpec; layer?: number; cells: { x: number; y: number }[] }
  | {
      type: "rect";
      tile: TileSpec;
      layer?: number;
      x: number;
      y: number;
      width: number;
      height: number;
      hollow?: boolean;
    }
  | { type: "fill"; tile: TileSpec; layer?: number; x: number; y: number };

export interface ResolvedTile {
  id: number;
  sheet: Sheet | null;
}

export function resolveTile(spec: TileSpec): ResolvedTile {
  if (typeof spec === "number") {
    if (!Number.isInteger(spec) || spec < 0 || spec >= TILE.MAX) {
      throw new TileError(`Tile id ${spec} is out of range 0-${TILE.MAX - 1}.`);
    }
    if (spec !== 0 && sheetOfTile(spec) === null) {
      throw new TileError(`Tile id ${spec} is in an unused id range (valid: 1-1023, 1536-1663, 2048-8191).`);
    }
    // Autotile ids carry their shape; normalise to shape 0, it is recomputed after painting.
    return { id: isAutotile(spec) ? autotileId(autotileKind(spec)) : spec, sheet: sheetOfTile(spec) };
  }
  const { sheet, kind, index } = spec;
  if (sheet === "A1" || sheet === "A2" || sheet === "A3" || sheet === "A4") {
    if (kind === undefined) {
      throw new TileError(`Sheet ${sheet} is an autotile sheet: give "kind" (${rangeText(sheet)}).`);
    }
    const [lo, hi] = KIND_RANGE[sheet];
    if (!Number.isInteger(kind) || kind < lo || kind > hi) {
      throw new TileError(`Kind ${kind} is not on sheet ${sheet}; valid kinds are ${lo}-${hi}.`);
    }
    return { id: autotileId(kind), sheet };
  }
  if (index === undefined) {
    throw new TileError(`Sheet ${sheet} needs an "index" (0-${sheetTileCount(sheet) - 1}).`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= sheetTileCount(sheet)) {
    throw new TileError(`Index ${index} is not on sheet ${sheet}; valid indexes are 0-${sheetTileCount(sheet) - 1}.`);
  }
  return { id: sheetBase(sheet) + index, sheet };
}

function rangeText(sheet: AutotileSheet): string {
  const [lo, hi] = KIND_RANGE[sheet];
  return `${lo}-${hi}`;
}

function defaultLayer(sheet: Sheet | null): number | null {
  if (sheet === null) return null;
  return sheet === "B" || sheet === "C" || sheet === "D" || sheet === "E" ? 2 : 0;
}

const cellIndex = (map: MapGrid, x: number, y: number, z: number): number =>
  (z * map.height + y) * map.width + x;

function checkMap(map: MapGrid): void {
  if (!Array.isArray(map.data) || map.data.length !== map.width * map.height * LAYER_COUNT) {
    throw new TileError(
      `Map data has ${map.data?.length ?? 0} entries but ${map.width}x${map.height}x${LAYER_COUNT} = ${
        map.width * map.height * LAYER_COUNT
      } were expected.`
    );
  }
}

function inBounds(map: MapGrid, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < map.width && y < map.height;
}

/** Recompute the shape of every autotile in/around `touched` (cell indexes y*width+x) on layer z. */
function reshape(map: MapGrid, z: number, touched: Set<number>): void {
  const affected = new Set<number>();
  for (const c of touched) {
    const cx = c % map.width;
    const cy = Math.floor(c / map.width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (inBounds(map, nx, ny)) affected.add(ny * map.width + nx);
      }
    }
  }
  for (const c of affected) {
    const x = c % map.width;
    const y = Math.floor(c / map.width);
    const i = cellIndex(map, x, y, z);
    const tile = map.data[i];
    if (!isAutotile(tile)) continue;
    const kind = autotileKind(tile);
    // Cells outside the map count as connected, like in the editor.
    const same = (dx: number, dy: number): boolean => {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(map, nx, ny)) return true;
      const other = map.data[cellIndex(map, nx, ny, z)];
      return isAutotile(other) && autotileKind(other) === kind;
    };
    map.data[i] = autotileId(kind, computeShape(tableType(kind), same));
  }
}

function checkValueForLayer(layer: number, tile: ResolvedTile, spec: TileSpec): void {
  if (layer < 4) return;
  if (typeof spec !== "number") {
    throw new TileError(`Layer ${layer} (${layer === 4 ? "shadows" : "regions"}) only accepts a raw number.`);
  }
  const max = layer === 4 ? 15 : 255;
  if (tile.id > max) {
    throw new TileError(`Layer ${layer} (${layer === 4 ? "shadow bits" : "region id"}) accepts 0-${max}, got ${tile.id}.`);
  }
}

export interface PaintResult {
  /** Cells whose stored value differs from before (including neighbours re-shaped by autotiling). */
  cellsChanged: number;
  operations: { type: string; layer: number; cellsPainted: number; tileId: number }[];
  /** Sheets the painted tiles come from; callers can check them against the tileset. */
  sheetsUsed: Sheet[];
}

/** Apply paint operations to a map in place. Validates everything up front per operation. */
export function applyPaintOps(map: MapGrid, ops: PaintOp[]): PaintResult {
  checkMap(map);
  const before = map.data.slice();
  const sheetsUsed = new Set<Sheet>();
  const summary: PaintResult["operations"] = [];

  for (const op of ops) {
    const tile = resolveTile(op.tile);
    let layer = op.layer;
    if (layer === undefined) {
      const d = defaultLayer(tile.sheet);
      if (d === null) throw new TileError("Erasing (tile 0) needs an explicit layer.");
      layer = d;
    }
    if (!Number.isInteger(layer) || layer < 0 || layer >= LAYER_COUNT) {
      throw new TileError(`Layer ${layer} is invalid; use 0-3 (tiles), 4 (shadows) or 5 (regions).`);
    }
    checkValueForLayer(layer, tile, op.tile);
    if (tile.sheet) sheetsUsed.add(tile.sheet);

    const touched = new Set<number>();
    const paint = (x: number, y: number): void => {
      map.data[cellIndex(map, x, y, layer!)] = tile.id;
      touched.add(y * map.width + x);
    };

    if (op.type === "cells") {
      for (const { x, y } of op.cells) {
        if (!inBounds(map, x, y)) {
          throw new TileError(`Cell (${x}, ${y}) is outside the ${map.width}x${map.height} map.`);
        }
        paint(x, y);
      }
    } else if (op.type === "rect") {
      const { x, y, width, height } = op;
      if (
        !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        !inBounds(map, x, y) || !inBounds(map, x + width - 1, y + height - 1)
      ) {
        throw new TileError(
          `Rectangle x=${x} y=${y} ${width}x${height} does not fit in the ${map.width}x${map.height} map.`
        );
      }
      for (let yy = y; yy < y + height; yy++) {
        for (let xx = x; xx < x + width; xx++) {
          if (op.hollow && xx > x && xx < x + width - 1 && yy > y && yy < y + height - 1) continue;
          paint(xx, yy);
        }
      }
    } else {
      if (!inBounds(map, op.x, op.y)) {
        throw new TileError(`Fill start (${op.x}, ${op.y}) is outside the ${map.width}x${map.height} map.`);
      }
      const keyOf = (v: number): string => (isAutotile(v) ? `a${autotileKind(v)}` : `t${v}`);
      const startKey = keyOf(map.data[cellIndex(map, op.x, op.y, layer)]);
      const targetKey = keyOf(tile.id);
      if (startKey !== targetKey) {
        const seen = new Set<number>([op.y * map.width + op.x]);
        const queue = [op.y * map.width + op.x];
        while (queue.length) {
          const c = queue.pop()!;
          const x = c % map.width;
          const y = Math.floor(c / map.width);
          paint(x, y);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx;
            const ny = y + dy;
            if (!inBounds(map, nx, ny)) continue;
            const nc = ny * map.width + nx;
            if (seen.has(nc)) continue;
            if (keyOf(map.data[cellIndex(map, nx, ny, layer)]) === startKey) {
              seen.add(nc);
              queue.push(nc);
            }
          }
        }
      }
    }

    if (layer < 4) reshape(map, layer, touched);
    summary.push({ type: op.type, layer, cellsPainted: touched.size, tileId: tile.id });
  }

  let cellsChanged = 0;
  for (let i = 0; i < map.data.length; i++) if (map.data[i] !== before[i]) cellsChanged++;
  return { cellsChanged, operations: summary, sheetsUsed: [...sheetsUsed] };
}

// ---------------------------------------------------------------------------
// Flags and rendering helpers
// ---------------------------------------------------------------------------

export function decodeFlags(f: number): Record<string, unknown> {
  const blocked: string[] = [];
  if (f & 0x1) blocked.push("down");
  if (f & 0x2) blocked.push("left");
  if (f & 0x4) blocked.push("right");
  if (f & 0x8) blocked.push("up");
  return {
    passable: (f & 0xf) !== 0xf,
    blockedDirections: blocked,
    aboveCharacters: !!(f & 0x10),
    ladder: !!(f & 0x20),
    bush: !!(f & 0x40),
    counter: !!(f & 0x80),
    damageFloor: !!(f & 0x100),
    terrainTag: f >> 12,
  };
}

/** One-character passability code: x blocked, o passable, * passable & drawn above characters, p partly blocked. */
export function passabilityChar(f: number): string {
  if ((f & 0xf) === 0xf) return "x";
  if (f & 0x10) return "*";
  return (f & 0xf) === 0 ? "o" : "p";
}

/** Human-readable name of a tile id for legends, e.g. "A2 kind 3" or "B #17". */
export function describeTile(id: number): string {
  const sheet = sheetOfTile(id);
  if (!sheet) return `id ${id}`;
  if (isAutotile(id)) return `${sheet} kind ${autotileKind(id)}`;
  return `${sheet} #${id - (sheet === "A5" ? TILE.A5 : TILE[sheet])}`;
}

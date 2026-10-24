// Turn a generated layout into paint operations for a tile profile, and check the painted map's reachability.

import { mulberry32 } from "../battle.js";
import { passableGrid } from "../passability.js";
import type { TileProfile } from "../tileProfile.js";
import { type MapGrid, type PaintOp, type TileSpec, resolveTile } from "../tiles.js";
import { GenError, type Layout, type Point } from "./layout.js";

/** Share of eligible floor cells that get a decor tile. */
const DECOR_DENSITY = 0.03;
/** Longest `unreachable` list verifyReachable returns. */
const MAX_UNREACHABLE = 200;

/**
 * Paint operations that draw `layout` with `profile`, in order:
 * 1. a whole-map `rect` of `wallTop ?? wall` on layer 0;
 * 2. one `cells` op of `floor` on layer 0 for every floor cell;
 * 3. one `cells` op of `wall` on layer 0 for every wall cell whose south neighbour is floor (only when
 *    `wallTop` is a different tile). The wall face is a single row: a known simplification, since MV
 *    tilesets often draw wall sides two or more tiles tall;
 * 4. one `cells` op per distinct decor tile, on the layer applyPaintOps picks for it by default.
 * Decor only goes on floor cells whose 8 neighbours are all floor, never 8-adjacent to another decor
 * cell, and never within one cell (Chebyshev) of the entrance or exit. Each removed cell keeps a ring
 * of walkable floor around it, so even blocking decor cannot disconnect the layout.
 * Cells within each op are row-major; the same seed always gives the same ops.
 * Autotile shapes are left to applyPaintOps, which recomputes them from the neighbours.
 */
export function layoutToPaintOps(layout: Layout, profile: TileProfile, seed: number): PaintOp[] {
  const { width, height, floor } = layout;
  const isFloor = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height && floor[y * width + x] === 1;
  const top = profile.wallTop ?? profile.wall;
  const ops: PaintOp[] = [{ type: "rect", tile: top, layer: 0, x: 0, y: 0, width, height }];

  const floorCells: Point[] = [];
  const faceCells: Point[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isFloor(x, y)) floorCells.push({ x, y });
      else if (isFloor(x, y + 1)) faceCells.push({ x, y });
    }
  }
  if (floorCells.length) ops.push({ type: "cells", tile: profile.floor, layer: 0, cells: floorCells });
  if (faceCells.length && resolveTile(profile.wall).id !== resolveTile(top).id) {
    ops.push({ type: "cells", tile: profile.wall, layer: 0, cells: faceCells });
  }

  const decor = (profile.decor ?? []).filter((d) => d.weight > 0);
  if (!decor.length) return ops;
  const totalWeight = decor.reduce((sum, d) => sum + d.weight, 0);
  const rng = mulberry32(seed);
  const nearAnchor = (x: number, y: number): boolean =>
    [layout.entrance, layout.exit].some((p) => Math.abs(p.x - x) <= 1 && Math.abs(p.y - y) <= 1);
  const interior = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!isFloor(x + dx, y + dy)) return false;
    return true;
  };
  const taken = new Uint8Array(width * height);
  const touchesTaken = (x: number, y: number): boolean => {
    // Row-major order means only the row above and the cell to the left can already hold decor.
    for (let dx = -1; dx <= 1; dx++) if (y > 0 && x + dx >= 0 && x + dx < width && taken[(y - 1) * width + x + dx]) return true;
    return x > 0 && taken[y * width + x - 1] === 1;
  };
  // Grouped by resolved tile id so two entries naming the same tile share one op; Map keeps first-seen order.
  const groups = new Map<number, { tile: TileSpec; cells: Point[] }>();
  for (const d of decor) {
    const id = resolveTile(d.tile).id;
    if (!groups.has(id)) groups.set(id, { tile: d.tile, cells: [] });
  }
  for (const { x, y } of floorCells) {
    if (!interior(x, y) || nearAnchor(x, y) || touchesTaken(x, y)) continue;
    if (rng() >= DECOR_DENSITY) continue;
    taken[y * width + x] = 1;
    let pick = rng() * totalWeight;
    let chosen = decor[decor.length - 1];
    for (const d of decor) {
      pick -= d.weight;
      if (pick < 0) {
        chosen = d;
        break;
      }
    }
    groups.get(resolveTile(chosen.tile).id)!.cells.push({ x, y });
  }
  for (const g of groups.values()) if (g.cells.length) ops.push({ type: "cells", tile: g.tile, cells: g.cells });
  return ops;
}

/**
 * Flood-fills (4-neighbour) the map's passableGrid from `from` and checks it against the layout:
 * `expected` counts the layout's floor cells that are walkable on the map (cells blocked by decor are
 * left out), `reachable` how many of those the flood reached, `unreachable` the rest (row-major, at most
 * 200). A `from` that is off the map or not walkable reaches nothing.
 */
export function verifyReachable(
  map: MapGrid,
  flags: number[],
  from: Point,
  layout: Layout,
): { reachable: number; expected: number; unreachable: Point[] } {
  const { width, height } = map;
  if (width !== layout.width || height !== layout.height) {
    throw new GenError(`map is ${width}x${height} but the layout is ${layout.width}x${layout.height}`);
  }
  const walkable = passableGrid(map, flags);
  const seen = new Uint8Array(width * height);
  const inMap = from.x >= 0 && from.y >= 0 && from.x < width && from.y < height;
  if (inMap && walkable[from.y * width + from.x]) {
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;
    seen[from.y * width + from.x] = 1;
    queue[tail++] = from.y * width + from.x;
    const visit = (i: number): void => {
      if (walkable[i] && !seen[i]) {
        seen[i] = 1;
        queue[tail++] = i;
      }
    };
    while (head < tail) {
      const cur = queue[head++];
      const x = cur % width;
      if (x > 0) visit(cur - 1);
      if (x < width - 1) visit(cur + 1);
      if (cur >= width) visit(cur - width);
      if (cur + width < width * height) visit(cur + width);
    }
  }

  let expected = 0;
  let reachable = 0;
  const unreachable: Point[] = [];
  for (let i = 0; i < width * height; i++) {
    if (!layout.floor[i] || !walkable[i]) continue;
    expected++;
    if (seen[i]) reachable++;
    else if (unreachable.length < MAX_UNREACHABLE) unreachable.push({ x: i % width, y: Math.floor(i / width) });
  }
  return { reachable, expected, unreachable };
}

// Cellular-automata cave generator: random fill, smoothing passes, then keep only the largest connected floor region.

import { mulberry32 } from "../battle.js";
import { GenError, farthestFrom, type Layout, type Point } from "./layout.js";

export interface CaveOptions {
  width: number;
  height: number;
  seed: number;
  /** Percent of cells that start as wall, 0-100 (default 45). */
  fillPercent?: number;
  /** Number of smoothing passes, an integer from 0 to 20 (default 4). */
  smoothing?: number;
  /** Smallest acceptable floor share of the whole map, above 0 and up to 1 (default 0.3). */
  minFloorRatio?: number;
}

const MIN_MAP = 5;
const MAX_MAP = 256;
const MAX_SMOOTHING = 20;
/** Extra seeds (seed + 1 ... seed + RETRIES) tried when an attempt comes out too empty. */
const RETRIES = 10;

export function generateCave(opts: CaveOptions): Layout {
  const { width, height, seed } = opts;
  const fillPercent = opts.fillPercent ?? 45;
  const smoothing = opts.smoothing ?? 4;
  const minFloorRatio = opts.minFloorRatio ?? 0.3;
  for (const [name, v] of [["width", width], ["height", height]] as const) {
    if (!Number.isInteger(v) || v < MIN_MAP || v > MAX_MAP) throw new GenError(`${name} must be an integer from ${MIN_MAP} to ${MAX_MAP}, got ${v}`);
  }
  if (!(fillPercent >= 0 && fillPercent <= 100)) throw new GenError(`fillPercent must be a number from 0 to 100, got ${fillPercent}`);
  if (!Number.isInteger(smoothing) || smoothing < 0 || smoothing > MAX_SMOOTHING) {
    throw new GenError(`smoothing must be an integer from 0 to ${MAX_SMOOTHING}, got ${smoothing}`);
  }
  if (!(minFloorRatio > 0 && minFloorRatio <= 1)) throw new GenError(`minFloorRatio must be greater than 0 and at most 1, got ${minFloorRatio}`);

  // The border ring is always wall, so the floor can never reach 100%; an attempt also needs 2+ cells for distinct entrance and exit.
  const minCells = Math.max(2, Math.ceil(minFloorRatio * width * height));
  let best = 0;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const floor = growCave(width, height, seed + attempt, fillPercent, smoothing);
    const cells = keepLargestRegion(floor, width, height);
    best = Math.max(best, cells);
    if (cells < minCells) continue;

    const layout: Layout = { width, height, floor, rooms: [], entrance: nearestTopLeft(floor, width), exit: { x: 0, y: 0 } };
    layout.exit = farthestFrom(layout, layout.entrance);
    return layout;
  }
  throw new GenError(
    `no ${width}x${height} cave reached a floor ratio of ${minFloorRatio} in ${RETRIES + 1} attempts (best ${(best / (width * height)).toFixed(3)}); lower fillPercent or minFloorRatio`,
  );
}

/** Random fill (border always wall) followed by `smoothing` passes of the 4-5 rule. Returns a 1 = floor mask. */
function growCave(width: number, height: number, seed: number, fillPercent: number, smoothing: number): Uint8Array {
  const rng = mulberry32(seed);
  const wallChance = fillPercent / 100;
  let wall = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      wall[y * width + x] = edge || rng() < wallChance ? 1 : 0;
    }
  }

  let next = new Uint8Array(width * height);
  for (let pass = 0; pass < smoothing; pass++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
          next[i] = 1;
          continue;
        }
        const n = wall[i - width - 1] + wall[i - width] + wall[i - width + 1] + wall[i - 1] + wall[i + 1] + wall[i + width - 1] + wall[i + width] + wall[i + width + 1];
        // Wall with 5+ wall neighbours, or an existing wall with exactly 4, stays or becomes wall.
        next[i] = n >= 5 || (n === 4 && wall[i] === 1) ? 1 : 0;
      }
    }
    [wall, next] = [next, wall];
  }

  const floor = new Uint8Array(width * height);
  for (let i = 0; i < floor.length; i++) floor[i] = wall[i] ? 0 : 1;
  return floor;
}

/** Clears every floor cell outside the largest 4-connected region (first found on ties); returns the size of the kept region. */
function keepLargestRegion(floor: Uint8Array, width: number, height: number): number {
  const label = new Int32Array(width * height); // 0 = unvisited or wall
  const queue = new Int32Array(width * height);
  let bestLabel = 0;
  let bestSize = 0;
  let nextLabel = 0;
  for (let start = 0; start < floor.length; start++) {
    if (!floor[start] || label[start]) continue;
    nextLabel++;
    let head = 0;
    let tail = 0;
    label[start] = nextLabel;
    queue[tail++] = start;
    while (head < tail) {
      const cur = queue[head++];
      const x = cur % width;
      const y = (cur - x) / width;
      if (x > 0 && floor[cur - 1] && !label[cur - 1]) { label[cur - 1] = nextLabel; queue[tail++] = cur - 1; }
      if (x < width - 1 && floor[cur + 1] && !label[cur + 1]) { label[cur + 1] = nextLabel; queue[tail++] = cur + 1; }
      if (y > 0 && floor[cur - width] && !label[cur - width]) { label[cur - width] = nextLabel; queue[tail++] = cur - width; }
      if (y < height - 1 && floor[cur + width] && !label[cur + width]) { label[cur + width] = nextLabel; queue[tail++] = cur + width; }
    }
    if (tail > bestSize) {
      bestSize = tail;
      bestLabel = nextLabel;
    }
  }
  for (let i = 0; i < floor.length; i++) {
    if (floor[i] && label[i] !== bestLabel) floor[i] = 0;
  }
  return bestSize;
}

/** The floor cell with the smallest x + y (first in row-major order on ties). Assumes at least one floor cell. */
function nearestTopLeft(floor: Uint8Array, width: number): Point {
  let best = -1;
  let bestSum = Infinity;
  for (let i = 0; i < floor.length; i++) {
    if (!floor[i]) continue;
    const x = i % width;
    const sum = x + (i - x) / width;
    if (sum < bestSum) {
      bestSum = sum;
      best = i;
    }
  }
  return { x: best % width, y: Math.floor(best / width) };
}

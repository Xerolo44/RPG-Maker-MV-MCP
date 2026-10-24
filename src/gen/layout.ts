// Shared types and grid helpers for procedural map generation. Grids are row-major (index = y * width + x).

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Layout {
  width: number;
  height: number;
  /** 1 = floor, 0 = wall; row-major `y * width + x`. */
  floor: Uint8Array;
  rooms: Rect[];
  entrance: Point;
  exit: Point;
}

/** Thrown by generators for caller-fixable problems (impossible size, unreachable layout, ...). */
export class GenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenError";
  }
}

/**
 * Breadth-first step counts from `from` over floor cells (4-neighbour moves).
 * Unreachable cells, walls, and a start that is off the grid or on a wall are -1.
 */
export function floodDistances(layout: Layout, from: Point): Int32Array {
  const { width, height, floor } = layout;
  const dist = new Int32Array(width * height).fill(-1);
  if (from.x < 0 || from.y < 0 || from.x >= width || from.y >= height) return dist;
  const start = from.y * width + from.x;
  if (!floor[start]) return dist;

  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  dist[start] = 0;
  queue[tail++] = start;
  while (head < tail) {
    const cur = queue[head++];
    const x = cur % width;
    const y = (cur - x) / width;
    const next = dist[cur] + 1;
    if (x > 0 && floor[cur - 1] && dist[cur - 1] < 0) { dist[cur - 1] = next; queue[tail++] = cur - 1; }
    if (x < width - 1 && floor[cur + 1] && dist[cur + 1] < 0) { dist[cur + 1] = next; queue[tail++] = cur + 1; }
    if (y > 0 && floor[cur - width] && dist[cur - width] < 0) { dist[cur - width] = next; queue[tail++] = cur - width; }
    if (y < height - 1 && floor[cur + width] && dist[cur + width] < 0) { dist[cur + width] = next; queue[tail++] = cur + width; }
  }
  return dist;
}

/** True when every floor cell is reachable from every other (a layout with no floor counts as connected). */
export function isFullyConnected(layout: Layout): boolean {
  const { width, floor } = layout;
  const first = floor.indexOf(1);
  if (first < 0) return true;
  const dist = floodDistances(layout, { x: first % width, y: Math.floor(first / width) });
  for (let i = 0; i < floor.length; i++) {
    if (floor[i] && dist[i] < 0) return false;
  }
  return true;
}

/** The reachable floor cell with the greatest step count from `from` (first in row-major order on ties); `from` itself if nothing else is reachable. */
export function farthestFrom(layout: Layout, from: Point): Point {
  const dist = floodDistances(layout, from);
  let best = -1;
  let bestDist = 0;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] > bestDist) {
      bestDist = dist[i];
      best = i;
    }
  }
  if (best < 0) return { x: from.x, y: from.y };
  return { x: best % layout.width, y: Math.floor(best / layout.width) };
}

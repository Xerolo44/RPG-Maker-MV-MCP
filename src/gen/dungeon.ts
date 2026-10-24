// BSP dungeon generator: split the map into leaves, put one room in each, and join sibling subtrees with corridors.

import { mulberry32 } from "../battle.js";
import { GenError, farthestFrom, type Layout, type Point, type Rect } from "./layout.js";

export interface DungeonOptions {
  width: number;
  height: number;
  seed: number;
  /** Smallest room side, in cells (default 5). */
  minRoom?: number;
  /** Largest room side, in cells (default 11). */
  maxRoom?: number;
}

const MIN_MAP = 5;
const MAX_MAP = 256;

interface Node {
  left?: Node;
  right?: Node;
  /** Rooms in this subtree, in leaf order. */
  rooms: Rect[];
}

export function generateDungeon(opts: DungeonOptions): Layout {
  const { width, height, seed } = opts;
  const minRoom = opts.minRoom ?? 5;
  const maxRoom = opts.maxRoom ?? 11;
  for (const [name, v] of [["width", width], ["height", height]] as const) {
    if (!Number.isInteger(v) || v < MIN_MAP || v > MAX_MAP) throw new GenError(`${name} must be an integer from ${MIN_MAP} to ${MAX_MAP}, got ${v}`);
  }
  if (!Number.isInteger(minRoom) || !Number.isInteger(maxRoom) || minRoom < 3 || maxRoom < minRoom) {
    throw new GenError(`room sizes must be integers with 3 <= minRoom <= maxRoom, got minRoom ${minRoom} and maxRoom ${maxRoom}`);
  }

  // Every room sits inside the map minus its 1-cell border, so each axis must fit at least one minRoom room.
  if (width - 2 < minRoom || height - 2 < minRoom) {
    throw new GenError(`a ${width}x${height} map cannot hold a ${minRoom}x${minRoom} room inside its border`);
  }

  const rng = mulberry32(seed);
  const randInt = (lo: number, hi: number): number => {
    if (hi < lo) throw new GenError(`internal error: empty random range ${lo}..${hi}`);
    return lo + Math.floor(rng() * (hi - lo + 1));
  };
  // A leaf holds a room inset by 1 on every side, so it must be at least minRoom + 2 across.
  const minLeaf = minRoom + 2;
  const maxLeaf = 2 * maxRoom;

  function build(rect: Rect, forceSplit: boolean): Node {
    const canX = rect.width >= 2 * minLeaf;
    const canY = rect.height >= 2 * minLeaf;
    const oversize = rect.width > maxLeaf || rect.height > maxLeaf;
    if ((!canX && !canY) || !(oversize || forceSplit)) return makeLeaf(rect);

    let splitX: boolean;
    if (canX && canY) {
      splitX = rect.width > rect.height * 1.25 ? true : rect.height > rect.width * 1.25 ? false : rng() < 0.5;
    } else {
      splitX = canX;
    }
    if (splitX) {
      const cut = randInt(minLeaf, rect.width - minLeaf);
      return join(build({ ...rect, width: cut }, false), build({ ...rect, x: rect.x + cut, width: rect.width - cut }, false));
    }
    const cut = randInt(minLeaf, rect.height - minLeaf);
    return join(build({ ...rect, height: cut }, false), build({ ...rect, y: rect.y + cut, height: rect.height - cut }, false));
  }

  function makeLeaf(rect: Rect): Node {
    const w = randInt(minRoom, Math.min(maxRoom, rect.width - 2));
    const h = randInt(minRoom, Math.min(maxRoom, rect.height - 2));
    const room: Rect = {
      x: rect.x + 1 + randInt(0, rect.width - 2 - w),
      y: rect.y + 1 + randInt(0, rect.height - 2 - h),
      width: w,
      height: h,
    };
    return { rooms: [room] };
  }

  function join(left: Node, right: Node): Node {
    return { left, right, rooms: [...left.rooms, ...right.rooms] };
  }

  // The whole map is the root, so the leaf inset also keeps the outer 1-cell border as wall.
  const root = build({ x: 0, y: 0, width, height }, true);
  if (root.rooms.length < 2) {
    throw new GenError(`a ${width}x${height} map cannot hold 2 rooms of at least ${minRoom}x${minRoom} cells`);
  }

  const floor = new Uint8Array(width * height);
  for (const r of root.rooms) {
    for (let y = r.y; y < r.y + r.height; y++) floor.fill(1, y * width + r.x, y * width + r.x + r.width);
  }

  const centre = (r: Rect): Point => ({ x: r.x + Math.floor(r.width / 2), y: r.y + Math.floor(r.height / 2) });
  const pick = (rooms: Rect[]): Rect => rooms[randInt(0, rooms.length - 1)];
  const carveH = (y: number, x1: number, x2: number): void => {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) floor[y * width + x] = 1;
  };
  const carveV = (x: number, y1: number, y2: number): void => {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) floor[y * width + x] = 1;
  };
  // Each internal node links one room from each child, so by induction the whole tree is connected.
  const connect = (node: Node): void => {
    if (!node.left || !node.right) return;
    connect(node.left);
    connect(node.right);
    const a = centre(pick(node.left.rooms));
    const b = centre(pick(node.right.rooms));
    if (rng() < 0.5) {
      carveH(a.y, a.x, b.x);
      carveV(b.x, a.y, b.y);
    } else {
      carveV(a.x, a.y, b.y);
      carveH(b.y, a.x, b.x);
    }
  };
  connect(root);

  const layout: Layout = { width, height, floor, rooms: root.rooms, entrance: centre(root.rooms[0]), exit: { x: 0, y: 0 } };
  layout.exit = farthestFrom(layout, layout.entrance);
  return layout;
}

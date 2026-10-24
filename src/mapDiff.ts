// Structural comparison of two versions of a map file (tiles and events). Pure, no file access.
import { LAYER_COUNT } from "./tiles.js";

export interface Point {
  x: number;
  y: number;
}

export interface MapFileLike {
  width: number;
  height: number;
  data: number[];
  events: (({ id: number; x: number; y: number } & Record<string, unknown>) | null)[];
}

export interface MapDiff {
  sizeChanged: boolean;
  /** Cells (in row-major order) where any of the 6 layers differs; only the overlapping area is compared. */
  changedCells: Point[];
  events: { added: number[]; removed: number[]; moved: number[]; edited: number[] };
}

/** JSON with object keys sorted, so key order never makes two equal events look different. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

type EventLike = NonNullable<MapFileLike["events"][number]>;

function byId(events: MapFileLike["events"] | undefined): Map<number, EventLike> {
  const result = new Map<number, EventLike>();
  for (const e of events ?? []) if (e) result.set(e.id, e);
  return result;
}

function withoutPosition(e: EventLike): string {
  const { x: _x, y: _y, ...rest } = e;
  return stable(rest);
}

export function diffMaps(before: MapFileLike, after: MapFileLike): MapDiff {
  const sizeChanged = before.width !== after.width || before.height !== after.height;
  const w = Math.min(before.width, after.width);
  const h = Math.min(before.height, after.height);
  const changedCells: Point[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < LAYER_COUNT; z++) {
        if (before.data[(z * before.height + y) * before.width + x] !== after.data[(z * after.height + y) * after.width + x]) {
          changedCells.push({ x, y });
          break;
        }
      }
    }
  }

  const oldEvents = byId(before.events);
  const newEvents = byId(after.events);
  const events: MapDiff["events"] = { added: [], removed: [], moved: [], edited: [] };
  for (const [id, e] of newEvents) {
    const old = oldEvents.get(id);
    if (!old) {
      events.added.push(id);
      continue;
    }
    if (old.x !== e.x || old.y !== e.y) events.moved.push(id);
    if (withoutPosition(old) !== withoutPosition(e)) events.edited.push(id);
  }
  for (const id of oldEvents.keys()) if (!newEvents.has(id)) events.removed.push(id);
  for (const list of Object.values(events)) list.sort((a, b) => a - b);

  return { sizeChanged, changedCells, events };
}

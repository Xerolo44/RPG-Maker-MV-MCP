// Stamps: a rectangle of a map (all six layers, plus optionally its events) saved to
// `<project>/.mcp-stamps/<name>.json` and pasted onto another map of the same tileset.
// Pure map logic only; the tools in tools/generationTools.ts do the file access.

import path from "node:path";
import { ProjectError } from "./project.js";
import {
  LAYER_COUNT,
  type MapGrid,
  type PaintOp,
  TILE,
  applyPaintOps,
  autotileKind,
  isAutotile,
  sheetOfAutotileKind,
} from "./tiles.js";

export const STAMP_DIR = ".mcp-stamps";
export const MAX_STAMP_SIZE = 64;

export interface StampEvent {
  dx: number;
  dy: number;
  /** The event without `id`, `x` and `y` (those are rebuilt when it is placed). */
  event: Record<string, unknown>;
}

export interface Stamp {
  name: string;
  width: number;
  height: number;
  tilesetId: number;
  /** Six arrays of width*height tile ids: layers 0-3 tiles, 4 shadow bits, 5 regions. */
  layers: number[][];
  events: StampEvent[];
}

/** The map fields stamps read and write. */
export interface StampMap extends MapGrid {
  tilesetId?: unknown;
  events?: unknown;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** Validate a stamp name and return its file path. Throws before any file is touched. */
export function stampFile(projectRoot: string, name: string): string {
  if (
    typeof name !== "string" ||
    !NAME_PATTERN.test(name) ||
    // Windows strips trailing spaces (and dots, which the pattern already excludes).
    name.endsWith(" ") ||
    WINDOWS_RESERVED.test(name.trimEnd())
  ) {
    throw new ProjectError(
      `Invalid stamp name ${JSON.stringify(name)}. Use 1-64 characters: letters, digits, spaces, "_" or "-", ` +
        `starting with a letter or digit, not ending in a space, and not a reserved Windows name such as CON, NUL, COM1 or LPT1.`
    );
  }
  return path.join(projectRoot, STAMP_DIR, `${name}.json`);
}

function mapEvents(map: StampMap): ({ id?: unknown; x?: unknown; y?: unknown } | null | undefined)[] {
  return Array.isArray(map.events) ? map.events : [];
}

function checkRegion(map: MapGrid, x: number, y: number, width: number, height: number, what: string): void {
  if (x < 0 || y < 0 || x + width > map.width || y + height > map.height) {
    throw new ProjectError(
      `The ${what} x=${x} y=${y} ${width}x${height} is not fully inside the ${map.width}x${map.height} map.`
    );
  }
  if (!Array.isArray(map.data) || map.data.length !== map.width * map.height * LAYER_COUNT) {
    throw new ProjectError(`Map data has ${map.data?.length ?? 0} entries, expected ${map.width * map.height * LAYER_COUNT}.`);
  }
}

/** Copy a rectangle (and optionally the events standing in it) out of a map. */
export function captureStamp(
  map: StampMap,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  includeEvents: boolean
): Stamp {
  checkRegion(map, x, y, width, height, "region");
  const layers: number[][] = [];
  for (let z = 0; z < LAYER_COUNT; z++) {
    const rows: number[] = [];
    for (let yy = y; yy < y + height; yy++) {
      const start = (z * map.height + yy) * map.width + x;
      rows.push(...map.data.slice(start, start + width));
    }
    layers.push(rows);
  }
  const events: StampEvent[] = [];
  if (includeEvents) {
    for (const e of mapEvents(map)) {
      if (!e || typeof e.x !== "number" || typeof e.y !== "number") continue;
      if (e.x < x || e.y < y || e.x >= x + width || e.y >= y + height) continue;
      const copy = structuredClone(e) as Record<string, unknown>;
      delete copy.id;
      delete copy.x;
      delete copy.y;
      events.push({ dx: e.x - x, dy: e.y - y, event: copy });
    }
  }
  return { name, width, height, tilesetId: typeof map.tilesetId === "number" ? map.tilesetId : 0, layers, events };
}

/** Check that data read from a stamp file has the shape placeStamp relies on. */
export function checkStamp(stamp: Stamp, name: string): void {
  const bad = (why: string): never => {
    throw new ProjectError(`Stamp "${name}" is damaged: ${why}.`);
  };
  const cells = stamp.width * stamp.height;
  if (!Number.isInteger(stamp.width) || !Number.isInteger(stamp.height) || stamp.width < 1 || stamp.height < 1) {
    bad("its width/height are invalid");
  }
  if (!Array.isArray(stamp.layers) || stamp.layers.length !== LAYER_COUNT) bad(`it needs ${LAYER_COUNT} layers`);
  for (const layer of stamp.layers) {
    if (!Array.isArray(layer) || layer.length !== cells) bad(`every layer needs ${cells} entries`);
    if (layer.some((v) => !Number.isInteger(v) || v < 0 || v >= TILE.MAX)) bad("it holds a tile id outside 0-8191");
  }
  if (!Array.isArray(stamp.events)) bad("its events are not a list");
  for (const e of stamp.events) {
    if (!Number.isInteger(e?.dx) || !Number.isInteger(e?.dy) || e.dx < 0 || e.dy < 0 || e.dx >= stamp.width || e.dy >= stamp.height || typeof e.event !== "object" || e.event === null) {
      bad("an event entry is invalid");
    }
  }
}

export interface PlaceResult {
  cellsChanged: number;
  eventIds: number[];
}

/**
 * Paste a stamp into a map in place. The caller has already checked the stamp file with
 * checkStamp and that the tilesets match; this checks the bounds and event collisions and
 * throws before touching the map.
 *
 * The rectangle is REPLACED on all six layers (zero tiles overwrite). Every tile id is copied
 * verbatim first. Then autotile shapes are recomputed through applyPaintOps: one `cells` op
 * per layer (0-3) and autotile kind, covering the autotile cells inside the pasted rectangle
 * AND those in the one-cell ring around it. The ring matters because a neighbour outside the
 * rectangle may change shape (or keep a shape that depended on a cell the paste removed).
 * An op resets its cells to shape 0 and reshapes them plus their 8 neighbours from the map as
 * it is then; later ops never change which kind a cell holds, so shapes are correct once all
 * ops have run, whatever their order. Shadow bits and regions (layers 4-5) stay verbatim.
 */
export function placeStamp(map: StampMap, stamp: Stamp, x: number, y: number, includeEvents: boolean): PlaceResult {
  checkRegion(map, x, y, stamp.width, stamp.height, "stamp placement");

  const existing = mapEvents(map);
  if (includeEvents && stamp.events.length > 0) {
    const taken = new Set<string>();
    for (const e of existing) {
      if (e && typeof e.x === "number" && typeof e.y === "number") taken.add(`${e.x},${e.y}`);
    }
    const clashes = stamp.events
      .filter((e) => taken.has(`${x + e.dx},${y + e.dy}`))
      .map((e) => `(${x + e.dx}, ${y + e.dy})`);
    if (clashes.length > 0) {
      throw new ProjectError(
        `Nothing was placed: events already stand on ${clashes.join(", ")}. Move the stamp, or pass includeEvents: false to place only the tiles.`
      );
    }
  }

  const before = map.data.slice();
  for (let z = 0; z < LAYER_COUNT; z++) {
    for (let yy = 0; yy < stamp.height; yy++) {
      for (let xx = 0; xx < stamp.width; xx++) {
        map.data[(z * map.height + y + yy) * map.width + x + xx] = stamp.layers[z][yy * stamp.width + xx];
      }
    }
  }

  const ops: PaintOp[] = [];
  const x0 = Math.max(0, x - 1);
  const y0 = Math.max(0, y - 1);
  const x1 = Math.min(map.width - 1, x + stamp.width);
  const y1 = Math.min(map.height - 1, y + stamp.height);
  for (let z = 0; z < 4; z++) {
    const byKind = new Map<number, { x: number; y: number }[]>();
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const id = map.data[(z * map.height + yy) * map.width + xx];
        if (!isAutotile(id)) continue;
        const kind = autotileKind(id);
        const list = byKind.get(kind) ?? [];
        list.push({ x: xx, y: yy });
        byKind.set(kind, list);
      }
    }
    for (const [kind, cells] of byKind) {
      ops.push({ type: "cells", tile: { sheet: sheetOfAutotileKind(kind), kind }, layer: z, cells });
    }
  }
  try {
    applyPaintOps(map, ops);
  } catch (err) {
    map.data.splice(0, map.data.length, ...before);
    throw new ProjectError(err instanceof Error ? err.message : String(err));
  }

  const eventIds: number[] = [];
  if (includeEvents && stamp.events.length > 0) {
    if (!Array.isArray(map.events)) map.events = [null];
    const list = map.events as unknown[];
    if (list.length === 0) list.push(null);
    let next = list.length;
    for (const e of list) {
      const id = (e as { id?: unknown } | null)?.id;
      if (typeof id === "number" && id >= next) next = id + 1;
    }
    for (const { dx, dy, event } of stamp.events) {
      const id = next++;
      list[id] = { ...structuredClone(event), id, x: x + dx, y: y + dy };
      eventIds.push(id);
    }
    // Holes are only possible if an id jumped past the end; keep them null, not undefined.
    for (let i = 0; i < list.length; i++) if (list[i] === undefined) list[i] = null;
  }

  let cellsChanged = 0;
  for (let i = 0; i < map.data.length; i++) if (map.data[i] !== before[i]) cellsChanged++;
  return { cellsChanged, eventIds };
}

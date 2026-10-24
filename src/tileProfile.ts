// Tile profiles: which tile a map generator paints for each role (floor, wall, wall top, decor).
// suggestTileProfile works from the tileset's data only (assigned images, passability flags,
// autotile rules and the sheet layout); it does not recognise any tileset by its name.

import { z } from "zod";
import { type MvTileset, tileSpecSchema } from "./tools/tileTools.js";
import {
  KIND_RANGE,
  SHEET_NAME_INDEX,
  type Sheet,
  TileError,
  type TileSpec,
  autotileId,
  describeTile,
  kindBlock,
  resolveTile,
  sheetBase,
  sheetTileCount,
  tableType,
} from "./tiles.js";

export interface TileProfile {
  floor: TileSpec;
  wall: TileSpec;
  wallTop?: TileSpec;
  decor?: { tile: TileSpec; weight: number }[];
}

export const tileProfileSchema = z.object({
  floor: tileSpecSchema.describe("Tile for walkable floor cells"),
  wall: tileSpecSchema.describe("Tile for wall cells (should be impassable)"),
  wallTop: tileSpecSchema.optional().describe("Optional tile for the top of walls, e.g. an A4 wall-top kind"),
  decor: z
    .array(z.object({ tile: tileSpecSchema, weight: z.number().positive() }))
    .optional()
    .describe("Optional decoration tiles scattered on the floor, picked in proportion to their weight"),
});

// Same reading of the flags as get_tileset_info: all four direction bits set means blocked.
const isBlocked = (flags: number[], id: number): boolean => ((flags[id] ?? 0) & 0xf) === 0xf;

const hasImage = (tileset: MvTileset, sheet: Sheet): boolean => !!tileset.tilesetNames?.[SHEET_NAME_INDEX[sheet]];

function firstKind(sheet: "A2" | "A4", accept: (kind: number) => boolean): number | undefined {
  const [lo, hi] = KIND_RANGE[sheet];
  for (let kind = lo; kind <= hi; kind++) if (accept(kind)) return kind;
  return undefined;
}

function firstIndex(sheet: "A5" | "B", accept: (id: number) => boolean): number | undefined {
  // B index 0 is the empty tile (id 0), never a real choice.
  for (let index = sheet === "B" ? 1 : 0; index < sheetTileCount(sheet); index++) {
    if (accept(sheetBase(sheet) + index)) return index;
  }
  return undefined;
}

/**
 * The floor-rule A4 kind whose preview block sits directly above wall-side `kind` in the same
 * columns of the A4 sheet (the sheet alternates rows of 2x3 wall-top and 2x2 wall-side blocks).
 */
function wallTopAbove(kind: number): number | undefined {
  const side = kindBlock(kind);
  return firstKind("A4", (k) => {
    if (tableType(k) !== "floor") return false;
    const top = kindBlock(k);
    return top.x === side.x && top.y + top.h === side.y;
  });
}

/**
 * Propose a profile from tileset data. Heuristic:
 * - floor: the lowest-numbered A2 kind whose flags say passable, else the first passable A5 tile;
 * - wall: the lowest-numbered A4 kind drawn with the wall rule whose flags say impassable,
 *   else the first impassable A5 tile, else the first impassable B tile;
 * - wallTop: only for an A4 wall, the floor-rule A4 kind drawn directly above it on the sheet;
 * - decor: never suggested.
 * Sheets without an assigned image are skipped. Every choice adds a line to `notes`.
 * Throws a TileError when no floor or wall tile can be found.
 */
export function suggestTileProfile(tileset: MvTileset): { profile: TileProfile; notes: string[] } {
  const flags = tileset.flags ?? [];
  const notes = [
    "Suggested from the tileset's assigned images, passability flags and sheet layout only; check the tiles with get_tileset_image.",
  ];

  let floor: TileSpec;
  const floorKind = hasImage(tileset, "A2") ? firstKind("A2", (k) => !isBlocked(flags, autotileId(k))) : undefined;
  if (floorKind !== undefined) {
    floor = { sheet: "A2", kind: floorKind };
    notes.push(`floor: A2 kind ${floorKind}, the lowest-numbered A2 ground kind whose flags say passable.`);
  } else {
    const why = hasImage(tileset, "A2") ? "A2 has no passable kind" : "A2 has no image";
    const index = hasImage(tileset, "A5") ? firstIndex("A5", (id) => !isBlocked(flags, id)) : undefined;
    if (index === undefined) {
      const a5 = hasImage(tileset, "A5") ? "A5 has no passable tile" : "A5 has no image";
      throw new TileError(`No floor tile found in tileset ${tileset.id}: ${why} and ${a5}. Give the floor tile yourself.`);
    }
    floor = { sheet: "A5", index };
    notes.push(`floor: A5 #${index}, the first passable A5 tile (${why}).`);
  }

  let wall: TileSpec | undefined;
  let wallTop: TileSpec | undefined;
  const wallKind = hasImage(tileset, "A4")
    ? firstKind("A4", (k) => tableType(k) === "wall" && isBlocked(flags, autotileId(k)))
    : undefined;
  if (wallKind !== undefined) {
    wall = { sheet: "A4", kind: wallKind };
    notes.push(`wall: A4 kind ${wallKind}, the lowest-numbered A4 kind drawn with the wall rule whose flags say impassable.`);
    const topKind = wallTopAbove(wallKind);
    if (topKind !== undefined) {
      wallTop = { sheet: "A4", kind: topKind };
      notes.push(`wallTop: A4 kind ${topKind}, the floor-rule A4 kind drawn directly above kind ${wallKind} on the sheet.`);
    } else {
      notes.push(`wallTop: not set, no floor-rule A4 kind is drawn directly above kind ${wallKind} on the sheet.`);
    }
  } else {
    const why = hasImage(tileset, "A4") ? "A4 has no impassable wall-rule kind" : "A4 has no image";
    for (const sheet of ["A5", "B"] as const) {
      const index = hasImage(tileset, sheet) ? firstIndex(sheet, (id) => isBlocked(flags, id)) : undefined;
      if (index === undefined) continue;
      wall = { sheet, index };
      notes.push(`wall: ${sheet} #${index}, the first impassable ${sheet} tile (${why}).`);
      break;
    }
    if (!wall) {
      throw new TileError(
        `No wall tile found in tileset ${tileset.id}: ${why} and no A5 or B sheet with an image has an impassable tile. Give the wall tile yourself.`
      );
    }
    notes.push("wallTop: not set, because the wall is not an A4 wall kind.");
  }
  notes.push("decor: not suggested; add tiles (e.g. from B-E) with weights if you want scattered details.");

  const profile: TileProfile = { floor, wall };
  if (wallTop) profile.wallTop = wallTop;
  return { profile, notes };
}

/** Problems with a profile on a tileset: invalid tiles, sheets without an image, an impassable floor, a passable wall. */
export function profileProblems(profile: TileProfile, tileset: MvTileset): string[] {
  const flags = tileset.flags ?? [];
  const roles: [string, TileSpec][] = [
    ["floor", profile.floor],
    ["wall", profile.wall],
  ];
  if (profile.wallTop !== undefined) roles.push(["wallTop", profile.wallTop]);
  profile.decor?.forEach((d, i) => roles.push([`decor[${i}]`, d.tile]));

  const problems: string[] = [];
  for (const [role, spec] of roles) {
    let tile;
    try {
      tile = resolveTile(spec);
    } catch (err) {
      if (!(err instanceof TileError)) throw err;
      problems.push(`${role}: ${err.message}`);
      continue;
    }
    if (!tile.sheet) {
      problems.push(`${role}: tile 0 is the empty tile.`);
      continue;
    }
    const name = describeTile(tile.id);
    if (!hasImage(tileset, tile.sheet)) {
      problems.push(`${role}: ${name} is on sheet ${tile.sheet}, which has no image in tileset ${tileset.id}, so it would be invisible.`);
    }
    if (role === "floor" && isBlocked(flags, tile.id)) {
      problems.push(`floor: ${name} is impassable, so the floor could not be walked on.`);
    }
    if (role === "wall" && !isBlocked(flags, tile.id)) {
      problems.push(`wall: ${name} is passable, so the player could walk through walls.`);
    }
  }
  return problems;
}

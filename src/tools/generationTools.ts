import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mulberry32 } from "../battle.js";
import { GenError, type Layout, type Point } from "../gen/layout.js";
import { generateCave } from "../gen/cave.js";
import { generateDungeon } from "../gen/dungeon.js";
import { layoutToPaintOps, verifyReachable } from "../gen/materialize.js";
import { passableGrid } from "../passability.js";
import { Project, ProjectError } from "../project.js";
import { MAX_STAMP_SIZE, STAMP_DIR, type Stamp, captureStamp, checkStamp, placeStamp, stampFile } from "../stamps.js";
import { type TileProfile, profileProblems, suggestTileProfile, tileProfileSchema } from "../tileProfile.js";
import { LAYER_COUNT, TileError, applyPaintOps } from "../tiles.js";
import { safe, textResult } from "../util.js";
import { DEFAULT_EVENT_PAGE, type MvEvent, type MvMap, addMapToProject, blankMap } from "./mapTools.js";
import { checkSheetsAvailable, loadTileset } from "./tileTools.js";

const MAX_CHESTS = 20;

/** Run `fn`, turning the generators' and the tile code's caller-fixable errors into ProjectErrors. */
function asProjectError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof GenError || err instanceof TileError) throw new ProjectError(err.message);
    throw err;
  }
}

/**
 * Cells for chest markers: walkable layout floor, not within one cell (Chebyshev) of the entrance or exit,
 * and picked only while the walkable cells that are not chests all stay reachable from the entrance, so a
 * chest standing in a one-wide corridor can never cut the player off. Fewer than `count` cells come back
 * when not enough fit.
 */
function pickChestCells(layout: Layout, walkable: Uint8Array, seed: number, count: number): Point[] {
  const { width, height, floor } = layout;
  const cellCount = width * height;
  const near = (x: number, y: number): boolean =>
    [layout.entrance, layout.exit].some((p) => Math.abs(p.x - x) <= 1 && Math.abs(p.y - y) <= 1);
  const eligible: number[] = [];
  let walkableCount = 0;
  for (let i = 0; i < cellCount; i++) {
    if (!walkable[i]) continue;
    walkableCount++;
    if (floor[i] && !near(i % width, Math.floor(i / width))) eligible.push(i);
  }

  const blocked = new Uint8Array(cellCount);
  const queue = new Int32Array(cellCount);
  const start = layout.entrance.y * width + layout.entrance.x;
  /** True when every walkable, unblocked cell is reachable from the entrance (4-neighbour). */
  const stillConnected = (blockedCount: number): boolean => {
    const seen = new Uint8Array(cellCount);
    let head = 0;
    let tail = 0;
    seen[start] = 1;
    queue[tail++] = start;
    const visit = (i: number): void => {
      if (walkable[i] && !blocked[i] && !seen[i]) {
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
      if (cur + width < cellCount) visit(cur + width);
    }
    return tail === walkableCount - blockedCount;
  };

  const rng = mulberry32(seed ^ 0x9e3779b9);
  const picked: Point[] = [];
  while (picked.length < count && eligible.length > 0) {
    const k = Math.floor(rng() * eligible.length);
    const cell = eligible[k];
    eligible[k] = eligible[eligible.length - 1];
    eligible.pop();
    blocked[cell] = 1;
    if (stillConnected(picked.length + 1)) picked.push({ x: cell % width, y: Math.floor(cell / width) });
    else blocked[cell] = 0;
  }
  return picked;
}

export function registerGenerationTools(server: McpServer, project: Project): void {
  server.registerTool(
    "generate_map",
    {
      title: "Generate map",
      description:
        "Procedurally generate a dungeon (rooms joined by corridors) or a cave (organic, one connected region) and paint it with a tile profile. " +
        "Give exactly one of `mapId` (generate into an existing map, using its size and tileset) or `create` (make a new map and register it in MapInfos.json). " +
        "An existing map that has any tile or any event is refused unless `overwrite` is true; overwrite resets every tile layer and removes all events. " +
        "`seed` makes the result repeatable; when omitted a random seed is picked, and the seed used is always returned. " +
        "The profile (floor, wall, optional wallTop, optional weighted decor) defaults to suggestTileProfile, which works from the tileset's data only: " +
        "the lowest-numbered walkable A2 kind as floor (else the first walkable A5 tile), the lowest-numbered blocking A4 wall kind as wall with the floor-rule A4 kind above it as wall top " +
        "(else the first blocking A5 or B tile), and no decor. The profile used and the reasoning are returned as profileUsed and profileNotes. " +
        "Nothing is written when the profile's floor is not walkable, its wall or wall top does not block movement, a sheet has no image, or the painted map is not fully reachable from the entrance. " +
        "Markers are empty placeholder events at priority 0 (below characters, so they never block the player) named Entrance, Exit and Chest 1..n, placed on floor cells; " +
        "chests are random floor cells away from the entrance and exit, chosen so that no chest cuts off any part of the map. `markers` defaults to {entrance: true, exit: true, chests: 0}. " +
        "The result lists each marker's eventId and position under `markers`. " +
        "Afterwards: call render_map_image to look at the result (consider showPassability); wire doors to other maps with connect_maps using the returned entrance and exit coordinates; " +
        "fill the chest markers with create_event_from_template or the event tools. A marker occupies its tile: delete it with delete_event before placing a door or chest there, " +
        "or pass allowOverlap (connect_maps) / allowStack (create_event_from_template) to place on top of it. " +
        "A dungeon needs a map of at least 14x7 (or 7x14) cells; smaller maps are refused with a clear error (caves need roughly 9x9 or more; very small caves may fail the minimum floor share and are refused). " +
        "Limits: decor is best-effort (sparse, only on open floor), and wall faces are a one-row simplification, since many tilesets draw wall sides two or more tiles tall.",
      inputSchema: {
        kind: z.enum(["dungeon", "cave"]),
        mapId: z.number().int().min(1).optional().describe("Existing map to generate into (use instead of `create`)"),
        create: z
          .object({
            name: z.string().min(1),
            width: z.number().int().min(5).max(256),
            height: z.number().int().min(5).max(256),
            tilesetId: z.number().int().min(1),
            parentId: z.number().int().min(0).default(0).describe("Parent map id in the editor tree (0 = top level)"),
          })
          .optional()
          .describe("New map to create (use instead of `mapId`)"),
        seed: z.number().int().optional().describe("Same seed, size and options give the same layout; random when omitted"),
        profile: tileProfileSchema.optional().describe("Tiles to paint with; defaults to a suggestion from the tileset"),
        markers: z
          .object({
            entrance: z.boolean().default(true),
            exit: z.boolean().default(true),
            chests: z.number().int().min(0).max(MAX_CHESTS).default(0),
          })
          .optional(),
        overwrite: z.boolean().default(false).describe("Allow replacing a map that already has tiles or events"),
      },
    },
    safe(async ({ kind, mapId, create, seed: seedArg, profile: profileArg, markers, overwrite }) => {
      if ((mapId === undefined) === (create === undefined)) {
        throw new ProjectError("Give exactly one of `mapId` (an existing map) or `create` (a new map).");
      }
      if (create && overwrite) {
        throw new ProjectError("`overwrite` only applies to an existing map (`mapId`); a map made with `create` is always new.");
      }
      const wantEntrance = markers?.entrance ?? true;
      const wantExit = markers?.exit ?? true;
      const wantChests = markers?.chests ?? 0;

      // Everything below runs before the first write, so a refusal leaves the project untouched.
      let map: MvMap;
      if (create) {
        map = blankMap(create.name, create.width, create.height, create.tilesetId);
      } else {
        map = await project.readJson<MvMap>(project.mapFile(mapId!));
        const hasEvents = Array.isArray(map.events) && map.events.some((e) => e != null);
        const hasTiles = Array.isArray(map.data) && map.data.some((id) => id !== 0);
        if (!overwrite && (hasTiles || hasEvents)) {
          throw new ProjectError(
            `Map ${mapId} already has ${[hasTiles && "tiles", hasEvents && "events"].filter(Boolean).join(" and ")}. ` +
              `Pass overwrite: true to regenerate it from scratch (this resets all tile layers and removes all events; a backup is kept), or use \`create\` for a new map.`
          );
        }
        if (overwrite) {
          map.data = new Array(map.width * map.height * LAYER_COUNT).fill(0);
          map.events = [null];
        } else if (!Array.isArray(map.events) || map.events.length === 0) {
          map.events = [null];
        }
      }

      const tilesetId = map.tilesetId as number;
      const tileset = await loadTileset(project, tilesetId);
      if (!tileset) throw new ProjectError(`Tileset ${tilesetId} does not exist in Tilesets.json.`);

      let profile: TileProfile;
      let profileNotes: string[];
      if (profileArg) {
        profile = profileArg as TileProfile;
        profileNotes = ["Profile supplied by the caller."];
      } else {
        ({ profile, notes: profileNotes } = asProjectError(() => suggestTileProfile(tileset)));
      }
      const problems = profileProblems(profile, tileset);
      if (problems.length > 0) {
        throw new ProjectError(`The tile profile cannot be used with tileset ${tileset.id}:\n- ${problems.join("\n- ")}`);
      }

      const seed = seedArg ?? Math.floor(Math.random() * 0x7fffffff);
      const layout = asProjectError(() =>
        kind === "dungeon"
          ? generateDungeon({ width: map.width, height: map.height, seed })
          : generateCave({ width: map.width, height: map.height, seed })
      );

      const painted = asProjectError(() => applyPaintOps(map, layoutToPaintOps(layout, profile, seed)));
      checkSheetsAvailable(tileset, painted.sheetsUsed);

      const flags = tileset.flags ?? [];
      const check = asProjectError(() => verifyReachable(map, flags, layout.entrance, layout));
      if (check.reachable !== check.expected) {
        const sample = check.unreachable.slice(0, 5).map((p) => `(${p.x}, ${p.y})`).join(", ");
        throw new ProjectError(
          `The painted map is not fully connected: ${check.reachable} of ${check.expected} floor cells are reachable from the entrance (e.g. ${sample}). ` +
            `Nothing was written. Pick another floor or decor tile, or another seed.`
        );
      }

      const notes: string[] = [];
      const chests = pickChestCells(layout, passableGrid(map, flags), seed, wantChests);
      if (chests.length < wantChests) {
        notes.push(`Requested ${wantChests} chests but only ${chests.length} cells could hold one without standing next to the entrance or exit or cutting off part of the map, so ${chests.length} were created.`);
      }

      // Placeholder events sit below the characters (priority 0), so they never block the player.
      const addMarker = (name: string, at: Point): { eventId: number; x: number; y: number } => {
        const page = structuredClone(DEFAULT_EVENT_PAGE);
        page.priorityType = 0;
        const event: MvEvent = { id: map.events.length, name, x: at.x, y: at.y, note: "", pages: [page] };
        map.events.push(event);
        return { eventId: event.id, x: at.x, y: at.y };
      };
      const markerIds = {
        ...(wantEntrance ? { entrance: addMarker("Entrance", layout.entrance) } : {}),
        ...(wantExit ? { exit: addMarker("Exit", layout.exit) } : {}),
        chests: chests.map((at, i) => addMarker(`Chest ${i + 1}`, at)),
      };

      let resultMapId: number;
      if (create) {
        resultMapId = await addMapToProject(project, create, map);
      } else {
        resultMapId = mapId!;
        await project.writeJson(project.mapFile(resultMapId), map);
      }

      return textResult({
        mapId: resultMapId,
        seed,
        entrance: layout.entrance,
        exit: layout.exit,
        chests,
        markers: markerIds,
        profileUsed: profile,
        profileNotes,
        reachability: { reachable: check.reachable, expected: check.expected },
        notes,
      });
    })
  );

  server.registerTool(
    "capture_stamp",
    {
      title: "Capture stamp",
      description:
        "Save a rectangle of a map as a reusable stamp in <project>/.mcp-stamps/<name>.json: all six layers (tiles, shadow bits, regions) and, with includeEvents (default true), the events standing inside it. " +
        "Use place_stamp to paste it onto any map of the same tileset. Width and height are 1-64 and the whole rectangle must lie inside the map. " +
        "Names are 1-64 characters (letters, digits, space, _ and -, starting with a letter or digit). An existing stamp is only replaced when overwrite is true. " +
        "Stamps are written like any project file, so inside an open changeset they are only staged until commit_changeset. Add .mcp-stamps/ to .gitignore next to .mcp-backups/ unless you want to share stamps.",
      inputSchema: {
        mapId: z.number().int().min(1),
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(1).max(MAX_STAMP_SIZE),
        height: z.number().int().min(1).max(MAX_STAMP_SIZE),
        name: z.string().describe("Stamp name, e.g. \"well\" or \"Tavern 2\""),
        includeEvents: z.boolean().default(true).describe("Also capture the events inside the rectangle"),
        overwrite: z.boolean().default(false).describe("Replace a stamp that already has this name"),
      },
    },
    safe(async ({ mapId, x, y, width, height, name, includeEvents, overwrite }) => {
      const file = stampFile(project.root, name);
      if (!overwrite && (await project.exists(file))) {
        throw new ProjectError(`A stamp named "${name}" already exists. Pass overwrite: true to replace it, or pick another name.`);
      }
      const map = await project.readJson<MvMap>(project.mapFile(mapId));
      const stamp = captureStamp(map, name, x, y, width, height, includeEvents);
      await project.writeJson(file, stamp);
      return textResult({ name, width, height, tilesetId: stamp.tilesetId, events: stamp.events.length, file: path.relative(project.root, file).split(path.sep).join("/") });
    })
  );

  server.registerTool(
    "place_stamp",
    {
      title: "Place stamp",
      description:
        "Paste a stamp made with capture_stamp onto a map with its top-left corner at (x, y). The whole stamp must fit inside the map (it is never clipped) and the map must use the same tileset the stamp was captured from. " +
        "The rectangle is REPLACED on every layer: empty stamp cells erase what was there. Autotile cells (A1-A4) are re-shaped so their edges blend with the surroundings, including the cells next to the stamp; all other tiles, shadow bits and regions are copied as they are. " +
        "With includeEvents (default true) the stamp's events are added with new ids and moved to the placement; if one would land on a cell that already has an event, nothing is placed and the cells are listed (includeEvents: false places only the tiles). " +
        "There is no rotate or mirror. A backup of the map is kept.",
      inputSchema: {
        mapId: z.number().int().min(1),
        x: z.number().int().min(0).describe("Left edge of the placement"),
        y: z.number().int().min(0).describe("Top edge of the placement"),
        name: z.string().describe("Stamp name"),
        includeEvents: z.boolean().default(true),
      },
    },
    safe(async ({ mapId, x, y, name, includeEvents }) => {
      const file = stampFile(project.root, name);
      if (!(await project.exists(file))) {
        throw new ProjectError(`No stamp named "${name}". Call list_stamps to see the stamps, or capture_stamp to make one.`);
      }
      const stamp = await project.readJson<Stamp>(file);
      checkStamp(stamp, name);
      const map = await project.readJson<MvMap>(project.mapFile(mapId));
      if (map.tilesetId !== stamp.tilesetId) {
        throw new ProjectError(
          `Stamp "${name}" was captured from a map using tileset ${stamp.tilesetId}, but map ${mapId} uses tileset ${String(map.tilesetId)}. ` +
            `Tile ids only match within one tileset; use set_map_tileset first or capture a stamp from a map with tileset ${String(map.tilesetId)}.`
        );
      }
      const result = placeStamp(map, stamp, x, y, includeEvents);
      await project.writeJson(project.mapFile(mapId), map);
      return textResult({
        mapId,
        placed: { x, y, width: stamp.width, height: stamp.height },
        cellsChanged: result.cellsChanged,
        eventIds: result.eventIds,
      });
    })
  );

  server.registerTool(
    "list_stamps",
    {
      title: "List stamps",
      description:
        "List the stamps saved in <project>/.mcp-stamps/ (name, size, tilesetId, event count), sorted by name. Stamps captured inside a changeset that is still open are not listed until it is committed.",
      inputSchema: {},
    },
    safe(async () => {
      const dir = path.join(project.root, STAMP_DIR);
      let entries: string[] = [];
      try {
        entries = await fs.readdir(dir);
      } catch {
        // no stamps captured yet
      }
      const stamps: { name: string; width: number; height: number; tilesetId: number; events: number }[] = [];
      const skipped: string[] = [];
      for (const entry of entries.filter((e) => e.endsWith(".json")).sort()) {
        const name = entry.slice(0, -".json".length);
        try {
          const stamp = await project.readJson<Stamp>(stampFile(project.root, name));
          checkStamp(stamp, name);
          stamps.push({ name, width: stamp.width, height: stamp.height, tilesetId: stamp.tilesetId, events: stamp.events.length });
        } catch {
          skipped.push(entry);
        }
      }
      return textResult(skipped.length > 0 ? { stamps, skipped } : { stamps });
    })
  );
}

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

/** Cells for chest markers: walkable layout floor, not within one cell (Chebyshev) of the entrance or exit. */
function pickChestCells(layout: Layout, walkable: Uint8Array, seed: number, count: number): Point[] {
  const { width, height, floor } = layout;
  const near = (x: number, y: number): boolean =>
    [layout.entrance, layout.exit].some((p) => Math.abs(p.x - x) <= 1 && Math.abs(p.y - y) <= 1);
  const eligible: Point[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (floor[y * width + x] && walkable[y * width + x] && !near(x, y)) eligible.push({ x, y });
    }
  }
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const picked: Point[] = [];
  while (picked.length < count && eligible.length > 0) {
    const i = Math.floor(rng() * eligible.length);
    picked.push(eligible[i]);
    eligible[i] = eligible[eligible.length - 1];
    eligible.pop();
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
        "Markers are empty events named Entrance, Exit and Chest 1..n placed on floor cells (chests are random floor cells away from the entrance and exit); " +
        "`markers` defaults to {entrance: true, exit: true, chests: 0}. " +
        "Afterwards: call render_map_image to look at the result (consider showPassability); wire doors to other maps with connect_maps using the returned entrance and exit coordinates; " +
        "fill the chest markers with create_event_from_template or the event tools. " +
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
        } else if (!Array.isArray(map.events)) {
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
        notes.push(`Requested ${wantChests} chests but only ${chests.length} walkable cells were free of the entrance and exit, so ${chests.length} were created.`);
      }

      const markerEvents: { name: string; at: Point }[] = [];
      if (wantEntrance) markerEvents.push({ name: "Entrance", at: layout.entrance });
      if (wantExit) markerEvents.push({ name: "Exit", at: layout.exit });
      chests.forEach((at, i) => markerEvents.push({ name: `Chest ${i + 1}`, at }));
      for (const { name, at } of markerEvents) {
        const event: MvEvent = {
          id: map.events.length,
          name,
          x: at.x,
          y: at.y,
          note: "",
          pages: [structuredClone(DEFAULT_EVENT_PAGE)],
        };
        map.events.push(event);
      }

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

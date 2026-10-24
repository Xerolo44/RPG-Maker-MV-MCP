import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Project, ProjectError } from "../project.js";
import { safe, textResult } from "../util.js";
import { TileError, TileSpec, applyPaintOps } from "../tiles.js";
import { EVENT_COMMAND_REFERENCE } from "../reference.js";
import { messageCommands } from "../dialogueTree.js";
import { checkSheetsAvailable, loadTileset, tileSpecSchema } from "./tileTools.js";

interface MapInfo {
  id: number;
  name: string;
  parentId: number;
  order: number;
  expanded?: boolean;
  scrollX?: number;
  scrollY?: number;
}

interface MvEvent {
  id: number;
  name: string;
  x: number;
  y: number;
  note?: string;
  pages: unknown[];
}

interface MvMap {
  width: number;
  height: number;
  data: number[];
  events: (MvEvent | null)[];
  [key: string]: unknown;
}

export const DEFAULT_EVENT_PAGE = {
  conditions: {
    actorId: 1,
    actorValid: false,
    itemId: 1,
    itemValid: false,
    selfSwitchCh: "A",
    selfSwitchValid: false,
    switch1Id: 1,
    switch1Valid: false,
    switch2Id: 1,
    switch2Valid: false,
    variableId: 1,
    variableValid: false,
    variableValue: 0,
  },
  directionFix: false,
  image: {
    tileId: 0,
    characterName: "",
    direction: 2,
    pattern: 1,
    characterIndex: 0,
  },
  list: [{ code: 0, indent: 0, parameters: [] }],
  moveFrequency: 3,
  moveRoute: {
    list: [{ code: 0, parameters: [] }],
    repeat: true,
    skippable: false,
    wait: false,
  },
  moveSpeed: 3,
  moveType: 0,
  priorityType: 1,
  stepAnime: false,
  through: false,
  trigger: 0,
  walkAnime: true,
};

async function readMap(project: Project, mapId: number): Promise<MvMap> {
  return project.readJson<MvMap>(project.mapFile(mapId));
}

export async function insertEventCommands(
  project: Project,
  mapId: number,
  eventId: number,
  pageIndex: number,
  commands: { code: number; indent: number; parameters: unknown[] }[],
  index?: number
): Promise<{ inserted: number; at: number; listLength: number; page: number }> {
  const file = project.mapFile(mapId);
  const map = await project.readJson<MvMap>(file);
  const event = map.events?.[eventId];
  if (event == null) {
    throw new ProjectError(`Map ${mapId} has no event with id ${eventId}.`);
  }
  const page = event.pages[pageIndex] as { list?: unknown[] } | undefined;
  if (!page) {
    throw new ProjectError(
      `Event ${eventId} on map ${mapId} has no page ${pageIndex} (it has ${event.pages.length}).`
    );
  }
  if (!Array.isArray(page.list)) page.list = [{ code: 0, indent: 0, parameters: [] }];
  const last = page.list[page.list.length - 1] as { code?: number } | undefined;
  const terminatorAtEnd = last?.code === 0;
  const defaultPos = terminatorAtEnd ? page.list.length - 1 : page.list.length;
  const pos = Math.min(index ?? defaultPos, defaultPos);
  page.list.splice(pos, 0, ...commands);
  if (!terminatorAtEnd) page.list.push({ code: 0, indent: 0, parameters: [] });
  await project.writeJson(file, map);
  return { inserted: commands.length, at: pos, listLength: page.list.length, page: pageIndex };
}

function blankMap(name: string, width: number, height: number, tilesetId: number): MvMap {
  return {
    autoplayBgm: false,
    autoplayBgs: false,
    battleback1Name: "",
    battleback2Name: "",
    bgm: { name: "", pan: 0, pitch: 100, volume: 90 },
    bgs: { name: "", pan: 0, pitch: 100, volume: 90 },
    disableDashing: false,
    displayName: name,
    encounterList: [],
    encounterStep: 30,
    height,
    note: "",
    parallaxLoopX: false,
    parallaxLoopY: false,
    parallaxName: "",
    parallaxShow: true,
    parallaxSx: 0,
    parallaxSy: 0,
    scrollType: 0,
    specifyBattleback: false,
    tilesetId,
    width,
    data: new Array(width * height * 6).fill(0),
    events: [null],
  };
}

export function registerMapTools(server: McpServer, project: Project): void {
  server.registerTool(
    "list_maps",
    {
      title: "List maps",
      description: "List all maps from MapInfos.json as {id, name, parentId, order}.",
      inputSchema: {},
    },
    safe(async () => {
      const infos = await project.readJson<(MapInfo | null)[]>(project.dataFile("MapInfos.json"));
      const maps = infos
        .filter((m): m is MapInfo => m != null)
        .map(({ id, name, parentId, order }) => ({ id, name, parentId, order }));
      return textResult(maps);
    })
  );

  server.registerTool(
    "get_map",
    {
      title: "Get map",
      description:
        "Read a map's properties (size, tileset, music, encounters, notes) and event summaries. Tile data is omitted unless includeTileData=true (it is large: width*height*6 integers).",
      inputSchema: {
        mapId: z.number().int().min(1),
        includeTileData: z.boolean().default(false),
      },
    },
    safe(async ({ mapId, includeTileData }) => {
      const map = await readMap(project, mapId);
      const { data, events, ...props } = map;
      const eventSummaries = (events ?? [])
        .filter((e): e is MvEvent => e != null)
        .map((e) => ({ id: e.id, name: e.name, x: e.x, y: e.y, pages: e.pages.length }));
      return textResult({
        mapId,
        ...props,
        events: eventSummaries,
        ...(includeTileData ? { data } : { tileData: `omitted (${data?.length ?? 0} entries)` }),
      });
    })
  );

  server.registerTool(
    "update_map",
    {
      title: "Update map properties",
      description:
        "Shallow-merge fields into a map's JSON (e.g. displayName, note, bgm, encounterList). Refuses to touch 'data' or 'events' — use the event tools for events and paint_tiles for tiles. To switch tilesets prefer set_map_tileset.",
      inputSchema: {
        mapId: z.number().int().min(1),
        data: z.record(z.unknown()).describe("Map property fields to set"),
      },
    },
    safe(async ({ mapId, data }) => {
      if ("data" in data || "events" in data) {
        throw new ProjectError(
          "update_map cannot modify 'data' (tiles) or 'events'. Use paint_tiles for tiles and the event tools for events."
        );
      }
      const file = project.mapFile(mapId);
      const map = await project.readJson<MvMap>(file);
      Object.assign(map, data);
      await project.writeJson(file, map);
      return textResult({ mapId, updatedKeys: Object.keys(data) });
    })
  );

  server.registerTool(
    "get_event",
    {
      title: "Get map event",
      description: "Get the full JSON of one event on a map, including all pages and command lists.",
      inputSchema: {
        mapId: z.number().int().min(1),
        eventId: z.number().int().min(1),
      },
    },
    safe(async ({ mapId, eventId }) => {
      const map = await readMap(project, mapId);
      const event = map.events?.[eventId];
      if (event == null) {
        throw new ProjectError(`Map ${mapId} has no event with id ${eventId}.`);
      }
      return textResult(event);
    })
  );

  server.registerTool(
    "update_event",
    {
      title: "Update map event",
      description:
        "Replace an event on a map with the given event JSON (same shape as returned by get_event). The event's id and its array position stay in sync automatically. See event_command_reference for command codes.",
      inputSchema: {
        mapId: z.number().int().min(1),
        eventId: z.number().int().min(1),
        event: z.record(z.unknown()).describe("Complete event object (name, x, y, note, pages)"),
      },
    },
    safe(async ({ mapId, eventId, event }) => {
      const file = project.mapFile(mapId);
      const map = await project.readJson<MvMap>(file);
      if (map.events?.[eventId] == null) {
        throw new ProjectError(
          `Map ${mapId} has no event with id ${eventId}. Use create_event to add one.`
        );
      }
      map.events[eventId] = { ...(event as object), id: eventId } as MvEvent;
      await project.writeJson(file, map);
      return textResult({ updated: { mapId, eventId } });
    })
  );

  server.registerTool(
    "create_event",
    {
      title: "Create map event",
      description:
        "Add a new event to a map at (x, y). If no pages are given, a single empty page (action-button trigger, no commands) is created. Returns the new event id.",
      inputSchema: {
        mapId: z.number().int().min(1),
        name: z.string(),
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        note: z.string().default(""),
        pages: z
          .array(z.record(z.unknown()))
          .optional()
          .describe("Optional event pages; defaults to one empty page"),
      },
    },
    safe(async ({ mapId, name, x, y, note, pages }) => {
      const file = project.mapFile(mapId);
      const map = await project.readJson<MvMap>(file);
      if (x >= map.width || y >= map.height) {
        throw new ProjectError(
          `Position (${x}, ${y}) is outside map ${mapId} (${map.width}x${map.height}).`
        );
      }
      if (!Array.isArray(map.events)) map.events = [null];
      const id = map.events.length;
      const event: MvEvent = {
        id,
        name,
        x,
        y,
        note,
        pages: (pages as unknown[]) ?? [structuredClone(DEFAULT_EVENT_PAGE)],
      };
      map.events.push(event);
      await project.writeJson(file, map);
      return textResult({ created: { mapId, eventId: id }, event });
    })
  );

  server.registerTool(
    "delete_event",
    {
      title: "Delete map event",
      description:
        "Delete an event from a map. The slot is set to null so other event ids are unaffected (matches editor behavior).",
      inputSchema: {
        mapId: z.number().int().min(1),
        eventId: z.number().int().min(1),
      },
    },
    safe(async ({ mapId, eventId }) => {
      const file = project.mapFile(mapId);
      const map = await project.readJson<MvMap>(file);
      if (map.events?.[eventId] == null) {
        throw new ProjectError(`Map ${mapId} has no event with id ${eventId}.`);
      }
      map.events[eventId] = null;
      await project.writeJson(file, map);
      return textResult({ deleted: { mapId, eventId } });
    })
  );

  server.registerTool(
    "add_event_command",
    {
      title: "Add event commands",
      description:
        "Insert commands into an event page's command list without resending the whole event. Commands are inserted before the page's terminating {code: 0} entry (or at `index` if given). Multi-line constructs work naturally, e.g. Show Text is one code-101 command followed by code-401 commands. See event_command_reference for codes.",
      inputSchema: {
        mapId: z.number().int().min(1),
        eventId: z.number().int().min(1),
        pageIndex: z.number().int().min(0).default(0).describe("Which event page (0-based)"),
        commands: z
          .array(
            z.object({
              code: z.number().int().describe("Event command code"),
              indent: z.number().int().min(0).default(0),
              parameters: z.array(z.unknown()).default([]),
            })
          )
          .min(1)
          .describe("Commands to insert, in order"),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Position in the list to insert at; defaults to the end (before the terminator)"),
      },
    },
    safe(async ({ mapId, eventId, pageIndex, commands, index }) => {
      const result = await insertEventCommands(project, mapId, eventId, pageIndex, commands, index);
      return textResult(result);
    })
  );

  server.registerTool(
    "add_dialogue",
    {
      title: "Add dialogue",
      description:
        "Add spoken dialogue to an event page in one call — builds the Show Text (101) and text-line (401) commands automatically, splitting into multiple message boxes every 4 lines. Inserted before the page's end, like add_event_command.",
      inputSchema: {
        mapId: z.number().int().min(1),
        eventId: z.number().int().min(1),
        pageIndex: z.number().int().min(0).default(0),
        lines: z.array(z.string()).min(1).describe("Dialogue lines (a new message box starts every 4 lines)"),
        faceName: z.string().default("").describe("Face image file (e.g. 'Actor1'), empty for none"),
        faceIndex: z.number().int().min(0).max(7).default(0),
        background: z
          .number()
          .int()
          .min(0)
          .max(2)
          .default(0)
          .describe("0 window, 1 dim, 2 transparent"),
        position: z.number().int().min(0).max(2).default(2).describe("0 top, 1 middle, 2 bottom"),
      },
    },
    safe(async ({ mapId, eventId, pageIndex, lines, faceName, faceIndex, background, position }) => {
      const commands = messageCommands(lines, faceName, faceIndex, background, position, 0);
      const result = await insertEventCommands(project, mapId, eventId, pageIndex, commands);
      return textResult({ ...result, messageBoxes: Math.ceil(lines.length / 4) });
    })
  );

  server.registerTool(
    "create_map",
    {
      title: "Create map",
      description:
        "Create a new map: writes MapXXX.json and registers it in MapInfos.json. The map starts empty unless `fill` is given (a ground tile for layer 0); afterwards use paint_tiles to paint it, get_tileset_info to choose tiles and add events with the event tools. Returns the new map id.",
      inputSchema: {
        name: z.string(),
        width: z.number().int().min(1).max(256).default(17),
        height: z.number().int().min(1).max(256).default(13),
        tilesetId: z.number().int().min(1).default(1),
        parentId: z.number().int().min(0).default(0).describe("Parent map id in the editor tree (0 = top level)"),
        fill: tileSpecSchema.optional().describe("Optional tile to fill layer 0 with, e.g. {sheet:'A2', kind:16} for grass"),
      },
    },
    safe(async ({ name, width, height, tilesetId, parentId, fill }) => {
      const newMap = blankMap(name, width, height, tilesetId);
      if (fill !== undefined) {
        try {
          const painted = applyPaintOps(newMap, [
            { type: "rect", tile: fill as TileSpec, layer: 0, x: 0, y: 0, width, height },
          ]);
          checkSheetsAvailable(await loadTileset(project, tilesetId).catch(() => null), painted.sheetsUsed);
        } catch (err) {
          if (err instanceof TileError) throw new ProjectError(err.message);
          throw err;
        }
      }
      const infosFile = project.dataFile("MapInfos.json");
      const infos = await project.readJson<({ id: number; order: number } | null)[]>(infosFile);
      const id = infos.length;
      const maxOrder = Math.max(0, ...infos.filter((m) => m != null).map((m) => m!.order ?? 0));
      infos.push({
        id,
        expanded: false,
        name,
        order: maxOrder + 1,
        parentId,
        scrollX: (width * 48) / 2,
        scrollY: (height * 48) / 2,
      } as never);
      await project.writeJson(project.mapFile(id), newMap);
      await project.writeJson(infosFile, infos);
      return textResult({ created: { mapId: id, name, width, height, tilesetId, filled: fill !== undefined } });
    })
  );

  server.registerTool(
    "event_command_reference",
    {
      title: "Event command reference",
      description:
        "Reference table of RPG Maker MV event command codes and their parameters. Consult this before writing or editing event command lists.",
      inputSchema: {},
    },
    safe(async () => textResult(EVENT_COMMAND_REFERENCE))
  );
}

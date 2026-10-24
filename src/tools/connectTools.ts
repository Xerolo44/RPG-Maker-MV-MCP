import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Project, ProjectError } from "../project.js";
import { safe, textResult } from "../util.js";
import { DEFAULT_EVENT_PAGE } from "./mapTools.js";

interface ConnEvent {
  id: number;
  name: string;
  x: number;
  y: number;
  note?: string;
  pages: { list?: { code: number; parameters: unknown[] }[]; [key: string]: unknown }[];
}

interface ConnMap {
  width: number;
  height: number;
  events: (ConnEvent | null)[];
  [key: string]: unknown;
}

interface MapInfoEntry {
  id: number;
  name: string;
}

const pointSchema = z.object({ x: z.number().int().min(0), y: z.number().int().min(0) });

const directionSchema = z
  .number()
  .int()
  .refine((d) => [0, 2, 4, 6, 8].includes(d), "direction must be 0 (keep), 2, 4, 6 or 8");

const endpointSchema = z.object({
  mapId: z.number().int().min(1),
  door: pointSchema.describe("Tile where this map's exit event is placed"),
  spawn: pointSchema
    .extend({ direction: directionSchema.default(0).describe("Facing on arrival: 0 keep, 2 down, 4 left, 6 right, 8 up") })
    .optional()
    .describe(
      "Where the player appears when they ARRIVE on this map through the connection. Defaults to the door tile - give a spawn tile in front of the door when the door is in a wall."
    ),
});

type Endpoint = z.infer<typeof endpointSchema>;

const FADE = { black: 0, white: 1, none: 2 } as const;

async function mapNames(project: Project): Promise<Map<number, string>> {
  const infos = await project.readJson<(MapInfoEntry | null)[]>(project.dataFile("MapInfos.json"));
  return new Map(infos.filter((m): m is MapInfoEntry => m != null).map((m) => [m.id, m.name]));
}

function transferCommands(event: ConnEvent): { page: number; params: unknown[] }[] {
  const found: { page: number; params: unknown[] }[] = [];
  event.pages.forEach((page, pageIndex) => {
    for (const cmd of page.list ?? []) if (cmd.code === 201) found.push({ page: pageIndex, params: cmd.parameters });
  });
  return found;
}

export function registerConnectTools(server: McpServer, project: Project): void {
  server.registerTool(
    "connect_maps",
    {
      title: "Connect two maps",
      description:
        "Link two maps with Transfer Player events in both directions in one call. A door event is placed on each map; stepping on (or pressing OK at) the door on map A moves the player to map B's spawn tile and vice versa. " +
        "Give each side its `door` tile; add `spawn` when the player should appear next to the door instead of on it (always do this for doors drawn into walls). " +
        "Both maps are validated before anything is written, and a door is refused if another event already stands on that tile (allowOverlap overrides). Use twoWay=false for a one-way link (map A's door only). " +
        "Check the result with render_map_image (doors show as blue markers) and list_map_connections.",
      inputSchema: {
        a: endpointSchema,
        b: endpointSchema,
        twoWay: z.boolean().default(true).describe("Create the return door on map B as well"),
        trigger: z
          .enum(["touch", "action"])
          .default("touch")
          .describe("touch = player walks onto the door tile, action = player presses OK facing it"),
        fade: z.enum(["black", "white", "none"]).default("black"),
        doorName: z.string().optional().describe("Event name prefix; default 'To <destination map name>'"),
        sound: z
          .object({ name: z.string(), volume: z.number().int().min(0).max(100).default(90) })
          .optional()
          .describe("Sound effect to play before leaving, e.g. {name: 'Open1'}"),
        allowOverlap: z.boolean().default(false),
      },
    },
    safe(async ({ a, b, twoWay, trigger, fade, doorName, sound, allowOverlap }) => {
      const names = await mapNames(project);
      const maps = new Map<number, ConnMap>();
      const load = async (mapId: number): Promise<ConnMap> => {
        if (!names.has(mapId)) throw new ProjectError(`Map ${mapId} is not listed in MapInfos.json (see list_maps).`);
        let map = maps.get(mapId);
        if (!map) {
          map = await project.readJson<ConnMap>(project.mapFile(mapId));
          if (!Array.isArray(map.events)) map.events = [null];
          maps.set(mapId, map);
        }
        return map;
      };

      const plan: { from: Endpoint; to: Endpoint }[] = [{ from: a, to: b }];
      if (twoWay) plan.push({ from: b, to: a });

      const check = (label: string, map: ConnMap, p: { x: number; y: number }): void => {
        if (p.x >= map.width || p.y >= map.height) {
          throw new ProjectError(`${label} (${p.x}, ${p.y}) is outside map (${map.width}x${map.height}).`);
        }
      };
      for (const { from, to } of plan) {
        const fromMap = await load(from.mapId);
        const toMap = await load(to.mapId);
        check(`Door on map ${from.mapId}`, fromMap, from.door);
        check(`Spawn on map ${to.mapId}`, toMap, to.spawn ?? to.door);
      }
      if (!twoWay) {
        // The return side is not built, but its tiles were still given - validate them anyway.
        check(`Door on map ${b.mapId}`, await load(b.mapId), b.door);
      }

      // Refuse a clash before writing anything.
      const claimed = new Set<string>();
      for (const { from } of plan) {
        const map = maps.get(from.mapId)!;
        const key = `${from.mapId}:${from.door.x},${from.door.y}`;
        const clash = map.events.find((e) => e && e.x === from.door.x && e.y === from.door.y);
        if ((clash || claimed.has(key)) && !allowOverlap) {
          throw new ProjectError(
            `Map ${from.mapId} already has ${clash ? `event #${clash.id} "${clash.name}"` : "the other door"} at (${from.door.x}, ${from.door.y}). ` +
              `Choose another door tile or pass allowOverlap=true.`
          );
        }
        claimed.add(key);
      }

      const warnings: string[] = [];
      const created: { mapId: number; eventId: number; name: string; x: number; y: number; leadsTo: { mapId: number; x: number; y: number } }[] = [];
      for (const { from, to } of plan) {
        const map = maps.get(from.mapId)!;
        const dest = to.spawn ?? { ...to.door, direction: 0 };
        if (!to.spawn) {
          warnings.push(
            `Map ${to.mapId}: no spawn given, the player will arrive on the door tile (${to.door.x}, ${to.door.y}). Pass a spawn tile if the door is inside a wall.`
          );
        }
        const page = structuredClone(DEFAULT_EVENT_PAGE) as Record<string, unknown>;
        page.trigger = trigger === "touch" ? 1 : 0;
        page.priorityType = trigger === "touch" ? 0 : 1;
        const list: { code: number; indent: number; parameters: unknown[] }[] = [];
        if (sound) list.push({ code: 250, indent: 0, parameters: [{ name: sound.name, volume: sound.volume, pan: 0, pitch: 100 }] });
        list.push({ code: 201, indent: 0, parameters: [0, to.mapId, dest.x, dest.y, dest.direction ?? 0, FADE[fade]] });
        list.push({ code: 0, indent: 0, parameters: [] });
        page.list = list;

        const id = map.events.length;
        const name = doorName ? `${doorName} ${id}` : `To ${names.get(to.mapId)}`;
        map.events.push({ id, name, x: from.door.x, y: from.door.y, note: "", pages: [page] } as ConnEvent);
        created.push({ mapId: from.mapId, eventId: id, name, x: from.door.x, y: from.door.y, leadsTo: { mapId: to.mapId, x: dest.x, y: dest.y } });
      }

      for (const [mapId, map] of maps) await project.writeJson(project.mapFile(mapId), map);
      return textResult({ connected: created, twoWay, trigger, warnings });
    })
  );

  server.registerTool(
    "list_map_connections",
    {
      title: "List map connections",
      description:
        "Scan every map's events for Transfer Player commands and show how the maps are linked: each door with its destination, one-way links without a way back, transfers to maps that do not exist, and maps that cannot be reached from the game's start map. " +
        "Transfers whose target is chosen by variables are listed as dynamic and cannot be followed, so 'unreachable' is a hint, not proof.",
      inputSchema: {
        mapId: z.number().int().min(1).optional().describe("Only list doors on this map (the reachability analysis still uses all maps)"),
      },
    },
    safe(async ({ mapId }) => {
      const names = await mapNames(project);
      const system = await project.readJson<{ startMapId?: number }>(project.dataFile("System.json"));
      interface Link { map: number; mapName: string; eventId: number; eventName: string; x: number; y: number; page: number; toMap: number; toX: number; toY: number }
      const links: Link[] = [];
      const dynamic: { map: number; eventId: number; eventName: string }[] = [];

      for (const id of names.keys()) {
        let map: ConnMap;
        try {
          map = await project.readJson<ConnMap>(project.mapFile(id));
        } catch {
          continue;
        }
        for (const ev of map.events ?? []) {
          if (!ev) continue;
          for (const { page, params } of transferCommands(ev)) {
            if (params[0] === 0) {
              links.push({
                map: id, mapName: names.get(id)!, eventId: ev.id, eventName: ev.name, x: ev.x, y: ev.y, page,
                toMap: Number(params[1]), toX: Number(params[2]), toY: Number(params[3]),
              });
            } else dynamic.push({ map: id, eventId: ev.id, eventName: ev.name });
          }
        }
      }

      const has = (from: number, to: number): boolean => links.some((l) => l.map === from && l.toMap === to);
      const missing = links.filter((l) => !names.has(l.toMap));
      const oneWay = links
        .filter((l) => names.has(l.toMap) && l.toMap !== l.map && !has(l.toMap, l.map))
        .map((l) => `map ${l.map} "${l.mapName}" -> map ${l.toMap} "${names.get(l.toMap)}" (event #${l.eventId}) has no door back`);

      const start = system.startMapId ?? 1;
      const seen = new Set<number>([start]);
      const queue = [start];
      while (queue.length) {
        const cur = queue.pop()!;
        for (const l of links) if (l.map === cur && names.has(l.toMap) && !seen.has(l.toMap)) { seen.add(l.toMap); queue.push(l.toMap); }
      }
      const unreachable = [...names.entries()].filter(([id]) => !seen.has(id)).map(([id, name]) => `map ${id} "${name}"`);

      return textResult({
        startMapId: start,
        connections: links
          .filter((l) => mapId === undefined || l.map === mapId)
          .map((l) => `map ${l.map} "${l.mapName}" #${l.eventId} "${l.eventName}" (${l.x},${l.y}) -> map ${l.toMap}${names.has(l.toMap) ? ` "${names.get(l.toMap)}"` : " (MISSING)"} (${l.toX},${l.toY})`),
        brokenTargets: missing.map((l) => `map ${l.map} event #${l.eventId} transfers to missing map ${l.toMap}`),
        oneWayLinks: oneWay,
        unreachableFromStart: unreachable,
        dynamicTransfers: dynamic.length ? dynamic : undefined,
      });
    })
  );
}

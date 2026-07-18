import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Project, ProjectError } from "../project.js";
import { safe, textResult } from "../util.js";

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

const DEFAULT_EVENT_PAGE = {
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

const EVENT_COMMAND_REFERENCE = `RPG Maker MV event command codes (each list entry is {"code": N, "indent": N, "parameters": [...]}; every list ends with {"code": 0, "indent": 0, "parameters": []}):

MESSAGES
101 Show Text setup: [faceName, faceIndex, background(0 window,1 dim,2 transparent), position(0 top,1 middle,2 bottom)] — followed by one 401 per text line
401 Text line: ["the text"]
102 Show Choices: [["Choice A","Choice B"], cancelType, defaultType, positionType, background] — each branch starts with 402 [index, "text"], cancel branch 403, end 404
103 Input Number: [variableId, digits]
105 Show Scrolling Text: [speed, noFast] — lines follow as 405 ["text"]

FLOW CONTROL
111 Conditional Branch: params vary — [0, switchId, 0=ON/1=OFF] for switch; [1, varId, 0, operand, value, op(0:=,1:>=,2:<=,3:>,4:<,5:!=)] for variable — else branch 411, end 412
112 Loop (end 413 Repeat Above), 113 Break Loop, 115 Exit Event Processing
117 Common Event: [commonEventId]
118 Label: ["name"], 119 Jump to Label: ["name"]
230 Wait: [frames] (60 = 1 second)

GAME PROGRESSION
121 Control Switches: [startId, endId, 0=ON/1=OFF]
122 Control Variables: [startId, endId, operation(0:set,1:add,2:sub,3:mul,4:div,5:mod), operandType(0:constant,1:variable,2:random,3:gameData,4:script), ...operands]
123 Control Self Switch: ["A"|"B"|"C"|"D", 0=ON/1=OFF]
124 Control Timer: [0=start/1=stop, seconds]

PARTY
125 Change Gold: [operation(0 add,1 sub), operandType(0 const,1 var), value]
126 Change Items: [itemId, operation, operandType, value]
127/128 Change Weapons/Armors: [id, op, operandType, value, includeEquip]
129 Change Party Member: [actorId, 0=add/1=remove, initialize]

ACTOR
311 Change HP: [actorType(0 fixed,1 var), actorId, op, operandType, value, allowDeath]
312 Change MP, 313 Change State: [..., 0=add/1=remove, stateId]
314 Recover All, 315 Change EXP, 316 Change Level, 317 Change Parameter
318 Change Skill: [actorType, actorId, 0=learn/1=forget, skillId]

MOVEMENT / MAP
201 Transfer Player: [designation(0 direct,1 vars), mapId, x, y, direction(0 retain,2,4,6,8), fadeType]
203 Set Event Location, 204 Scroll Map: [direction, distance, speed]
205 Set Movement Route: [characterId(-1 player,0 this,N eventId), moveRoute] — visual-only mirror entries use 505
211 Change Transparency, 212 Show Animation: [characterId, animationId, wait]
213 Show Balloon Icon: [characterId, balloonId, wait]
216 Change Player Followers, 217 Gather Followers

SCREEN
221 Fadeout Screen, 222 Fadein Screen
223 Tint Screen: [[r,g,b,gray], frames, wait]
224 Flash Screen: [[r,g,b,intensity], frames, wait]
225 Shake Screen: [power, speed, frames, wait]

AUDIO / PICTURES
241 Play BGM / 245 Play BGS / 249 Play ME / 250 Play SE: [{name, volume, pan, pitch}]
242 Fadeout BGM: [seconds], 251 Stop SE
231 Show Picture: [pictureId, "name", origin, designation, x, y, scaleX, scaleY, opacity, blendMode]
232 Move Picture, 235 Erase Picture: [pictureId]

SCENES / BATTLE
301 Battle Processing: [designation(0 direct,1 var,2 random), troopId, canEscape, canLose] — win branch 601, escape 602, lose 603, end 604
302 Shop Processing: [[goodsType, id, priceType, price], purchaseOnly] — extra goods rows as 605
303 Name Input Processing: [actorId, maxChars]
351 Open Menu Screen, 352 Open Save Screen, 353 Game Over, 354 Return to Title

ADVANCED
355 Script: ["js line 1"] — continuation lines 655 ["js line N"]
356 Plugin Command: ["CommandName arg1 arg2"]

Event page "trigger": 0 Action Button, 1 Player Touch, 2 Event Touch, 3 Autorun, 4 Parallel.
Event page "priorityType": 0 Below characters, 1 Same as characters, 2 Above characters.`;

async function readMap(project: Project, mapId: number): Promise<MvMap> {
  return project.readJson<MvMap>(project.mapFile(mapId));
}

async function insertEventCommands(
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
        "Shallow-merge fields into a map's JSON (e.g. displayName, note, bgm, encounterList). Refuses to touch 'data' or 'events' — use dedicated event tools; tile editing is not supported.",
      inputSchema: {
        mapId: z.number().int().min(1),
        data: z.record(z.unknown()).describe("Map property fields to set"),
      },
    },
    safe(async ({ mapId, data }) => {
      if ("data" in data || "events" in data) {
        throw new ProjectError(
          "update_map cannot modify 'data' (tiles) or 'events'. Use the event tools instead."
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
      const commands: { code: number; indent: number; parameters: unknown[] }[] = [];
      for (let i = 0; i < lines.length; i += 4) {
        commands.push({ code: 101, indent: 0, parameters: [faceName, faceIndex, background, position] });
        for (const line of lines.slice(i, i + 4)) {
          commands.push({ code: 401, indent: 0, parameters: [line] });
        }
      }
      const result = await insertEventCommands(project, mapId, eventId, pageIndex, commands);
      return textResult({ ...result, messageBoxes: Math.ceil(lines.length / 4) });
    })
  );

  server.registerTool(
    "create_map",
    {
      title: "Create map",
      description:
        "Create a new blank map: writes MapXXX.json with empty tile data and registers it in MapInfos.json. Tiles must still be painted in the editor, but events, properties, and everything else can be edited here. Returns the new map id.",
      inputSchema: {
        name: z.string(),
        width: z.number().int().min(1).max(256).default(17),
        height: z.number().int().min(1).max(256).default(13),
        tilesetId: z.number().int().min(1).default(1),
        parentId: z.number().int().min(0).default(0).describe("Parent map id in the editor tree (0 = top level)"),
      },
    },
    safe(async ({ name, width, height, tilesetId, parentId }) => {
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
      await project.writeJson(project.mapFile(id), blankMap(name, width, height, tilesetId));
      await project.writeJson(infosFile, infos);
      return textResult({ created: { mapId: id, name, width, height, tilesetId } });
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

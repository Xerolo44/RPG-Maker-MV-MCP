import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Project, ProjectError } from "../project.js";
import { safe } from "../util.js";
import { Bitmap, decodePng, encodePng } from "../png.js";
import { MarkerDraw, SpriteDraw, renderMapBitmap } from "../render.js";
import { LAYER_COUNT, SHEETS, SHEET_NAME_INDEX, Sheet } from "../tiles.js";
import { loadTileset } from "./tileTools.js";

interface EventPage {
  conditions?: Record<string, unknown>;
  image?: { tileId: number; characterName: string; direction: number; pattern: number; characterIndex: number };
  list?: { code: number }[];
  trigger?: number;
}

interface RenderEvent {
  id: number;
  name: string;
  x: number;
  y: number;
  pages: EventPage[];
}

interface RenderMapFile {
  width: number;
  height: number;
  tilesetId: number;
  data: number[];
  events?: (RenderEvent | null)[];
}

const MARKER_TRANSFER: [number, number, number] = [0, 190, 255];
const MARKER_TALK: [number, number, number] = [255, 160, 0];
const MARKER_AUTO: [number, number, number] = [255, 60, 200];
const MARKER_OTHER: [number, number, number] = [150, 255, 120];

const MAX_EDGE_PX = 1600;

/** The page an event shows when the game starts: the last page with no conditions at all, else the first. */
function startPage(event: RenderEvent): EventPage | undefined {
  const unconditional = event.pages.filter((p) => {
    const c = p.conditions ?? {};
    return !c.switch1Valid && !c.switch2Valid && !c.variableValid && !c.selfSwitchValid && !c.itemValid && !c.actorValid;
  });
  return unconditional[unconditional.length - 1] ?? event.pages[0];
}

async function readPng(file: string): Promise<Bitmap> {
  return decodePng(await fs.readFile(file));
}

export function registerRenderTools(server: McpServer, project: Project): void {
  server.registerTool(
    "render_map_image",
    {
      title: "Render map as image",
      description:
        "Render a map to a PNG image so you can SEE what it looks like: all tile layers with correct autotile shapes, shadows and tiles that draw above characters, optionally the events' character sprites, coloured event markers with their ids, region ids, a tile grid and a passability overlay (red = blocked in all directions). " +
        "This is the visual counterpart of render_map (text) - use it after paint_tiles / create_event / connect_maps to check your work. " +
        "Marker colours: blue = event with a Transfer Player command (door/exit), orange = shows text, magenta = autorun/parallel, green = anything else. " +
        "Needs the tileset images in img/tilesets (sheets without an image are drawn as flat colours and listed). Large maps are shrunk to fit ~1600px; pass x/y/width/height to zoom into a region and raise tileSize for detail.",
      inputSchema: {
        mapId: z.number().int().min(1),
        x: z.number().int().min(0).default(0).describe("Region left edge in tiles"),
        y: z.number().int().min(0).default(0).describe("Region top edge in tiles"),
        width: z.number().int().min(1).optional().describe("Region width in tiles (default: to the map's right edge)"),
        height: z.number().int().min(1).optional().describe("Region height in tiles (default: to the map's bottom edge)"),
        tileSize: z.number().int().min(4).max(48).default(24).describe("Pixels per map tile (48 = full resolution). Reduced automatically so the image stays under ~1600px"),
        showEvents: z
          .enum(["none", "markers", "sprites", "both"])
          .default("both")
          .describe("Draw event character sprites, coloured id markers, both, or neither"),
        showGrid: z.boolean().default(false).describe("Overlay a tile grid"),
        showRegions: z.boolean().default(false).describe("Overlay region ids (layer 5)"),
        showPassability: z.boolean().default(false).describe("Tint blocked cells translucent red (not walkable in any direction by the tileset flags)"),
      },
    },
    safe(async ({ mapId, x, y, width, height, tileSize, showEvents, showGrid, showRegions, showPassability }) => {
      const map = await project.readJson<RenderMapFile>(project.mapFile(mapId));
      if (!Array.isArray(map.data) || map.data.length !== map.width * map.height * LAYER_COUNT) {
        throw new ProjectError(`Map ${mapId} has malformed tile data.`);
      }
      if (x >= map.width || y >= map.height) {
        throw new ProjectError(`Region start (${x}, ${y}) is outside the ${map.width}x${map.height} map.`);
      }
      const region = {
        x,
        y,
        width: Math.min(width ?? map.width, map.width - x),
        height: Math.min(height ?? map.height, map.height - y),
      };
      const ts = Math.max(
        4,
        Math.min(tileSize, Math.floor(MAX_EDGE_PX / region.width), Math.floor(MAX_EDGE_PX / region.height))
      );

      const tileset = await loadTileset(project, map.tilesetId).catch(() => null);
      const problems: string[] = [];
      if (!tileset) problems.push(`Tileset ${map.tilesetId} does not exist in Tilesets.json; tiles are drawn as flat colours.`);

      const sheets: Partial<Record<Sheet, Bitmap>> = {};
      for (const sheet of SHEETS) {
        const name = tileset?.tilesetNames?.[SHEET_NAME_INDEX[sheet]] ?? "";
        if (!name || name !== path.basename(name)) continue;
        try {
          sheets[sheet] = await readPng(path.join(project.root, "img", "tilesets", `${name}.png`));
        } catch (err) {
          problems.push(`Sheet ${sheet} (${name}.png): ${err instanceof Error ? err.message : "unreadable"} - drawn as flat colours.`);
        }
      }

      const markers: MarkerDraw[] = [];
      const sprites: SpriteDraw[] = [];
      const tileEvents: { x: number; y: number; tileId: number }[] = [];
      const listed: string[] = [];
      const characterCache = new Map<string, Bitmap | null>();
      const events = (map.events ?? []).filter((e): e is RenderEvent => e != null);

      for (const ev of events) {
        const page = startPage(ev);
        const codes = new Set((page?.list ?? []).map((c) => c.code));
        const inRegion =
          ev.x >= region.x && ev.y >= region.y && ev.x < region.x + region.width && ev.y < region.y + region.height;
        const kind = codes.has(201) ? "transfer" : (page?.trigger ?? 0) >= 3 ? "autorun/parallel" : codes.has(101) ? "text" : "other";
        if (inRegion) listed.push(`#${ev.id} "${ev.name}" (${ev.x},${ev.y}) ${kind}`);

        if (showEvents === "markers" || showEvents === "both") {
          markers.push({
            x: ev.x,
            y: ev.y,
            label: ev.id,
            color: kind === "transfer" ? MARKER_TRANSFER : kind === "text" ? MARKER_TALK : kind === "autorun/parallel" ? MARKER_AUTO : MARKER_OTHER,
          });
        }
        const image = page?.image;
        if ((showEvents === "sprites" || showEvents === "both") && image && inRegion) {
          if (image.tileId > 0) {
            tileEvents.push({ x: ev.x, y: ev.y, tileId: image.tileId });
          } else if (image.characterName && image.characterName === path.basename(image.characterName)) {
            let sheet = characterCache.get(image.characterName);
            if (sheet === undefined) {
              sheet = await readPng(path.join(project.root, "img", "characters", `${image.characterName}.png`)).catch(() => null);
              characterCache.set(image.characterName, sheet);
              if (!sheet) problems.push(`Character image ${image.characterName}.png could not be read; event sprites using it are skipped.`);
            }
            if (sheet) {
              const single = image.characterName.startsWith("$");
              const cw = sheet.width / (single ? 3 : 12);
              const ch = sheet.height / (single ? 4 : 8);
              const baseX = single ? 0 : (image.characterIndex % 4) * 3 * cw;
              const baseY = single ? 0 : Math.floor(image.characterIndex / 4) * 4 * ch;
              const row = Math.max(0, Math.min(3, (image.direction - 2) / 2));
              sprites.push({
                x: ev.x,
                y: ev.y,
                bitmap: sheet,
                sx: Math.round(baseX + Math.min(2, image.pattern) * cw),
                sy: Math.round(baseY + row * ch),
                sw: Math.round(cw),
                sh: Math.round(ch),
              });
            }
          }
        }
      }

      const { bitmap, missingSheets } = renderMapBitmap({
        width: map.width,
        height: map.height,
        data: map.data,
        flags: tileset?.flags ?? [],
        sheets,
        region,
        tileSize: ts,
        grid: showGrid,
        regions: showRegions,
        passability: showPassability,
        tileEvents,
        sprites,
        markers,
      });
      for (const s of missingSheets) {
        if (!problems.some((p) => p.startsWith(`Sheet ${s}`))) {
          problems.push(`Sheet ${s} has no image in tileset ${map.tilesetId}; its tiles are drawn as flat colours.`);
        }
      }

      const png = encodePng(bitmap);
      const text =
        `Map ${mapId} (${map.width}x${map.height}), tileset ${map.tilesetId}, region x=${region.x} y=${region.y} ${region.width}x${region.height}, ` +
        `${ts}px per tile -> ${bitmap.width}x${bitmap.height}px.` +
        (ts < tileSize ? ` (tileSize reduced from ${tileSize} to fit; use a smaller region for more detail.)` : "") +
        (listed.length ? `\nEvents in view:\n${listed.slice(0, 60).join("\n")}${listed.length > 60 ? `\n... and ${listed.length - 60} more` : ""}` : "\nNo events in view.") +
        (problems.length ? `\nNotes:\n${problems.map((p) => `- ${p}`).join("\n")}` : "");
      return {
        content: [
          { type: "text", text },
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        ],
      };
    })
  );
}

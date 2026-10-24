import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Project, ProjectError } from "../project.js";
import { safe, textResult } from "../util.js";
import {
  AutotileSheet,
  KIND_RANGE,
  LAYER_COUNT,
  PaintOp,
  SHEETS,
  SHEET_NAME_INDEX,
  Sheet,
  TILE,
  TileError,
  applyPaintOps,
  autotileId,
  autotileKind,
  decodeFlags,
  describeTile,
  isAutotile,
  kindBlock,
  kindDescription,
  passabilityChar,
  sheetBase,
  sheetTileCount,
  tableType,
  tileIndexAt,
} from "../tiles.js";

export interface MvTileset {
  id: number;
  name: string;
  mode: number;
  note: string;
  flags: number[];
  tilesetNames: string[];
}

interface MvMapTiles {
  width: number;
  height: number;
  tilesetId: number;
  data: number[];
  [key: string]: unknown;
}

export const tileSpecSchema = z
  .union([
    z.number().int().min(0).max(TILE.MAX - 1),
    z.object({
      sheet: z.enum(SHEETS),
      kind: z.number().int().optional().describe("Autotile kind, for sheets A1-A4 (A1 0-15, A2 16-47, A3 48-79, A4 80-127)"),
      index: z.number().int().optional().describe("Tile index, for sheets A5 (0-127) and B-E (0-255)"),
    }),
  ])
  .describe(
    "Which tile to place. Either {sheet, kind} for autotile sheets A1-A4, {sheet, index} for A5/B/C/D/E, or a raw tile id (0 erases). Autotile edge shapes are computed automatically."
  );

const layerSchema = z
  .number()
  .int()
  .min(0)
  .max(LAYER_COUNT - 1)
  .optional()
  .describe(
    "Map layer: 0-1 ground tiles, 2-3 upper tiles, 4 shadow bits (0-15), 5 region id (0-255). Defaults to 0 for sheets A1-A5 and 2 for B-E; required when erasing."
  );

const paintOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cells"),
    tile: tileSpecSchema,
    layer: layerSchema,
    cells: z.array(z.object({ x: z.number().int(), y: z.number().int() })).min(1),
  }),
  z.object({
    type: z.literal("rect"),
    tile: tileSpecSchema,
    layer: layerSchema,
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    hollow: z.boolean().default(false).describe("Only paint the outline of the rectangle"),
  }),
  z.object({
    type: z.literal("fill"),
    tile: tileSpecSchema,
    layer: layerSchema,
    x: z.number().int(),
    y: z.number().int(),
  }),
]);

/** Load a tileset record, or null when the project's Tilesets.json has no such entry. */
export async function loadTileset(project: Project, tilesetId: number): Promise<MvTileset | null> {
  const tilesets = (await project.readDatabase("tilesets")) as (MvTileset | null)[];
  return tilesets[tilesetId] ?? null;
}

/** Fail early when painted tiles come from a sheet the map's tileset leaves empty. */
export function checkSheetsAvailable(tileset: MvTileset | null, sheets: Sheet[]): void {
  if (!tileset) return;
  for (const sheet of sheets) {
    const name = tileset.tilesetNames?.[SHEET_NAME_INDEX[sheet]] ?? "";
    if (!name) {
      throw new ProjectError(
        `Tileset ${tileset.id} ("${tileset.name}") has no image assigned to sheet ${sheet}, so those tiles would be invisible. ` +
          `Pick tiles from a sheet that is set (see get_tileset_info) or assign a sheet with update_record on type "tilesets".`
      );
    }
  }
}

function sheetLayoutText(sheet: Sheet): string {
  switch (sheet) {
    case "A1":
      return "A1 (animated water/waterfalls, 768x576 = 16x12 tiles): each autotile kind 0-15 is a 2x3-tile preview block; positions are listed per kind.";
    case "A2":
      return "A2 (ground, 768x576 = 16x12 tiles): 32 kinds (16-47) in 8 columns x 4 rows of 2x3-tile blocks.";
    case "A3":
      return "A3 (buildings, 768x384 = 16x8 tiles): 32 kinds (48-79) in 8 columns x 4 rows of 2x2-tile blocks.";
    case "A4":
      return "A4 (walls, 768x720 = 16x15 tiles): 48 kinds (80-127); rows alternate wall tops (2x3 blocks) and wall sides (2x2 blocks).";
    case "A5":
      return "A5 (normal ground tiles, 384x768 = 8x16 tiles): index = row*8 + col, 128 tiles.";
    default:
      return `${sheet} (object tiles, 768x768 = 16x16 tiles): index = (col>=8 ? 128 : 0) + row*8 + (col%8), 256 tiles; index 0 is empty.`;
  }
}

function symbolPool(): string[] {
  return [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&@+=~^"];
}

export function registerTileTools(server: McpServer, project: Project): void {
  server.registerTool(
    "get_tileset_info",
    {
      title: "Get tileset info",
      description:
        "Describe a tileset so you can choose tiles to paint: which image is assigned to each sheet (A1-A5, B-E), the tile id ranges, and for autotile sheets every kind with its type, position on the sheet image and passability. " +
        "Without `sheet` you get an overview; pass `sheet` for the detail of one sheet (for A5/B-E that includes a passability grid laid out like the image: o passable, x blocked, * drawn above characters, p partly blocked). " +
        "Use get_tileset_image to see what the tiles look like. `tileIds` decodes passability and terrain flags for specific tile ids.",
      inputSchema: {
        tilesetId: z.number().int().min(1).describe("Tileset id (a map's tilesetId, see get_map)"),
        sheet: z.enum(SHEETS).optional().describe("Return the detail of one sheet"),
        tileIds: z.array(z.number().int().min(0).max(TILE.MAX - 1)).max(100).optional(),
      },
    },
    safe(async ({ tilesetId, sheet, tileIds }) => {
      const tileset = await loadTileset(project, tilesetId);
      if (!tileset) throw new ProjectError(`Tileset ${tilesetId} does not exist in Tilesets.json.`);
      const flags = tileset.flags ?? [];
      const names = tileset.tilesetNames ?? [];

      const result: Record<string, unknown> = {
        tilesetId,
        name: tileset.name,
        mode: tileset.mode === 0 ? "world" : "area",
      };

      if (tileIds) {
        result.tiles = tileIds.map((id) => ({
          tileId: id,
          tile: describeTile(id),
          ...decodeFlags(flags[id] ?? 0),
        }));
      }

      if (!sheet) {
        result.sheets = SHEETS.map((s) => ({
          sheet: s,
          image: names[SHEET_NAME_INDEX[s]] || null,
          tileIds:
            s === "A5"
              ? `${TILE.A5}-${TILE.A5 + 127}`
              : s === "B" || s === "C" || s === "D" || s === "E"
                ? `${TILE[s]}-${TILE[s] + 255}`
                : `${autotileId(KIND_RANGE[s][0])}-${autotileId(KIND_RANGE[s][1], 47)}`,
          kinds: s === "A1" || s === "A2" || s === "A3" || s === "A4" ? `${KIND_RANGE[s][0]}-${KIND_RANGE[s][1]}` : undefined,
          note: sheetLayoutText(s),
        }));
        result.howToPaint =
          "paint_tiles with {sheet:'A2', kind:N} for autotile sheets, {sheet:'B', index:N} for A5/B-E. Call again with `sheet` set for details.";
        return textResult(result);
      }

      const imageName = names[SHEET_NAME_INDEX[sheet]] || null;
      result.sheet = sheet;
      result.image = imageName;
      result.layout = sheetLayoutText(sheet);
      if (!imageName) result.warning = `Sheet ${sheet} has no image in this tileset; tiles from it are invisible.`;

      if (sheet === "A1" || sheet === "A2" || sheet === "A3" || sheet === "A4") {
        const [lo, hi] = KIND_RANGE[sheet as AutotileSheet];
        // One compact line per kind keeps the answer small (A2 alone has 32 kinds).
        const kinds: string[] = [];
        for (let k = lo; k <= hi; k++) {
          const b = kindBlock(k);
          const f = flags[autotileId(k)] ?? 0;
          kinds.push(
            `kind ${k}: ${kindDescription(k)} | rule ${tableType(k)} | tileId ${autotileId(k)} | ` +
              `block x=${b.x} y=${b.y} ${b.w}x${b.h} tiles | ${(f & 0xf) !== 0xf ? "passable" : "blocked"}` +
              (f >> 12 ? ` | terrain tag ${f >> 12}` : "")
          );
        }
        result.kinds = kinds;
      } else {
        const s = sheet as "A5" | "B" | "C" | "D" | "E";
        const rows: string[] = [];
        for (let row = 0; row < 16; row++) {
          let line = "";
          for (let col = 0; col < (s === "A5" ? 8 : 16); col++) {
            const idx = tileIndexAt(s, col, row);
            line += s === "B" && idx === 0 ? "." : passabilityChar(flags[sheetBase(s) + idx] ?? 0);
          }
          rows.push(line);
        }
        result.passabilityGrid = rows;
        result.tileCount = sheetTileCount(s);
        result.indexFormula =
          s === "A5" ? "index = row*8 + col" : "index = (col>=8 ? 128 : 0) + row*8 + (col%8)";
      }
      return textResult(result);
    })
  );

  server.registerTool(
    "get_tileset_image",
    {
      title: "Get tileset sheet image",
      description:
        "Return one tileset sheet (A1-A5, B-E) as an image so you can see which tile looks like what, together with its grid layout (48px tiles). Use get_tileset_info for the matching tile ids and kinds.",
      inputSchema: {
        tilesetId: z.number().int().min(1),
        sheet: z.enum(SHEETS),
      },
    },
    safe(async ({ tilesetId, sheet }) => {
      const tileset = await loadTileset(project, tilesetId);
      if (!tileset) throw new ProjectError(`Tileset ${tilesetId} does not exist in Tilesets.json.`);
      const name = tileset.tilesetNames?.[SHEET_NAME_INDEX[sheet]] ?? "";
      if (!name) throw new ProjectError(`Tileset ${tilesetId} has no image assigned to sheet ${sheet}.`);
      if (name !== path.basename(name)) throw new ProjectError(`Refusing suspicious image name "${name}".`);
      const file = path.join(project.root, "img", "tilesets", `${name}.png`);
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(file);
      } catch {
        throw new ProjectError(
          `Image not found: img/tilesets/${name}.png (encrypted deployments use .rpgmvp and cannot be shown).`
        );
      }
      return {
        content: [
          {
            type: "text",
            text: `Sheet ${sheet} of tileset ${tilesetId} ("${name}.png"), 48px tiles. ${sheetLayoutText(sheet)}`,
          },
          { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
        ],
      };
    })
  );

  server.registerTool(
    "set_map_tileset",
    {
      title: "Set map tileset",
      description:
        "Switch a map to another tileset (which sheets/tile images it uses). Existing tile ids are kept as they are, so they will show the new tileset's graphics - repaint with paint_tiles if the layouts differ.",
      inputSchema: {
        mapId: z.number().int().min(1),
        tilesetId: z.number().int().min(1),
      },
    },
    safe(async ({ mapId, tilesetId }) => {
      const tileset = await loadTileset(project, tilesetId);
      if (!tileset) throw new ProjectError(`Tileset ${tilesetId} does not exist in Tilesets.json.`);
      const file = project.mapFile(mapId);
      const map = await project.readJson<MvMapTiles>(file);
      const previous = map.tilesetId;
      map.tilesetId = tilesetId;
      await project.writeJson(file, map);
      return textResult({
        mapId,
        previousTilesetId: previous,
        tilesetId,
        tilesetName: tileset.name,
        sheets: SHEETS.filter((s) => tileset.tilesetNames?.[SHEET_NAME_INDEX[s]]).map((s) => s),
      });
    })
  );

  server.registerTool(
    "paint_tiles",
    {
      title: "Paint map tiles",
      description:
        "Paint tiles onto a map. Takes a list of operations applied in order: `cells` (individual positions), `rect` (filled or hollow rectangle) and `fill` (flood fill from a cell). " +
        "Tiles are chosen as {sheet:'A2', kind:N} (autotile sheets A1-A4), {sheet:'B', index:N} (A5/B-E) or a raw tile id; 0 erases. " +
        "Autotile edge, corner and wall shapes are calculated automatically, including re-shaping neighbours, just like painting in the editor. " +
        "Layers: 0-1 ground, 2-3 upper tiles, 4 shadows, 5 regions. Typical map: fill layer 0 with a ground kind from A2, then place water/walls/objects on top. Use get_tileset_info / get_tileset_image to pick tiles and render_map to check the result.",
      inputSchema: {
        mapId: z.number().int().min(1),
        operations: z.array(paintOpSchema).min(1).max(500),
      },
    },
    safe(async ({ mapId, operations }) => {
      const file = project.mapFile(mapId);
      const map = await project.readJson<MvMapTiles>(file);
      const tileset = await loadTileset(project, map.tilesetId).catch(() => null);
      let result;
      try {
        result = applyPaintOps(map, operations as PaintOp[]);
      } catch (err) {
        if (err instanceof TileError) throw new ProjectError(err.message);
        throw err;
      }
      checkSheetsAvailable(tileset, result.sheetsUsed);
      await project.writeJson(file, map);
      return textResult({ mapId, tilesetId: map.tilesetId, ...result });
    })
  );

  server.registerTool(
    "render_map",
    {
      title: "Render map as text",
      description:
        "Show a map's tiles as text so you can check what you painted. mode 'symbols' (default) draws one character per cell using the topmost tile of layers 0-3 (or only `layer`) with a legend naming each symbol; mode 'ids' prints raw tile ids of one layer. Use x/y/width/height to look at a region (default: up to 100x60 from the top-left).",
      inputSchema: {
        mapId: z.number().int().min(1),
        mode: z.enum(["symbols", "ids"]).default("symbols"),
        layer: z.number().int().min(0).max(LAYER_COUNT - 1).optional(),
        x: z.number().int().min(0).default(0),
        y: z.number().int().min(0).default(0),
        width: z.number().int().min(1).optional(),
        height: z.number().int().min(1).optional(),
      },
    },
    safe(async ({ mapId, mode, layer, x, y, width, height }) => {
      const map = await project.readJson<MvMapTiles>(project.mapFile(mapId));
      if (map.data?.length !== map.width * map.height * LAYER_COUNT) {
        throw new ProjectError(`Map ${mapId} has malformed tile data.`);
      }
      if (x >= map.width || y >= map.height) {
        throw new ProjectError(`Region start (${x}, ${y}) is outside the ${map.width}x${map.height} map.`);
      }
      const w = Math.min(width ?? 100, map.width - x);
      const h = Math.min(height ?? 60, map.height - y);
      const at = (cx: number, cy: number, z: number): number => map.data[(z * map.height + cy) * map.width + cx];

      const ruler = (pad: number): string => {
        let line = " ".repeat(4);
        for (let cx = x; cx < x + w; cx++) line += String(cx % 10).padStart(pad, " ");
        return line;
      };
      const lines: string[] = [];

      if (mode === "ids") {
        const z = layer ?? 0;
        for (let cy = y; cy < y + h; cy++) {
          const row: string[] = [];
          for (let cx = x; cx < x + w; cx++) row.push(String(at(cx, cy, z)).padStart(4, " "));
          lines.push(String(cy).padStart(3, " ") + " " + row.join(" "));
        }
        return textResult(`Map ${mapId} layer ${z}, region x=${x} y=${y} ${w}x${h} (raw tile ids)\n${lines.join("\n")}`);
      }

      const pool = symbolPool();
      const legend = new Map<string, string>();
      const symbolFor = (tile: number): string => {
        if (tile === 0) return ".";
        const key = describeTile(isAutotile(tile) ? autotileId(autotileKind(tile)) : tile);
        let sym = legend.get(key);
        if (!sym) {
          sym = pool.shift() ?? "?";
          legend.set(key, sym);
        }
        return sym;
      };
      lines.push(ruler(1));
      for (let cy = y; cy < y + h; cy++) {
        let row = String(cy).padStart(3, " ") + " ";
        for (let cx = x; cx < x + w; cx++) {
          let tile = 0;
          if (layer !== undefined) tile = at(cx, cy, layer);
          else for (let z = 3; z >= 0 && tile === 0; z--) tile = at(cx, cy, z);
          row += layer !== undefined && layer >= 4 ? (tile === 0 ? "." : String(tile % 10)) : symbolFor(tile);
        }
        lines.push(row);
      }
      const legendLines =
        layer !== undefined && layer >= 4
          ? ["(layer shows last digit of the value; use mode 'ids' for exact values)"]
          : [...legend.entries()].map(([name, sym]) => `${sym} = ${name}`);
      return textResult(
        `Map ${mapId} (${map.width}x${map.height}), tileset ${map.tilesetId}, region x=${x} y=${y} ${w}x${h}` +
          `${layer !== undefined ? `, layer ${layer}` : ", topmost tile of layers 0-3"}\n${lines.join("\n")}\n\nLegend ('.' = empty):\n${legendLines.join("\n")}`
      );
    })
  );
}

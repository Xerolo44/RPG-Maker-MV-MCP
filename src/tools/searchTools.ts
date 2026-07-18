import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Project, DATABASE_TYPES } from "../project.js";
import { safe, textResult } from "../util.js";

const SEARCHED_FIELDS = ["name", "nickname", "description", "note", "profile", "message1", "message2"];

interface MvEvent {
  id: number;
  name: string;
  x: number;
  y: number;
  note?: string;
  pages?: { list?: { code: number; parameters: unknown[] }[] }[];
}

export function registerSearchTools(server: McpServer, project: Project): void {
  server.registerTool(
    "search_records",
    {
      title: "Search database records",
      description:
        "Case-insensitive substring search across database records (name, nickname, description, note, profile, messages). Searches one type, or all types when type is omitted. Returns {type, id, name, matchedIn} summaries.",
      inputSchema: {
        query: z.string().min(1),
        type: z
          .enum(DATABASE_TYPES)
          .optional()
          .describe("Database to search; omit to search all databases"),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    safe(async ({ query, type, limit }) => {
      const needle = query.toLowerCase();
      const types = type ? [type] : [...DATABASE_TYPES];
      const results: object[] = [];
      for (const t of types) {
        let records: unknown[];
        try {
          records = await project.readDatabase(t);
        } catch {
          continue;
        }
        for (let id = 1; id < records.length && results.length < limit; id++) {
          const record = records[id] as Record<string, unknown> | null;
          if (!record) continue;
          const matchedIn = SEARCHED_FIELDS.filter(
            (f) => typeof record[f] === "string" && (record[f] as string).toLowerCase().includes(needle)
          );
          if (matchedIn.length > 0) {
            results.push({ type: t, id, name: record.name ?? "", matchedIn });
          }
        }
        if (results.length >= limit) break;
      }
      return textResult({ query, matches: results.length, results });
    })
  );

  server.registerTool(
    "search_map_events",
    {
      title: "Search map events",
      description:
        "Case-insensitive substring search across events on one map or every map. Matches event names and notes; with searchCommands=true it also searches inside event command parameters (message text, script lines, plugin commands). Returns {mapId, mapName, eventId, name, x, y, matchedIn}.",
      inputSchema: {
        query: z.string().min(1),
        mapId: z.number().int().min(1).optional().describe("Search only this map; omit for all maps"),
        searchCommands: z
          .boolean()
          .default(false)
          .describe("Also search inside event command lists (slower, finds text/script content)"),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    safe(async ({ query, mapId, searchCommands, limit }) => {
      const needle = query.toLowerCase();
      let mapIds: { id: number; name: string }[];
      if (mapId !== undefined) {
        mapIds = [{ id: mapId, name: "" }];
      } else {
        const infos = await project.readJson<({ id: number; name: string } | null)[]>(
          project.dataFile("MapInfos.json")
        );
        mapIds = infos.filter((m): m is { id: number; name: string } => m != null);
      }

      const results: object[] = [];
      for (const info of mapIds) {
        if (results.length >= limit) break;
        let map: { events?: (MvEvent | null)[] };
        try {
          map = await project.readJson(project.mapFile(info.id));
        } catch {
          continue;
        }
        for (const event of map.events ?? []) {
          if (!event) continue;
          if (results.length >= limit) break;
          const matchedIn: string[] = [];
          if (event.name?.toLowerCase().includes(needle)) matchedIn.push("name");
          if (event.note?.toLowerCase().includes(needle)) matchedIn.push("note");
          if (searchCommands && matchedIn.length === 0) {
            outer: for (let p = 0; p < (event.pages?.length ?? 0); p++) {
              for (const cmd of event.pages![p].list ?? []) {
                if (JSON.stringify(cmd.parameters).toLowerCase().includes(needle)) {
                  matchedIn.push(`pages[${p}] command ${cmd.code}`);
                  break outer;
                }
              }
            }
          }
          if (matchedIn.length > 0) {
            results.push({
              mapId: info.id,
              mapName: info.name,
              eventId: event.id,
              name: event.name,
              x: event.x,
              y: event.y,
              matchedIn,
            });
          }
        }
      }
      return textResult({ query, matches: results.length, results });
    })
  );
}

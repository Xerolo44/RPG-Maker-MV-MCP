import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Project, DATABASE_TYPES, ProjectError } from "../project.js";
import { safe, textResult } from "../util.js";

const typeSchema = z
  .enum(DATABASE_TYPES)
  .describe("Which database to access (e.g. actors, items, skills, troops, commonEvents)");

interface NamedRecord {
  id?: number;
  name?: string;
  [key: string]: unknown;
}

export function registerDatabaseTools(server: McpServer, project: Project): void {
  server.registerTool(
    "list_records",
    {
      title: "List database records",
      description:
        "List all records of a database type as {id, name} summaries. Use get_record for full data.",
      inputSchema: { type: typeSchema },
    },
    safe(async ({ type }) => {
      const records = (await project.readDatabase(type)) as (NamedRecord | null)[];
      const summaries = records
        .map((r, i) => (r ? { id: r.id ?? i, name: r.name ?? "" } : null))
        .filter((r) => r !== null);
      return textResult(summaries);
    })
  );

  server.registerTool(
    "get_record",
    {
      title: "Get database record",
      description: "Get the full JSON of one database record by id.",
      inputSchema: {
        type: typeSchema,
        id: z.number().int().min(1).describe("Record id (1-based)"),
      },
    },
    safe(async ({ type, id }) => {
      const records = await project.readDatabase(type);
      const record = records[id];
      if (record == null) {
        throw new ProjectError(`No ${type} record with id ${id}.`);
      }
      return textResult(record);
    })
  );

  server.registerTool(
    "update_record",
    {
      title: "Update database record",
      description:
        "Update a database record. By default the given fields are shallow-merged into the existing record; set merge=false to replace it entirely. The record's id always stays fixed to match its array position.",
      inputSchema: {
        type: typeSchema,
        id: z.number().int().min(1).describe("Record id (1-based)"),
        data: z
          .record(z.unknown())
          .describe("Fields to set (or the complete record when merge=false)"),
        merge: z.boolean().default(true).describe("Merge into existing record (true) or replace (false)"),
      },
    },
    safe(async ({ type, id, data, merge }) => {
      const records = await project.readDatabase(type);
      const existing = records[id];
      if (existing == null) {
        throw new ProjectError(`No ${type} record with id ${id}. Use create_record to add new records.`);
      }
      const updated = merge ? { ...(existing as object), ...data } : { ...data };
      (updated as NamedRecord).id = id;
      records[id] = updated;
      await project.writeDatabase(type, records);
      return textResult({ updated: { type, id }, record: updated });
    })
  );

  server.registerTool(
    "create_record",
    {
      title: "Create database record",
      description:
        "Append a new record to a database. The new record's fields are copied from `data`; missing fields should be filled in to match the shape of existing records (fetch one with get_record as a template first). Returns the new id.",
      inputSchema: {
        type: typeSchema,
        data: z.record(z.unknown()).describe("The record fields (id is assigned automatically)"),
      },
    },
    safe(async ({ type, data }) => {
      const records = await project.readDatabase(type);
      const id = records.length;
      const record = { ...data, id };
      records.push(record);
      await project.writeDatabase(type, records);
      return textResult({ created: { type, id }, record });
    })
  );

  server.registerTool(
    "get_system",
    {
      title: "Get System.json",
      description:
        "Read System.json (game title, starting party/position, terms, sounds, switches, variables, etc.). Optionally return only one top-level key.",
      inputSchema: {
        key: z
          .string()
          .optional()
          .describe("Optional top-level key to return (e.g. 'switches', 'variables', 'terms')"),
      },
    },
    safe(async ({ key }) => {
      const system = await project.readJson<Record<string, unknown>>(
        project.dataFile("System.json")
      );
      if (key !== undefined) {
        if (!(key in system)) {
          throw new ProjectError(
            `System.json has no key '${key}'. Available: ${Object.keys(system).join(", ")}`
          );
        }
        return textResult({ [key]: system[key] });
      }
      return textResult(system);
    })
  );

  server.registerTool(
    "set_switch_name",
    {
      title: "Name a switch",
      description:
        "Set the editor name of a game switch in System.json (e.g. switch 5 = 'Opened Chest'). The switches array grows if the id is beyond its current size.",
      inputSchema: {
        id: z.number().int().min(1).describe("Switch id (1-based)"),
        name: z.string(),
      },
    },
    safe(async ({ id, name }) => {
      const file = project.dataFile("System.json");
      const system = await project.readJson<{ switches?: (string | null)[] }>(file);
      if (!Array.isArray(system.switches)) system.switches = [null];
      while (system.switches.length <= id) system.switches.push("");
      system.switches[id] = name;
      await project.writeJson(file, system);
      return textResult({ switch: id, name });
    })
  );

  server.registerTool(
    "set_variable_name",
    {
      title: "Name a variable",
      description:
        "Set the editor name of a game variable in System.json (e.g. variable 3 = 'Quest Progress'). The variables array grows if the id is beyond its current size.",
      inputSchema: {
        id: z.number().int().min(1).describe("Variable id (1-based)"),
        name: z.string(),
      },
    },
    safe(async ({ id, name }) => {
      const file = project.dataFile("System.json");
      const system = await project.readJson<{ variables?: (string | null)[] }>(file);
      if (!Array.isArray(system.variables)) system.variables = [null];
      while (system.variables.length <= id) system.variables.push("");
      system.variables[id] = name;
      await project.writeJson(file, system);
      return textResult({ variable: id, name });
    })
  );

  server.registerTool(
    "update_system",
    {
      title: "Update System.json",
      description:
        "Shallow-merge the given top-level fields into System.json (e.g. gameTitle, startMapId, startX, startY, switches, variables).",
      inputSchema: {
        data: z.record(z.unknown()).describe("Top-level System.json fields to set"),
      },
    },
    safe(async ({ data }) => {
      const file = project.dataFile("System.json");
      const system = await project.readJson<Record<string, unknown>>(file);
      Object.assign(system, data);
      await project.writeJson(file, system);
      return textResult({ updatedKeys: Object.keys(data) });
    })
  );
}

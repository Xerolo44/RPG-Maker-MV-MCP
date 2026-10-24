import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { Project, DATABASE_TYPES } from "../project.js";
import { safe, textResult } from "../util.js";

export function registerProjectTools(server: McpServer, project: Project): void {
  server.registerTool(
    "set_project",
    {
      title: "Set project",
      description:
        "Select the RPG Maker MV project folder to work on (the folder containing Game.rpgproject and data/). Must be called before other tools unless the server was started with --project. Discards any open changeset (its staged edits are lost).",
      inputSchema: {
        path: z.string().describe("Absolute path to the RPG Maker MV project folder"),
      },
    },
    safe(async ({ path: dir }) => {
      const hadChangeset = project.changesetActive;
      await project.setRoot(dir);
      const recovered = project.recoveredChangesets;
      const failures = project.recoveryErrors;
      return textResult(
        `Project set to ${project.root}` +
          (hadChangeset ? " (the open changeset was discarded; its staged edits were never written)" : "") +
          (recovered.length
            ? `\nRolled back ${recovered.length} interrupted changeset commit(s) from the journal: ${recovered.join(", ")}. Those edits are not on disk; redo them if they are still wanted.`
            : "") +
          (failures.length ? `\nWARNING: ${failures.join("\n")}` : "")
      );
    })
  );

  server.registerTool(
    "get_project_info",
    {
      title: "Get project info",
      description:
        "Summary of the current project: game title, database record counts, map count, and plugin count.",
      inputSchema: {},
    },
    safe(async () => {
      const system = await project.readJson<Record<string, unknown>>(
        project.dataFile("System.json")
      );
      const mapInfos = await project.readJson<unknown[]>(project.dataFile("MapInfos.json"));
      const counts: Record<string, number> = {};
      for (const type of DATABASE_TYPES) {
        try {
          const records = await project.readDatabase(type);
          counts[type] = records.filter((r) => r != null).length;
        } catch {
          counts[type] = 0;
        }
      }
      let pluginCount = 0;
      try {
        const pluginsJs = await project.readText(path.join(project.root, "js", "plugins.js"));
        const match = pluginsJs.match(/\[[\s\S]*\]/);
        if (match) pluginCount = (JSON.parse(match[0]) as unknown[]).length;
      } catch {
        // no plugins.js — fine
      }
      return textResult({
        root: project.root,
        gameTitle: system.gameTitle,
        currencyUnit: system.currencyUnit,
        startMapId: system.startMapId,
        maps: mapInfos.filter((m) => m != null).length,
        plugins: pluginCount,
        databaseCounts: counts,
      });
    })
  );
}

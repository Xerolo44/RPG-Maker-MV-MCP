#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Project } from "./project.js";
import { registerProjectTools } from "./tools/projectTools.js";
import { registerDatabaseTools } from "./tools/databaseTools.js";
import { registerMapTools } from "./tools/mapTools.js";
import { registerPluginTools } from "./tools/pluginTools.js";
import { registerPlaytestTools } from "./tools/playtestTools.js";
import { registerSkillTools } from "./tools/skillTools.js";
import { registerSearchTools } from "./tools/searchTools.js";
import { registerMaintenanceTools } from "./tools/maintenanceTools.js";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "rpgmaker-mv-mcp",
    version: "0.1.0",
  });

  const project = new Project();

  // Optional: --project <path> preselects the project folder.
  const args = process.argv.slice(2);
  const projectFlag = args.indexOf("--project");
  if (projectFlag !== -1 && args[projectFlag + 1]) {
    try {
      await project.setRoot(args[projectFlag + 1]);
      console.error(`[rpgmaker-mv-mcp] project: ${project.root}`);
    } catch (err) {
      console.error(`[rpgmaker-mv-mcp] warning: ${(err as Error).message}`);
    }
  }

  registerProjectTools(server, project);
  registerDatabaseTools(server, project);
  registerMapTools(server, project);
  registerPluginTools(server, project);
  registerPlaytestTools(server, project);
  registerSkillTools(server, project);
  registerSearchTools(server, project);
  registerMaintenanceTools(server, project);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[rpgmaker-mv-mcp] server running on stdio");
}

main().catch((err) => {
  console.error("[rpgmaker-mv-mcp] fatal:", err);
  process.exit(1);
});

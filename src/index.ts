#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import https from "node:https";
import { loadOrCreateLocalCert } from "./certs.js";
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

  const httpFlag = args.indexOf("--http");
  if (httpFlag !== -1) {
    const port = Number(args[httpFlag + 1]) || 3939;
    await startHttp(server, port);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[rpgmaker-mv-mcp] server running on stdio");
  }
}

/**
 * Streamable HTTP transport for MCP clients that connect via URL instead of
 * spawning a local process (e.g. "custom connector" UIs). Bound to 127.0.0.1
 * only — this exposes read/write access to the project's files and must
 * never be reachable from the network.
 */
async function startHttp(server: McpServer, port: number): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const { cert, key } = await loadOrCreateLocalCert();
  const httpServer = https.createServer({ cert, key }, (req, res) => {
    const host = req.headers.host ?? "";
    const remote = req.socket.remoteAddress ?? "";
    const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!isLocal) {
      res.writeHead(403).end("Forbidden: this server only accepts local connections.");
      return;
    }
    if (new URL(req.url ?? "/", `https://${host}`).pathname !== "/mcp") {
      res.writeHead(404).end("Not found. The MCP endpoint is /mcp.");
      return;
    }
    transport.handleRequest(req, res).catch((err) => {
      console.error("[rpgmaker-mv-mcp] request error:", err);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => resolve());
  });

  const url = `https://127.0.0.1:${port}/mcp`;
  console.error(`[rpgmaker-mv-mcp] server running on ${url}`);
  console.error("[rpgmaker-mv-mcp] bound to localhost only, not reachable from the network");
  console.error(
    "[rpgmaker-mv-mcp] using a self-signed certificate — your client/browser will warn about it being untrusted; that is expected for a local-only server"
  );
}

main().catch((err) => {
  console.error("[rpgmaker-mv-mcp] fatal:", err);
  process.exit(1);
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Project, ProjectError } from "../project.js";
import { safe, textResult } from "../util.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
};

function nwjsCandidates(projectRoot: string): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return [
    process.env.RPGMAKER_MV_NWJS ?? "",
    path.join(projectRoot, "Game.exe"),
    "C:\\Program Files (x86)\\Steam\\steamapps\\common\\RPG Maker MV\\nwjs-win\\Game.exe",
    "C:\\Program Files\\Steam\\steamapps\\common\\RPG Maker MV\\nwjs-win\\Game.exe",
    "D:\\Steam\\steamapps\\common\\RPG Maker MV\\nwjs-win\\Game.exe",
    "C:\\Program Files (x86)\\KADOKAWA\\RPGMV\\nwjs-win\\Game.exe",
    path.join(home, ".local/share/Steam/steamapps/common/RPG Maker MV/nwjs-lnx/Game"),
    "/Applications/RPG Maker MV/RPG Maker MV.app/Contents/MacOS/nwjs-osx-test/Game.app/Contents/MacOS/Game",
  ].filter((p) => p !== "");
}

function findNwjsRuntime(projectRoot: string): string | null {
  for (const candidate of nwjsCandidates(projectRoot)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

class PlaytestManager {
  private child: ChildProcess | null = null;
  private httpServer: http.Server | null = null;
  private logs: string[] = [];
  private mode: "nwjs" | "browser" | null = null;
  private url: string | null = null;

  constructor(private project: Project) {}

  private log(line: string): void {
    this.logs.push(`[${new Date().toISOString()}] ${line}`);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
  }

  get status(): Record<string, unknown> {
    return {
      running:
        (this.child !== null && this.child.exitCode === null) || this.httpServer !== null,
      mode: this.mode,
      url: this.url,
      pid: this.child?.pid ?? null,
      logLines: this.logs.length,
    };
  }

  getLogs(tail: number): string[] {
    return this.logs.slice(-tail);
  }

  async startNwjs(runtimePath: string): Promise<Record<string, unknown>> {
    await this.stop();
    if (!fs.existsSync(runtimePath)) {
      throw new ProjectError(`NW.js runtime not found: ${runtimePath}`);
    }
    this.logs = [];
    this.mode = "nwjs";
    this.url = null;
    this.child = spawn(runtimePath, [this.project.root, "test"], {
      cwd: this.project.root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (d: Buffer) => this.log(`stdout: ${d.toString().trim()}`));
    this.child.stderr?.on("data", (d: Buffer) => this.log(`stderr: ${d.toString().trim()}`));
    this.child.on("exit", (code) => this.log(`process exited with code ${code}`));
    this.child.on("error", (err) => this.log(`spawn error: ${err.message}`));
    this.log(`launched ${runtimePath} ${this.project.root} test`);
    return { mode: "nwjs", pid: this.child.pid, runtimePath };
  }

  async startBrowser(port: number): Promise<Record<string, unknown>> {
    await this.stop();
    this.logs = [];
    this.mode = "browser";
    const root = this.project.root;

    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
      const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const filePath = path.join(root, relative);
      if (!filePath.startsWith(root)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      fs.readFile(filePath, (err, content) => {
        if (err) {
          res.writeHead(404).end("Not found");
          return;
        }
        const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        res.end(content);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    this.httpServer = server;
    this.url = `http://127.0.0.1:${port}/index.html?test`;
    this.log(`static server listening on ${this.url}`);
    return {
      mode: "browser",
      url: this.url,
      note: "Open this URL in a browser to playtest. Console output stays in the browser devtools; it cannot be captured here.",
    };
  }

  async stop(): Promise<Record<string, unknown>> {
    const stopped: string[] = [];
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
      stopped.push(`nwjs process ${this.child.pid}`);
    }
    this.child = null;
    if (this.httpServer) {
      const server = this.httpServer;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      stopped.push("http server");
    }
    this.httpServer = null;
    this.mode = null;
    this.url = null;
    return { stopped };
  }
}

export function registerPlaytestTools(server: McpServer, project: Project): void {
  const manager = new PlaytestManager(project);

  server.registerTool(
    "playtest_start",
    {
      title: "Start playtest",
      description:
        "Start a playtest of the current project. mode 'nwjs' launches the game with an NW.js runtime (pass runtimePath, e.g. the Game.exe inside the RPG Maker MV install's nwjs-win folder) and captures its stdout/stderr. mode 'browser' serves the project over a local HTTP server and returns a URL to open. Any previous playtest is stopped first.",
      inputSchema: {
        mode: z.enum(["nwjs", "browser"]).default("browser"),
        runtimePath: z
          .string()
          .optional()
          .describe(
            "Path to NW.js executable. If omitted in nwjs mode, common install locations (Steam, KADOKAWA, the project's own Game.exe, $RPGMAKER_MV_NWJS) are probed automatically."
          ),
        port: z.number().int().min(1024).max(65535).default(8321).describe("Port for browser mode"),
      },
    },
    safe(async ({ mode, runtimePath, port }) => {
      project.root; // throws if no project selected
      if (mode === "nwjs") {
        const runtime = runtimePath ?? findNwjsRuntime(project.root);
        if (!runtime) {
          throw new ProjectError(
            "No NW.js runtime found. Pass runtimePath explicitly, or set the RPGMAKER_MV_NWJS environment variable. Probed:\n" +
              nwjsCandidates(project.root).join("\n")
          );
        }
        return textResult(await manager.startNwjs(runtime));
      }
      return textResult(await manager.startBrowser(port));
    })
  );

  server.registerTool(
    "playtest_status",
    {
      title: "Playtest status",
      description: "Whether a playtest is running, in which mode, and its URL/PID.",
      inputSchema: {},
    },
    safe(async () => textResult(manager.status))
  );

  server.registerTool(
    "playtest_log",
    {
      title: "Playtest log",
      description: "Recent stdout/stderr lines from an NW.js playtest process.",
      inputSchema: {
        tail: z.number().int().min(1).max(500).default(50).describe("Number of lines from the end"),
      },
    },
    safe(async ({ tail }) => {
      const lines = manager.getLogs(tail);
      return textResult(lines.length > 0 ? lines.join("\n") : "(no log output captured)");
    })
  );

  server.registerTool(
    "playtest_stop",
    {
      title: "Stop playtest",
      description: "Stop the running playtest process and/or HTTP server.",
      inputSchema: {},
    },
    safe(async () => textResult(await manager.stop()))
  );
}

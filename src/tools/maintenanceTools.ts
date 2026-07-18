import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { Project, DATABASE_TYPES, ProjectError } from "../project.js";
import { readPluginList } from "./pluginTools.js";
import { safe, textResult } from "../util.js";

interface EventCommand {
  code: number;
  parameters: unknown[];
}

export function registerMaintenanceTools(server: McpServer, project: Project): void {
  server.registerTool(
    "list_backups",
    {
      title: "List backups",
      description:
        "List automatic backup sessions in <project>/.mcp-backups. A file is snapshotted there the first time each server session modifies it, so every session can be rolled back with restore_backup.",
      inputSchema: {},
    },
    safe(async () => {
      const sessions = await project.listBackupSessions();
      if (sessions.length === 0) {
        return textResult("No backups yet. Backups are created automatically when files are modified.");
      }
      return textResult(sessions);
    })
  );

  server.registerTool(
    "restore_backup",
    {
      title: "Restore backup",
      description:
        "Restore project files from a backup session (see list_backups). Restores one file (project-relative path like 'data/Actors.json') or, with no file given, every file in the session. The current state is itself backed up first, so a restore can be undone.",
      inputSchema: {
        session: z
          .string()
          .optional()
          .describe("Backup session name from list_backups; defaults to the most recent"),
        file: z
          .string()
          .optional()
          .describe("Project-relative file to restore; omit to restore all files in the session"),
      },
    },
    safe(async ({ session, file }) => {
      const sessions = await project.listBackupSessions();
      if (sessions.length === 0) throw new ProjectError("No backup sessions exist.");
      const chosen = session ? sessions.find((s) => s.session === session) : sessions[0];
      if (!chosen) {
        throw new ProjectError(
          `No backup session named '${session}'. Available: ${sessions.map((s) => s.session).join(", ")}`
        );
      }
      const targets = file ? [file.replace(/\\/g, "/")] : chosen.files;
      const restored: string[] = [];
      for (const rel of targets) {
        if (!chosen.files.includes(rel)) {
          throw new ProjectError(
            `Session ${chosen.session} has no backup of '${rel}'. It contains: ${chosen.files.join(", ")}`
          );
        }
        const source = path.join(project.backupRoot, chosen.session, rel);
        const dest = path.join(project.root, rel);
        await project.backup(dest);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(source, dest);
        restored.push(rel);
      }
      return textResult({ restoredFrom: chosen.session, restored });
    })
  );

  server.registerTool(
    "validate_project",
    {
      title: "Validate project",
      description:
        "Integrity check of the whole project: parses every database file, verifies MapInfos entries have map files (and finds orphaned map files), checks registered plugins have source files, and scans event commands for references to missing common events or transfer destinations. Returns errors (broken) and warnings (suspicious).",
      inputSchema: {},
    },
    safe(async () => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const checked = { databases: 0, maps: 0, events: 0, plugins: 0 };

      // Database files
      let commonEventCount = 0;
      for (const type of DATABASE_TYPES) {
        try {
          const records = await project.readDatabase(type);
          checked.databases++;
          if (records[0] !== null) {
            warnings.push(`${type}: index 0 is not null (MV expects a null first element).`);
          }
          if (type === "commonEvents") commonEventCount = records.length - 1;
        } catch (err) {
          errors.push(`${type}: ${(err as Error).message}`);
        }
      }

      // System.json
      let system: Record<string, unknown> | null = null;
      try {
        system = await project.readJson<Record<string, unknown>>(project.dataFile("System.json"));
      } catch (err) {
        errors.push(`System.json: ${(err as Error).message}`);
      }

      // MapInfos vs map files
      let mapIds: number[] = [];
      try {
        const infos = await project.readJson<({ id: number; name: string } | null)[]>(
          project.dataFile("MapInfos.json")
        );
        const known = infos.filter((m): m is { id: number; name: string } => m != null);
        mapIds = known.map((m) => m.id);
        for (const info of known) {
          try {
            await fs.access(project.mapFile(info.id));
          } catch {
            errors.push(`MapInfos lists map ${info.id} ('${info.name}') but ${path.basename(project.mapFile(info.id))} is missing.`);
          }
        }
        const dataFiles = await fs.readdir(path.join(project.root, "data"));
        for (const f of dataFiles) {
          const m = f.match(/^Map(\d{3})\.json$/);
          if (m && !mapIds.includes(parseInt(m[1], 10))) {
            warnings.push(`${f} exists but is not listed in MapInfos.json (orphaned map file).`);
          }
        }
        if (system && typeof system.startMapId === "number" && !mapIds.includes(system.startMapId)) {
          errors.push(`System.json startMapId is ${system.startMapId}, which is not a known map.`);
        }
      } catch (err) {
        errors.push(`MapInfos.json: ${(err as Error).message}`);
      }

      // Event command references
      for (const mapId of mapIds) {
        let map: { events?: ({ id: number; name: string; pages?: { list?: EventCommand[] }[] } | null)[] };
        try {
          map = await project.readJson(project.mapFile(mapId));
          checked.maps++;
        } catch {
          continue; // already reported above
        }
        for (const event of map.events ?? []) {
          if (!event) continue;
          checked.events++;
          for (const page of event.pages ?? []) {
            for (const cmd of page.list ?? []) {
              if (cmd.code === 117) {
                const ceId = cmd.parameters[0] as number;
                if (ceId > commonEventCount) {
                  warnings.push(
                    `Map ${mapId} event ${event.id} ('${event.name}') calls common event ${ceId}, but only ${commonEventCount} exist.`
                  );
                }
              }
              if (cmd.code === 201 && cmd.parameters[0] === 0) {
                const destMap = cmd.parameters[1] as number;
                if (!mapIds.includes(destMap)) {
                  warnings.push(
                    `Map ${mapId} event ${event.id} ('${event.name}') transfers the player to map ${destMap}, which does not exist.`
                  );
                }
              }
            }
          }
        }
      }

      // Plugins
      try {
        const plugins = await readPluginList(project);
        checked.plugins = plugins.length;
        for (const plugin of plugins) {
          const file = path.join(project.root, "js", "plugins", `${plugin.name}.js`);
          try {
            await fs.access(file);
          } catch {
            const msg = `Plugin '${plugin.name}' is registered but js/plugins/${plugin.name}.js is missing.`;
            if (plugin.status) errors.push(msg + " (enabled — the game will fail to load)");
            else warnings.push(msg + " (disabled)");
          }
        }
      } catch (err) {
        errors.push(`plugins.js: ${(err as Error).message}`);
      }

      return textResult({
        ok: errors.length === 0,
        errors,
        warnings,
        checked,
      });
    })
  );
}

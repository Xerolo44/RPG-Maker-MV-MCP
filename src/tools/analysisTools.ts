import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Project } from "../project.js";
import { auditAssets } from "../assets.js";
import { safe, textResult } from "../util.js";

const LIST_CAP = 200;

const NOT_SCANNED = [
  "plugin parameters and script/plugin-command text (355, 356)",
  "event commands other than 101, 231, 241, 245, 249, 250, 322 (e.g. 261 movie, 283 battle back, 284 parallax)",
  "Animations.json graphics and sounds, Skills/Items animation or icon sheets, Troops battle backs",
  "note tags, img/system, img/animations, fonts, movies, js/ and icons",
];

function cap<T>(list: T[]): { items: T[]; truncated: number } {
  return { items: list.slice(0, LIST_CAP), truncated: Math.max(0, list.length - LIST_CAP) };
}

export function registerAnalysisTools(server: McpServer, project: Project): void {
  server.registerTool(
    "audit_assets",
    {
      title: "Audit project assets",
      description:
        "Checks that every image and audio file the project references exists on disk, and optionally lists files nothing references. " +
        "Scanned references: Actors (characterName, faceName, battlerName); Enemies battlerName (img/enemies, or img/sv_enemies when System optSideView is on); " +
        "Tilesets tilesetNames; Maps (parallaxName, bgm, bgs, battleback1Name, battleback2Name, event page images); " +
        "event commands 101 (face), 231 (picture), 241/245/249/250 (BGM/BGS/ME/SE) and 322 (actor graphics) in map events, common events and troops; " +
        "System (title1Name, title2Name, battleback1Name, battleback2Name, titleBgm, battleBgm, victoryMe, defeatMe, gameoverMe, boat/ship/airship bgm, sounds). " +
        "Anything else is listed under notScanned, so 'unused' can include files used only by plugins or scripts. " +
        "Audio is satisfied by either an .ogg or an .m4a file. caseMismatch means the file exists only with different letter case: " +
        "it works on Windows but breaks on Linux, macOS and web deployments. Each list is capped at 200 entries; truncated gives the omitted counts.",
      inputSchema: {
        includeUnused: z.boolean().default(true).describe("Also list asset files that no scanned reference uses."),
      },
    },
    safe(async ({ includeUnused }) => {
      const audit = await auditAssets(project, { includeUnused });
      const missing = cap(audit.missing);
      const caseMismatch = cap(audit.caseMismatch);
      const unused = cap(audit.unused);
      return textResult({
        missing: missing.items,
        caseMismatch: caseMismatch.items,
        unused: unused.items,
        truncated: {
          missing: missing.truncated,
          caseMismatch: caseMismatch.truncated,
          unused: unused.truncated,
        },
        checkedFolders: audit.checkedFolders,
        notScanned: NOT_SCANNED,
      });
    }),
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Project } from "../project.js";
import { auditAssets } from "../assets.js";
import { lintProject } from "../lint.js";
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

  server.registerTool(
    "lint_events",
    {
      title: "Lint event command lists",
      description:
        "Statically checks event command lists in map events, common events and troop pages. Rules: " +
        "unterminated-list and block-structure (missing code 0 terminator, unclosed or mismatched choices/branches/loops, indent jumps; error), " +
        "unreachable-command (a command right after Exit Event Processing at the same indent; warning), " +
        "long-message-line (a Show Text line too long for the window; warning), " +
        "transfer-missing-map and transfer-out-of-bounds (direct Transfer Player to a map not in MapInfos or outside its size; error), " +
        "missing-common-event (Common Event call to an id that does not exist; error), " +
        "unnamed-switch and unnamed-variable (Control Switches/Variables on ids with no name in System.json; info). " +
        "Variable-designated transfers are not checked. long-message-line removes message control codes (\\C[n], \\V[n], \\N[n], \\P[n], \\I[n], \\{ \\} \\. \\| \\! \\> \\< \\^) " +
        "and compares the remaining character count with maxLineChars; the default of 50 is only an approximation, since real fit depends on the font, face graphic and window width. " +
        "Findings carry location {kind, mapId, eventId, page, index}; page and index are 0-based positions in the event's pages and command list (common events use page 0, troops use the troop id as eventId). " +
        "minSeverity defaults to warning, so info findings appear only when requested. " +
        "scope defaults to all; mapId limits the map part to one map. Maps whose file cannot be read are listed in skippedMaps. " +
        "Results are sorted by severity then location and capped at 300 findings; counts cover all findings and truncated is the number cut.",
      inputSchema: {
        scope: z.enum(["maps", "commonEvents", "troops", "all"]).default("all").describe("Which event lists to lint."),
        mapId: z.number().int().positive().optional().describe("Lint only this map (affects the maps part of the scope)."),
        maxLineChars: z.number().int().positive().default(50).describe("Longest allowed Show Text line after control codes are removed (approximate)."),
        minSeverity: z.enum(["error", "warning", "info"]).default("warning").describe("Lowest severity to report."),
      },
    },
    safe(async ({ scope, mapId, maxLineChars, minSeverity }) =>
      textResult(await lintProject(project, { scope, mapId, maxLineChars, minSeverity })),
    ),
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProjectError, type Project } from "../project.js";
import { auditAssets } from "../assets.js";
import { lintProject } from "../lint.js";
import type { Cmd } from "../commandList.js";
import { pageConditionsHold, simulateEvent, type SimState } from "../eventSim.js";
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

  server.registerTool(
    "simulate_event",
    {
      title: "Simulate an event",
      description:
        "Dry-runs one map event page against a hypothetical game state and returns what it would do, without touching the project or running the game. " +
        "Supported commands: Show Text (101/401), Show Choices (102/402/403/404), Conditional Branch (111/411/412: switch, variable, self switch, gold, item), " +
        "Loop/Break (112/113/413), Exit Event Processing (115), Common Event (117, nested up to 8 deep), comments, Control Switches (121), Control Variables (122: constant, variable and random operands), " +
        "Control Self Switch (123), Change Gold (125), Change Items (126), Transfer Player (201, ends the run) and Plugin Command (356, listed in changes as 'plugin: ...'). " +
        "Everything else (script 355, audio, pictures, movement, waits, labels, other condition types, game-data operands) is listed in unsupported with its index and skipped; " +
        "an unsupported condition follows unknownCondition: stop (default) ends the run with ended 'unsupported', then/else takes that branch. " +
        "Message text is returned verbatim, control codes unexpanded. Limits: 10000 steps (ended 'stepLimit'), integer variable math (division truncates toward zero; division or modulo by zero leaves the variable unchanged). " +
        "State inputs default to everything OFF/0/empty: switches and variables are keyed by id, selfSwitches by letter A to D, items by item id. " +
        "choices lists the answers to Show Choices in the order they are asked (0-based; a missing answer is 0, an out-of-range one takes the cancel branch). " +
        "page is a 0-based page index; when omitted the highest page whose conditions hold under the supplied state is used (the actor condition counts as met). " +
        "The random operand is seeded (default seed 0), so runs repeat exactly. " +
        "Returns {messages, changes, transfers, unsupported, ended, finalState, pageUsed}.",
      inputSchema: {
        mapId: z.number().int().positive().describe("Map id."),
        eventId: z.number().int().positive().describe("Event id on that map."),
        page: z.number().int().min(0).optional().describe("0-based page index; omit to pick the page that would be active under the supplied state."),
        switches: z.record(z.string().regex(/^[1-9]\d*$/, "switch ids must be positive integers"), z.boolean()).optional().describe('Switch states by id, e.g. {"12": true}.'),
        variables: z.record(z.string().regex(/^[1-9]\d*$/, "variable ids must be positive integers"), z.number().int()).optional().describe('Variable values by id, e.g. {"3": 10}.'),
        selfSwitches: z.record(z.string().regex(/^[ABCD]$/, "self switches are A, B, C or D"), z.boolean()).optional().describe('Self switches of this event, e.g. {"A": true}.'),
        gold: z.number().int().min(0).optional().describe("Party gold (default 0)."),
        items: z.record(z.string().regex(/^[1-9]\d*$/, "item ids must be positive integers"), z.number().int().min(0)).optional().describe('Items held by id, e.g. {"4": 1}.'),
        choices: z.array(z.number().int().min(0)).max(50).optional().describe("Answers to Show Choices, in the order they are asked."),
        seed: z.number().int().optional().describe("Seed for the random operand (default 0)."),
        unknownCondition: z.enum(["then", "else", "stop"]).default("stop").describe("What to do at a condition that cannot be simulated."),
      },
    },
    safe(async ({ mapId, eventId, page, switches, variables, selfSwitches, gold, items, choices, seed, unknownCondition }) => {
      void project.root; // throws the standard "No project selected" error first
      const mapFile = project.mapFile(mapId);
      if (!(await project.exists(mapFile))) throw new ProjectError(`map ${mapId} does not exist. Use list_maps to see the map ids.`);
      const map = (await project.readJson(mapFile)) as { events?: unknown[] } | null;
      const event = map?.events?.[eventId] as { pages?: unknown[] } | null | undefined;
      if (!event) throw new ProjectError(`event ${eventId} does not exist on map ${mapId}. Use search_map_events to find event ids.`);
      const pages = Array.isArray(event.pages) ? event.pages : [];

      const keyed = <V>(rec: Record<string, V> | undefined): Record<number, V> =>
        Object.fromEntries(Object.entries(rec ?? {}).map(([k, v]) => [Number(k), v]));
      const state: SimState = {
        switches: keyed(switches),
        variables: keyed(variables),
        selfSwitches: { ...selfSwitches },
        gold: gold ?? 0,
        items: keyed(items),
      };

      let pageUsed = page;
      if (pageUsed === undefined) {
        for (let i = pages.length - 1; i >= 0; i--) {
          const candidate = pages[i] as { conditions?: unknown } | null;
          if (candidate && pageConditionsHold(candidate.conditions, state)) { pageUsed = i; break; }
        }
        if (pageUsed === undefined) {
          throw new ProjectError(`no page of event ${eventId} on map ${mapId} has its conditions met by the supplied state. Pass page to run one anyway.`);
        }
      } else if (!pages[pageUsed]) {
        throw new ProjectError(`event ${eventId} on map ${mapId} has no page ${pageUsed} (it has ${pages.length}, indexed from 0).`);
      }

      let common: unknown[] = [];
      const commonFile = project.dataFile("CommonEvents.json");
      if (await project.exists(commonFile)) {
        const parsed = await project.readJson(commonFile);
        if (Array.isArray(parsed)) common = parsed;
      }
      const list = (pages[pageUsed] as { list?: Cmd[] }).list ?? [];
      const trace = simulateEvent(list, state, {
        choices,
        seed,
        unknownCondition,
        mapId,
        eventId,
        commonEvents: (id) => {
          const ce = common[id] as { list?: unknown } | null | undefined;
          return ce && Array.isArray(ce.list) ? (ce.list as Cmd[]) : null;
        },
      });
      return textResult({ ...trace, pageUsed });
    }),
  );
}

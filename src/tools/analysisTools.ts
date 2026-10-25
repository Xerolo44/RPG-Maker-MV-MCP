import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProjectError, type Project } from "../project.js";
import { auditAssets } from "../assets.js";
import { lintProject } from "../lint.js";
import type { Cmd } from "../commandList.js";
import { pageConditionsHold, simulateEvent, type SimState } from "../eventSim.js";
import { buildProjectIndex } from "../eventIndex.js";
import { findUsages, REF_KINDS, resolveTargetName } from "../usages.js";
import { safe, textResult } from "../util.js";
import { registerProgressionTool } from "./progressionTools.js";

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
        "Battle Processing (301) is not fought: the branch picked by battleResult runs (win, escape or lose; default win) and the others are skipped; a missing branch adds 'battle: no <result> branch' to changes. " +
        "Label (118) and Jump to Label (119) work: a jump goes to the first label of that name in the current command list and counts as a step, so a label loop ends 'stepLimit'; a missing label is listed in unsupported and the run continues. " +
        "Presentation commands (Set Movement Route 205, animation and balloon 212/213, screen fades, tint, flash and shake 221-225, wait 230, show/erase picture 231/235, weather 236, play/fade audio 241/242/245/246/249/250/251, 505 route rows) are ignored and only counted in cosmetic, not listed in unsupported; " +
        "the one exception is the switch ON/OFF steps of a Set Movement Route, which do change the simulated switches (changes: 'switch N → ON (move route)'; only the first 1000 route entries are scanned, each costing one step, and a longer route adds an unsupported note). A battleResult of escape or lose on a battle that cannot be escaped or lost still runs the branch but adds a note to changes. " +
        "Everything else (script 355, other condition types, game-data operands, party and scene commands, ...) is listed in unsupported with its index and skipped; " +
        "an unsupported condition follows unknownCondition: stop (default) ends the run with ended 'unsupported', then/else takes that branch. " +
        "Message text is returned verbatim, control codes unexpanded. Limits: 10000 steps (ended 'stepLimit'), integer variable math (results are floored like the engine, so -7 / 2 gives -4; division or modulo by zero leaves the variable unchanged; a random or variable operand is evaluated once per command). A command that changes several switches or variables adds one changes entry for the whole range. messages, changes and unsupported are each capped at 2000 entries; omitted counts what was dropped (present only then) and finalState stays exact. " +
        "State inputs default to everything OFF/0/empty: switches and variables are keyed by id, selfSwitches by letter A to D, items by item id. " +
        "choices lists the answers to Show Choices in the order they are asked (0-based; a missing answer is 0, an out-of-range one takes the cancel branch). " +
        "page is a 0-based page index; when omitted the highest page whose conditions hold under the supplied state is used (the actor condition counts as met). " +
        "The random operand is seeded (default seed 0), so runs repeat exactly. " +
        "Returns {messages, changes, transfers, unsupported, cosmetic, ended, finalState, pageUsed}.",
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
        battleResult: z.enum(["win", "escape", "lose"]).optional().describe("How every Battle Processing command ends, which decides the branch that runs (default win)."),
        unknownCondition: z.enum(["then", "else", "stop"]).default("stop").describe("What to do at a condition that cannot be simulated."),
      },
    },
    safe(async ({ mapId, eventId, page, switches, variables, selfSwitches, gold, items, choices, seed, unknownCondition, battleResult }) => {
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
        battleResult,
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

  server.registerTool(
    "find_usages",
    {
      title: "Find usages",
      description:
        "Lists everywhere one switch, variable, item, weapon, armor, skill, state, actor, class, enemy, troop, common event or map is read, written or used, " +
        "and warns about dead ends. Use it before renaming, deleting or reusing an id. " +
        "reads: page conditions, Conditional Branch (111), variable operands and \\V[n] text escapes; writes: Control Switches/Variables (121/122), Change Items/Weapons/Armors (126-128), Change Party Member (129), Change State/Skill (313/318), set-switch route steps; " +
        "uses: Transfer Player (201), Common Event (117), Battle Processing (301), shops (302/605), actor commands, enemy drops and actions, class learnings, actor equipment, troop members, item/skill effects, map encounter lists, System startMapId and partyMembers. " +
        "It reads staged changeset data. Each location is a string: 'Map003 event 5 page 1 command index 12', 'CommonEvent 4 command index 7', 'Troop 2 page 1 command index 3', 'Enemies #4 dropItems', 'System startMapId', 'Map003 encounterList'. " +
        "Map ids, event ids, common event ids and troop ids are the real ids and pages are 1-based like the editor shows them, but 'command index N' is the 0-based position in the command list (the index lint_events reports). " +
        "A location without a command index is a page condition. counts are the true totals; each list is cut at limit entries and truncated gives the omitted counts. " +
        "warnings cover: a switch or variable that is read but never set, or set but never read; a common event never called (autorun and parallel common events are exempt); a map nothing transfers to; and an id with no name or record (unknown id, not an error). " +
        "Script commands (355), plugin commands (356), variable-designated transfers and battles, notetags and plugin parameters are not understood, so every 'never ...' warning carries a note when the project has script or plugin commands (or truncated range commands) that could act on the id. " +
        "Only the 121/122 ids up to 1000 per command are indexed.",
      inputSchema: {
        kind: z.enum(REF_KINDS).describe("What to look up."),
        id: z.number().int().min(1).max(2147483647).describe("Id of the switch, variable, database record, common event or map."),
        limit: z.number().int().min(1).max(500).default(100).describe("Most locations listed per role (reads, writes, uses)."),
      },
    },
    safe(async ({ kind, id, limit }) => {
      void project.root; // throws the standard "No project selected" error first
      const index = await buildProjectIndex(project);
      const name = await resolveTargetName(project, kind, id);
      return textResult(findUsages(index, { kind, id }, { limit, name }));
    }),
  );

  registerProgressionTool(server, project);
}

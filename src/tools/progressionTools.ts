// analyze_progression: the tool wrapper around src/progression.ts. Lives in its own file (registerAnalysisTools in
// analysisTools.ts calls registerProgressionTool) because the summary and goal handling are long; the analysis itself
// stays pure in src/progression.ts.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProjectError, type Project } from "../project.js";
import { buildProjectIndex, type ProjectIndex } from "../eventIndex.js";
import { analyzeProgressionDetailed, progressionGraph, type Goal, type ProgressionReport } from "../progression.js";
import { safe, textResult } from "../util.js";

const MAX_ID = 2147483647;
// A function, so each use is its own schema object (a shared one would be emitted as a $ref).
const id = () => z.number().int().min(1).max(MAX_ID);

const goalSchema = z
  .object({
    switch: id().optional().describe("Can this switch ever be ON?"),
    mapId: id().optional().describe("Can the player ever get to this map?"),
    event: z.object({ mapId: id(), eventId: id() }).strict().optional().describe("Can any page of this map event ever run?"),
  })
  .strict()
  .refine((g) => Object.values(g).filter((v) => v !== undefined).length === 1, {
    message: "goal must have exactly one key: switch, mapId or event",
  });

const DESCRIPTION = [
  "Answers 'can the player get from the start map to X, and what can never happen?' for the whole project, without running the game.",
  "Model (an over-approximation): starting at System startMapId, a page may run whenever its page conditions could hold, and when it runs ALL of its commands take effect. " +
    "Switches only ever turn ON, items are never lost, and conditions inside event commands (branches, choices) are ignored. " +
    "So 'unreachable' (maps, pages, goals) is a proof under the model, while 'reachable' only means 'not ruled out'.",
  "It cannot see script commands (355), plugin commands (356), variable-designated transfers or battles, enabled plugins (parameters, notetags) or anything else a plugin does. " +
    "Each of those, an unreadable map or an unreadable js/plugins.js lowers uncertainty.confidence to 'low'; only trust 'unreachable' and 'dead' results when confidence is 'high'.",
  "Returns reachableMaps, unreachableMaps, deadEndMaps (no exit), deadPages (pages that can never run, with the first unmet condition), " +
    "switches/variables read-but-never-set and set-but-never-read, edges (direct transfers), notes, a plain-language summary and names (map id to name).",
  "goal (exactly one of switch, mapId or event) adds a verdict with up to 10 blockedBy reasons. includeGraph adds a Mermaid flowchart of the map transfers. " +
    "Lists are cut at limit (the summary counts stay exact); truncated is also set when an analysis cap was hit (see notes). Staged changeset data is analysed.",
].join("\n");

const CAVEAT =
  "This is an over-approximation: it ignores conditions inside event commands and anything done by scripts or plugins " +
  "(including enabled plugins and their notetags), so 'unreachable' is reliable only when confidence is high; 'reachable' only means 'not ruled out'.";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function toGoal(goal: z.infer<typeof goalSchema>): Goal {
  if (goal.switch !== undefined) return { switch: goal.switch };
  if (goal.mapId !== undefined) return { mapId: goal.mapId };
  return { event: goal.event as { mapId: number; eventId: number } };
}

/** True when the map file has an event with this id (whatever its pages), using the same id rule as the index. */
async function mapHasEvent(project: Project, mapId: number, eventId: number): Promise<boolean> {
  try {
    const map = await project.readJson(project.mapFile(mapId));
    const events = typeof map === "object" && map !== null ? (map as { events?: unknown }).events : undefined;
    if (!Array.isArray(events)) return false;
    return events.some((ev, i) => {
      if (typeof ev !== "object" || ev === null) return false;
      const id = (ev as { id?: unknown }).id;
      return (typeof id === "number" && Number.isInteger(id) ? id : i) === eventId;
    });
  } catch {
    return false;
  }
}

/** Rejects a goal that names a map or event the project does not have (an unreadable map is left to the analysis). */
async function checkGoal(project: Project, index: ProjectIndex, goal: Goal): Promise<void> {
  const unlisted = (mapId: number): ProjectError =>
    new ProjectError(`map ${mapId} is not listed in MapInfos.json. Use list_maps to see the map ids.`);
  if ("mapId" in goal && !index.mapIds.includes(goal.mapId)) throw unlisted(goal.mapId);
  if ("event" in goal) {
    const { mapId, eventId } = goal.event;
    if (!index.mapIds.includes(mapId)) throw unlisted(mapId);
    const exists = index.pages.some((p) => p.kind === "map" && p.mapId === mapId && p.eventId === eventId);
    if (!exists && !index.unreadableMaps.includes(mapId)) {
      if (await mapHasEvent(project, mapId, eventId)) {
        throw new ProjectError(`event ${eventId} on map ${mapId} has no pages, so it can never run. Use get_event to inspect it.`);
      }
      throw new ProjectError(`event ${eventId} does not exist on map ${mapId}. Use search_map_events to find event ids.`);
    }
  }
}

/** Why the confidence is low, as a list of causes (empty when only reasons that are in `notes` apply). */
function lowReasons(full: ProgressionReport, index: ProjectIndex): string[] {
  const u = full.uncertainty;
  const reasons: string[] = [];
  if (u.scriptCommands > 0) reasons.push(plural(u.scriptCommands, "script command"));
  if (u.pluginCommands > 0) reasons.push(plural(u.pluginCommands, "plugin command"));
  if (u.variableTransfers > 0) reasons.push(plural(u.variableTransfers, "variable-designated transfer"));
  if (u.variableBattles > 0) reasons.push(plural(u.variableBattles, "variable-designated battle"));
  const { enabledPlugins, enabledPluginNames } = index.hidden;
  if (enabledPlugins > 0) {
    reasons.push(`${plural(enabledPlugins, "enabled plugin")} (${enabledPluginNames.join(", ")}${enabledPlugins > enabledPluginNames.length ? ", ..." : ""})`);
  }
  if (index.hidden.pluginsUnreadable === true) reasons.push("an unreadable js/plugins.js");
  return reasons;
}

/** The 3-6 plain-language lines. Counts come from `full` (the report without the limit) so they stay exact. */
export function summarize(
  report: ProgressionReport,
  full: ProgressionReport,
  index: ProjectIndex,
  limit: number,
  listsCut: boolean,
): string[] {
  const lines: string[] = [];
  const reachable = full.reachableMaps.length;
  lines.push(
    `${plural(reachable, "map")} ${reachable === 1 ? "is" : "are"} reachable from the start map ${full.startMapId} ` +
      `(${full.deadEndMaps.length} with no way out, i.e. dead ends); ` +
      `${full.unreachableMaps.length} ${full.unreachableMaps.length === 1 ? "is" : "are"} unreachable.`,
  );
  lines.push(
    `${plural(full.deadPages.length, "event page")} can never run (dead pages). ` +
      `Switches: ${full.switches.neverSet.length} read but never set, ${full.switches.neverRead.length} set but never read. ` +
      `Variables: ${full.variables.neverSet.length} read but never set, ${full.variables.neverRead.length} set but never read.`,
  );
  if (report.goal !== undefined) {
    const g = report.goal;
    if (g.reachable) {
      lines.push(`Goal ${g.target}: reachable (not ruled out).`);
    } else {
      const why = g.blockedBy.slice(0, 3).join("; ");
      const doubt = full.uncertainty.confidence === "low" ? " The confidence is low, so this may be wrong." : "";
      lines.push(`Goal ${g.target}: NOT reachable under this model.${why === "" ? "" : ` Blocked by: ${why}.`}${doubt}`);
    }
  }
  if (full.uncertainty.confidence === "high") {
    lines.push(
      "Confidence is high: the project has no script commands, plugin commands, variable-designated transfers or battles, and no enabled plugins.",
    );
  } else {
    const reasons = lowReasons(full, index);
    lines.push(
      `Confidence is low${reasons.length > 0 ? ` because the project has ${reasons.join(", ")}` : ""}` +
        `${full.notes.length > 0 ? `; see notes for details` : ""}. 'Unreachable' and 'dead' results may be wrong.`,
    );
  }
  // `truncated` is also set by an analysis cap, where no list is cut and raising the limit does not help.
  if (listsCut) lines.push(`The lists below are cut at limit ${limit}; the counts above are exact. Raise limit (up to 500) to see more.`);
  if (full.truncated) lines.push("Results were truncated by an analysis cap (see notes); counts may be approximate.");
  lines.push(CAVEAT);
  return lines;
}

/** Map id to name from MapInfos.json (staged edits included); a missing or unreadable file gives an empty map. */
async function readMapNames(project: Project): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  let infos: unknown;
  try {
    infos = await project.readJson(project.dataFile("MapInfos.json"));
  } catch {
    return names;
  }
  if (!Array.isArray(infos)) return names;
  for (const info of infos) {
    if (typeof info !== "object" || info === null) continue;
    const { id: mapId, name } = info as { id?: unknown; name?: unknown };
    if (typeof mapId === "number" && Number.isInteger(mapId) && typeof name === "string" && name !== "") names.set(mapId, name);
  }
  return names;
}

export function registerProgressionTool(server: McpServer, project: Project): void {
  server.registerTool(
    "analyze_progression",
    {
      title: "Analyze progression",
      description: DESCRIPTION,
      inputSchema: {
        goal: goalSchema.optional().describe("What to check, exactly one key: { switch: n }, { mapId: n } or { event: { mapId, eventId } }."),
        includeGraph: z.boolean().default(false).describe("Also return a Mermaid flowchart of the direct map transfers."),
        limit: z.number().int().min(1).max(500).default(200).describe("Most entries per list in the report."),
      },
    },
    safe(async ({ goal, includeGraph, limit }) => {
      void project.root; // throws the standard "No project selected" error first
      const index = await buildProjectIndex(project);
      const parsed = goal === undefined ? undefined : toGoal(goal);
      if (parsed !== undefined) await checkGoal(project, index, parsed);

      const { report, listsCut } = analyzeProgressionDetailed(index, { goal: parsed, limit });
      // Lists are cut at `limit`; the summary counts the whole result, so it needs a second run only when a list was cut.
      const full = listsCut ? analyzeProgressionDetailed(index, { goal: parsed, limit: Number.MAX_SAFE_INTEGER }).report : report;

      const allNames = await readMapNames(project);
      const mentioned = new Set<number>([report.startMapId, ...report.reachableMaps, ...report.unreachableMaps, ...report.deadEndMaps]);
      for (const e of report.edges) {
        mentioned.add(e.from);
        mentioned.add(e.to);
      }
      for (const p of report.deadPages) if (p.mapId !== undefined) mentioned.add(p.mapId);
      if (parsed !== undefined && "mapId" in parsed) mentioned.add(parsed.mapId);
      if (parsed !== undefined && "event" in parsed) mentioned.add(parsed.event.mapId);
      const names: Record<number, string> = {};
      for (const mapId of [...mentioned].sort((a, b) => a - b)) {
        const name = allNames.get(mapId);
        if (name !== undefined) names[mapId] = name;
      }

      const result: Record<string, unknown> = { summary: summarize(report, full, index, limit, listsCut), ...report, names };
      if (includeGraph) result.graph = progressionGraph(report, allNames);
      return textResult(result);
    }),
  );
}

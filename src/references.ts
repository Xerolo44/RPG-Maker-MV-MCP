// check_references: finds references that point at records which do not exist (a Battle Processing on troop 1
// when the project has no troop 1, a shop item 7, Learn Skill 12, ...). It reads the shared project index
// (src/eventIndex.ts), so it sees exactly the references find_usages sees and nothing else; existence comes from
// the database files and MapInfos.json (the same tables find_usages uses to resolve an "unknown id").
import { buildProjectIndex, type ProjectIndex, type RefKind } from "./eventIndex.js";
import type { Project } from "./project.js";
import { describeWhere, readRecordTable, recordIds, REF_KINDS, TABLES } from "./usages.js";

export interface MissingReference {
  kind: RefKind;
  id: number;
  /** Number of references to this record (a command that names it twice counts twice). */
  count: number;
  /** At most MAX_LOCATIONS distinct locations, see describeWhere in usages.ts. */
  locations: string[];
  severity: "error";
}

export interface ReferenceReport {
  /** One line: "N references to M records that do not exist" or "no dangling references found". */
  summary: string;
  /** Grouped by kind and id, ordered by kind (the order of REF_KINDS) then id, cut at `limit` groups. */
  missing: MissingReference[];
  /** Number of groups cut by `limit`. */
  truncated: number;
  /** Totals over everything found, whatever `limit` is. */
  counts: { distinctMissing: number; references: number };
  /** What was not checked, and which database files could not be read. */
  notes: string[];
}

export interface CheckReferencesOptions {
  /** Most groups returned (default 100). */
  limit?: number;
  /** An index built earlier; built from the project when omitted. */
  index?: ProjectIndex;
}

const MAX_LOCATIONS = 3;
const DEFAULT_LIMIT = 100;

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export async function checkReferences(project: Project, opts: CheckReferencesOptions = {}): Promise<ReferenceReport> {
  void project.root; // throws the standard "No project selected" error first
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_LIMIT));
  const index = opts.index ?? (await buildProjectIndex(project));

  // Group the references of each checkable kind by id.
  const byKind = new Map<RefKind, Map<number, { count: number; locations: string[] }>>();
  for (const r of index.refs) {
    if (TABLES[r.kind] === undefined) continue; // switches and variables are not checked
    let ids = byKind.get(r.kind);
    if (ids === undefined) byKind.set(r.kind, (ids = new Map()));
    let group = ids.get(r.id);
    if (group === undefined) ids.set(r.id, (group = { count: 0, locations: [] }));
    group.count++;
    if (group.locations.length < MAX_LOCATIONS) {
      const where = describeWhere(r.where);
      if (!group.locations.includes(where)) group.locations.push(where);
    }
  }

  const all: MissingReference[] = [];
  const notes: string[] = [];
  let unchecked = 0;
  for (const kind of REF_KINDS) {
    const ids = byKind.get(kind);
    if (ids === undefined) continue;
    const records = await readRecordTable(project, kind);
    if (records === undefined) {
      let n = 0;
      for (const g of ids.values()) n += g.count;
      unchecked += n;
      notes.push(
        `${TABLES[kind]} is missing or could not be read, so ${n} ${plural(n, "reference", "references")} to ${kind} records ${plural(n, "was", "were")} not checked.`,
      );
      continue;
    }
    const existing = recordIds(records);
    for (const [id, g] of [...ids].sort((a, b) => a[0] - b[0])) {
      if (!existing.has(id)) all.push({ kind, id, count: g.count, locations: g.locations, severity: "error" });
    }
  }

  const references = all.reduce((sum, m) => sum + m.count, 0);
  const summary =
    (all.length === 0
      ? "no dangling references found"
      : `${references} ${plural(references, "reference", "references")} to ${all.length} ${plural(all.length, "record that does", "records that do")} not exist`) +
    (unchecked > 0 ? " (some references could not be checked, see notes)" : "");

  notes.push(...limitationNotes(index));
  return {
    summary,
    missing: all.slice(0, limit),
    truncated: Math.max(0, all.length - limit),
    counts: { distinctMissing: all.length, references },
    notes,
  };
}

/** What this check cannot see, with the counts of the commands that could hide references in this project. */
function limitationNotes(index: ProjectIndex): string[] {
  const h = index.hidden;
  const notes = [
    "Checked: the references the project index reads (find_usages lists them), against the records in the database files and MapInfos.json. " +
      "Id 0 means 'none' and is never a reference.",
    "Switches and variables are not checked: they are plain numbers (lint_events reports unnamed ones as info).",
    "Not checked: references made by script commands, plugin commands, notetags, plugin parameters, damage formulas, trait codes, vehicle start maps, " +
      "commands 314, 319, 320, 324, 325, 336 and 339, and the class, skill, weapon, armor and state tests of Conditional Branch (111) on an actor.",
  ];
  const scriptPlugin = h.scriptCommands + h.pluginCommands;
  if (scriptPlugin > 0) {
    notes.push(
      `This project has ${h.scriptCommands} script ${plural(h.scriptCommands, "command", "commands")} and ${h.pluginCommands} plugin ${plural(h.pluginCommands, "command", "commands")} ` +
        "whose references are not visible to this check.",
    );
  }
  const designated = h.variableTransfers + h.variableBattles;
  if (designated > 0) {
    notes.push(
      `${h.variableTransfers} Transfer Player and ${h.variableBattles} Battle Processing commands designate their target by variable, ` +
        "so those targets are not checked.",
    );
  }
  if (h.enabledPlugins > 0) {
    notes.push(`${h.enabledPlugins} enabled ${plural(h.enabledPlugins, "plugin", "plugins")} could act on records through parameters and notetags (not checked).`);
  }
  if (h.pluginsUnreadable) notes.push("js/plugins.js exists but could not be parsed, so the enabled plugins are unknown.");
  if (index.unreadableMaps.length > 0) {
    notes.push(
      `${index.unreadableMaps.length} ${plural(index.unreadableMaps.length, "map", "maps")} listed in MapInfos.json could not be read ` +
        `(${index.unreadableMaps.slice(0, 10).join(", ")}${index.unreadableMaps.length > 10 ? ", ..." : ""}), so their events and encounter lists were not checked.`,
    );
  }
  return notes;
}

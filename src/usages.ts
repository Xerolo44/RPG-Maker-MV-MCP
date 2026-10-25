// find_usages: queries the shared project index (src/eventIndex.ts) for one switch, variable, item, map, ...
// and turns the matching references into readable locations plus a few warnings about dead ends.
import type { IndexedRef, ProjectIndex, RefKind, Where } from "./eventIndex.js";
import type { Project } from "./project.js";

/** Every reference kind the index knows, in the order the tool lists them. */
export const REF_KINDS = [
  "switch",
  "variable",
  "item",
  "weapon",
  "armor",
  "skill",
  "state",
  "actor",
  "class",
  "enemy",
  "troop",
  "commonEvent",
  "map",
] as const satisfies readonly RefKind[];

export interface UsageReport {
  /** `name` is absent when the id has no name (or no record) in the project data. */
  target: { kind: RefKind; id: number; name?: string };
  /** Locations, see describeWhere. Each list holds at most `limit` entries; `counts` has the full numbers. */
  reads: string[];
  writes: string[];
  uses: string[];
  counts: { reads: number; writes: number; uses: number };
  warnings: string[];
  truncated: { reads: number; writes: number; uses: number };
}

const pad3 = (n: number): string => String(n).padStart(3, "0");

/**
 * Human-readable location. Map, event and page numbers read like the editor (pages are 1-based; event, common
 * event, troop and map ids are the ids themselves); `command index N` is the 0-based position in the event's
 * command list. A location without a command index is a page condition (or the common event's trigger switch).
 */
export function describeWhere(w: Where): string {
  switch (w.source) {
    case "map": {
      const map = w.mapId === undefined ? "Map" : `Map${pad3(w.mapId)}`;
      if (w.eventId === undefined) return w.field === undefined ? map : `${map} ${w.field}`;
      return `${map} event ${w.eventId}${pageAndCommand(w)}`;
    }
    case "commonEvent":
      return `CommonEvent ${w.eventId ?? "?"}${w.index === undefined ? " conditions" : ` command index ${w.index}`}`;
    case "troop":
      return `Troop ${w.eventId ?? "?"}${pageAndCommand(w)}`;
    case "database": {
      const row = w.table === undefined ? "Database" : w.recordId === undefined ? w.table : `${w.table} #${w.recordId}`;
      return w.field === undefined ? row : `${row} ${w.field}`;
    }
    case "system":
      return w.field === undefined ? "System" : `System ${w.field}`;
  }
}

function pageAndCommand(w: Where): string {
  const page = w.page === undefined ? "" : ` page ${w.page + 1}`;
  if (w.index === undefined) return w.page === undefined ? "" : `${page} conditions`;
  return `${page} command index ${w.index}`;
}

const KIND_LABEL: Record<RefKind, string> = {
  switch: "switch",
  variable: "variable",
  item: "item",
  weapon: "weapon",
  armor: "armor",
  skill: "skill",
  state: "state",
  actor: "actor",
  class: "class",
  enemy: "enemy",
  troop: "troop",
  commonEvent: "common event",
  map: "map",
};

/**
 * Queries the index for every reference to `target`. `opts.name` is the display name from the project data:
 * undefined means "no such record" (adds an `unknown id` warning), an empty string means "exists but unnamed".
 */
export function findUsages(
  index: ProjectIndex,
  target: { kind: RefKind; id: number },
  opts: { limit: number; name?: string },
): UsageReport {
  const found: IndexedRef[] = index.refs.filter((r) => r.kind === target.kind && r.id === target.id);
  const byRole = (role: IndexedRef["role"]): IndexedRef[] => found.filter((r) => r.role === role);
  const reads = byRole("read");
  const writes = byRole("write");
  const uses = byRole("use");

  const limit = Math.max(0, opts.limit);
  const list = (refs: IndexedRef[]): string[] => refs.slice(0, limit).map((r) => describeWhere(r.where));
  const cut = (refs: IndexedRef[]): number => Math.max(0, refs.length - limit);

  const reportTarget: UsageReport["target"] = { kind: target.kind, id: target.id };
  if (opts.name !== undefined && opts.name !== "") reportTarget.name = opts.name;

  const warnings: string[] = [];
  const label = KIND_LABEL[target.kind];
  if (opts.name === undefined) warnings.push(`unknown id: no ${label} with id ${target.id} was found in the project data`);

  const { scriptCommands, pluginCommands, variableTransfers, truncatedRanges } = index.hidden;
  const scriptPlugin = scriptCommands + pluginCommands;
  // A script or plugin command could do what the index cannot see, and a truncated range hides ids: say so.
  let doubt = "";
  if (scriptPlugin > 0) doubt += ` — note: ${scriptPlugin} script/plugin commands in this project could also set or read it.`;
  if ((target.kind === "switch" || target.kind === "variable") && truncatedRanges > 0) {
    doubt += ` — note: ${truncatedRanges} range commands longer than 1000 ids were truncated.`;
  }

  if (target.kind === "switch" || target.kind === "variable") {
    if (reads.length > 0 && writes.length === 0) {
      warnings.push(`${label} ${target.id} is read but never set anywhere (always OFF/0 unless a script or plugin sets it)${doubt}`);
    } else if (writes.length > 0 && reads.length === 0) {
      warnings.push(`${label} ${target.id} is set but never read${doubt}`);
    }
  } else if (target.kind === "commonEvent" && uses.length === 0) {
    // Autorun (1) and parallel (2) common events run on their own switch and need no caller.
    const runsByItself = index.pages.some((p) => p.kind === "commonEvent" && p.eventId === target.id && (p.trigger === 1 || p.trigger === 2));
    if (!runsByItself) warnings.push(`${label} ${target.id} is never called${doubt}`);
  } else if (target.kind === "map" && uses.length === 0) {
    const transferring = scriptPlugin + variableTransfers;
    const note =
      transferring > 0
        ? ` — note: ${transferring} script, plugin or variable-designated transfer commands in this project could also send the player here.`
        : "";
    warnings.push(`no event transfers the player here and it is not the start map${note}`);
  }

  return {
    target: reportTarget,
    reads: list(reads),
    writes: list(writes),
    uses: list(uses),
    counts: { reads: reads.length, writes: writes.length, uses: uses.length },
    warnings,
    truncated: { reads: cut(reads), writes: cut(writes), uses: cut(uses) },
  };
}

const TABLES: Partial<Record<RefKind, string>> = {
  item: "Items.json",
  weapon: "Weapons.json",
  armor: "Armors.json",
  skill: "Skills.json",
  state: "States.json",
  actor: "Actors.json",
  class: "Classes.json",
  enemy: "Enemies.json",
  troop: "Troops.json",
  commonEvent: "CommonEvents.json",
  map: "MapInfos.json",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Display name of a target from the project data (staged edits included): database arrays, MapInfos.json, or
 * System.json `switches`/`variables`. undefined when the id has no record (or the file is missing or unreadable);
 * an empty string when the record exists without a name.
 */
export async function resolveTargetName(project: Project, kind: RefKind, id: number): Promise<string | undefined> {
  const read = async (file: string): Promise<unknown> => {
    try {
      return await project.readJson(project.dataFile(file));
    } catch {
      return undefined;
    }
  };
  if (kind === "switch" || kind === "variable") {
    const system = await read("System.json");
    const names = isObj(system) ? system[kind === "switch" ? "switches" : "variables"] : undefined;
    if (!Array.isArray(names) || id >= names.length) return undefined;
    return typeof names[id] === "string" ? names[id] : "";
  }
  const file = TABLES[kind];
  const records = file === undefined ? undefined : await read(file);
  if (!Array.isArray(records)) return undefined;
  const record = records.find((r) => isObj(r) && r.id === id);
  if (!isObj(record)) return undefined;
  return typeof record.name === "string" ? record.name : "";
}

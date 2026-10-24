// Static checks for event command lists (map events, common events, troop pages).
// Pure logic lives in lintCommandList; lintProject loads the data and applies it everywhere.
import { validateCommandList, type Cmd } from "./commandList.js";
import { ProjectError, type Project } from "./project.js";

export type LintRule =
  | "unterminated-list"
  | "block-structure"
  | "unreachable-command"
  | "long-message-line"
  | "unnamed-switch"
  | "unnamed-variable"
  | "transfer-missing-map"
  | "transfer-out-of-bounds"
  | "missing-common-event";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  rule: LintRule;
  severity: Severity;
  location: { kind: "map" | "commonEvent" | "troop"; mapId?: number; eventId: number; page: number; index: number };
  message: string;
}

export interface LintContext {
  mapIds: Set<number>;
  mapSizes: Map<number, { width: number; height: number }>;
  commonEventIds: Set<number>;
  switchNames: string[];
  variableNames: string[];
  maxLineChars: number;
}

export type LintScope = "maps" | "commonEvents" | "troops" | "all";

export interface LintResult {
  findings: Finding[];
  /** Totals for everything found (after the minSeverity filter), including findings cut by the cap. */
  counts: Record<Severity, number>;
  skippedMaps: number[];
  /** Number of findings cut by the cap. */
  truncated: number;
}

export const MAX_FINDINGS = 300;
/** Longest switch/variable range inspected for names, so a malformed 121/122 cannot stall the lint. */
const MAX_RANGE = 10000;

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const KIND_RANK = { map: 0, commonEvent: 1, troop: 2 } as const;

// Message control codes that take no space on screen (\G and \\ are left alone: they print text).
const PARAM_CODES = /\\[CVNPI]\[\d+\]/gi;
const BARE_CODES = /\\[{}.|!><^]/g;
const visibleLength = (text: string): number => text.replace(PARAM_CODES, "").replace(BARE_CODES, "").length;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function unnamedIds(names: string[], start: unknown, end: unknown): number[] {
  if (!isInt(start) || !isInt(end)) return [];
  const ids: number[] = [];
  const last = Math.min(end, start + MAX_RANGE - 1);
  for (let id = Math.max(start, 1); id <= last; id++) {
    if ((names[id] ?? "").trim() === "") ids.push(id);
  }
  return ids;
}

function describeIds(ids: number[]): string {
  const shown = ids.slice(0, 5).join(", ");
  return ids.length > 5 ? `${shown} and ${ids.length - 5} more` : shown;
}

/** Why a list entry is not a usable command, or null when it is well formed. */
function malformedReason(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "entry is not an object";
  const c = entry as Record<string, unknown>;
  if (typeof c.code !== "number") return "entry has no numeric code";
  if (typeof c.indent !== "number") return `command ${c.code} has no numeric indent`;
  if (!Array.isArray(c.parameters)) return `command ${c.code} has missing or non-array parameters`;
  return null;
}

/** Stand-in for a malformed entry: keeps list positions and takes the previous indent so it adds no structure problems. */
const PLACEHOLDER_CODE = -1;

export function lintCommandList(rawList: Cmd[], loc: Omit<Finding["location"], "index">, ctx: LintContext): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: LintRule, severity: Severity, index: number, message: string): void => {
    findings.push({ rule, severity, location: { ...loc, index }, message });
  };

  // Malformed entries are reported and replaced by inert placeholders so indexes stay at original positions.
  let list = rawList;
  rawList.forEach((entry, i) => {
    const reason = malformedReason(entry);
    if (reason === null) return;
    if (list === rawList) list = rawList.slice();
    const prevIndent = i > 0 ? list[i - 1].indent : 0;
    list[i] = { code: PLACEHOLDER_CODE, indent: prevIndent, parameters: [] };
    add("block-structure", "error", i, `index ${i}: malformed command (${reason})`);
  });

  for (const problem of validateCommandList(list)) {
    const index = Number(/^index (\d+)/.exec(problem)![1]);
    const terminator = /terminator/.test(problem);
    add(terminator ? "unterminated-list" : "block-structure", "error", index, problem);
  }

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const p = c.parameters;
    switch (c.code) {
      case 115: {
        const next = list[i + 1];
        if (next && next.code !== 0 && next.code !== PLACEHOLDER_CODE && next.indent === c.indent) {
          add("unreachable-command", "warning", i + 1, `command ${next.code} can never run: it follows Exit Event Processing (115) at index ${i}`);
        }
        break;
      }
      case 401: {
        const text = p[0];
        if (typeof text === "string") {
          const len = visibleLength(text);
          if (len > ctx.maxLineChars) {
            add("long-message-line", "warning", i, `message line is about ${len} characters, over the ${ctx.maxLineChars} limit`);
          }
        }
        break;
      }
      case 121: {
        const ids = unnamedIds(ctx.switchNames, p[0], p[1]);
        if (ids.length > 0) add("unnamed-switch", "info", i, `Control Switches uses switch ${describeIds(ids)} with no name in System.json`);
        break;
      }
      case 122: {
        const ids = unnamedIds(ctx.variableNames, p[0], p[1]);
        if (ids.length > 0) add("unnamed-variable", "info", i, `Control Variables uses variable ${describeIds(ids)} with no name in System.json`);
        break;
      }
      case 117: {
        if (isInt(p[0]) && !ctx.commonEventIds.has(p[0])) {
          add("missing-common-event", "error", i, `Common Event ${p[0]} does not exist`);
        }
        break;
      }
      case 201: {
        if (p[0] !== 0 || !isInt(p[1])) break; // variable designation is only known at run time
        if (!ctx.mapIds.has(p[1])) {
          add("transfer-missing-map", "error", i, `Transfer Player targets map ${p[1]}, which is not in MapInfos`);
          break;
        }
        const size = ctx.mapSizes.get(p[1]);
        const x = p[2];
        const y = p[3];
        if (size && isInt(x) && isInt(y) && (x < 0 || y < 0 || x >= size.width || y >= size.height)) {
          add("transfer-out-of-bounds", "error", i, `Transfer Player to (${x}, ${y}) is outside map ${p[1]} (${size.width}x${size.height})`);
        }
        break;
      }
    }
  }
  return findings;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const names = (v: unknown): string[] => asArray(v).map((n) => (typeof n === "string" ? n : ""));

function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    KIND_RANK[a.location.kind] - KIND_RANK[b.location.kind] ||
    (a.location.mapId ?? 0) - (b.location.mapId ?? 0) ||
    a.location.eventId - b.location.eventId ||
    a.location.page - b.location.page ||
    a.location.index - b.location.index
  );
}

export async function lintProject(
  project: Project,
  opts: { scope: LintScope; mapId?: number; maxLineChars: number; minSeverity: Severity },
): Promise<LintResult> {
  void project.root; // throws the standard "No project selected" error first
  const read = (name: string): Promise<unknown> => project.readJson(project.dataFile(name));
  const system = await read("System.json");
  const sys: Obj = isObj(system) ? system : {};
  const mapInfos = asArray(await read("MapInfos.json"));
  const commonEvents = asArray(await read("CommonEvents.json"));

  const mapIds = new Set<number>();
  for (const info of mapInfos) if (isObj(info) && isInt(info.id)) mapIds.add(info.id);
  if (opts.mapId !== undefined && !mapIds.has(opts.mapId)) {
    throw new ProjectError(`map ${opts.mapId} is not listed in MapInfos.json. Use list_maps to see the map ids.`);
  }
  const commonEventIds = new Set<number>();
  for (const ce of commonEvents) if (isObj(ce) && isInt(ce.id)) commonEventIds.add(ce.id);

  // Every map is loaded: transfer targets need their sizes even when only one map is linted.
  const mapSizes = new Map<number, { width: number; height: number }>();
  const maps = new Map<number, Obj>();
  const unreadable: number[] = [];
  for (const id of [...mapIds].sort((a, b) => a - b)) {
    try {
      const map = await project.readJson(project.mapFile(id));
      if (!isObj(map)) throw new Error("not an object");
      maps.set(id, map);
      if (isInt(map.width) && isInt(map.height)) mapSizes.set(id, { width: map.width, height: map.height });
    } catch {
      unreadable.push(id);
    }
  }

  const ctx: LintContext = {
    mapIds,
    mapSizes,
    commonEventIds,
    switchNames: names(sys.switches),
    variableNames: names(sys.variables),
    maxLineChars: opts.maxLineChars,
  };

  const findings: Finding[] = [];
  const lintList = (list: unknown, loc: Omit<Finding["location"], "index">): void => {
    if (Array.isArray(list)) findings.push(...lintCommandList(list as Cmd[], loc, ctx));
  };
  const lintPages = (pages: unknown, base: Omit<Finding["location"], "index" | "page">): void => {
    asArray(pages).forEach((page, pageIndex) => {
      if (isObj(page)) lintList(page.list, { ...base, page: pageIndex });
    });
  };

  const doMaps = opts.scope === "maps" || opts.scope === "all";
  const skippedMaps: number[] = [];
  if (doMaps) {
    for (const id of unreadable) if (opts.mapId === undefined || opts.mapId === id) skippedMaps.push(id);
    for (const [id, map] of maps) {
      if (opts.mapId !== undefined && opts.mapId !== id) continue;
      asArray(map.events).forEach((ev, evIndex) => {
        if (!isObj(ev)) return;
        lintPages(ev.pages, { kind: "map", mapId: id, eventId: isInt(ev.id) ? ev.id : evIndex });
      });
    }
  }
  if (opts.scope === "commonEvents" || opts.scope === "all") {
    commonEvents.forEach((ce, i) => {
      if (isObj(ce)) lintList(ce.list, { kind: "commonEvent", eventId: isInt(ce.id) ? ce.id : i, page: 0 });
    });
  }
  if (opts.scope === "troops" || opts.scope === "all") {
    asArray(await read("Troops.json")).forEach((troop, i) => {
      if (isObj(troop)) lintPages(troop.pages, { kind: "troop", eventId: isInt(troop.id) ? troop.id : i });
    });
  }

  const kept = findings
    .filter((f) => SEVERITY_RANK[f.severity] <= SEVERITY_RANK[opts.minSeverity])
    .sort(compareFindings);
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of kept) counts[f.severity]++;
  return {
    findings: kept.slice(0, MAX_FINDINGS),
    counts,
    skippedMaps,
    truncated: Math.max(0, kept.length - MAX_FINDINGS),
  };
}

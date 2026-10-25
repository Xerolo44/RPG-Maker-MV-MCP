// Shared, pure project index for the analysis tools (find_usages, analyze_progression).
// It flattens a project into event pages plus typed references (reads, writes, uses) taken from page
// conditions, event commands, selected database fields and System.json. Nothing here guesses: whatever
// cannot be resolved statically (script and plugin commands, variable-designated transfers and battles)
// is only counted in `hidden`. Page numbers (`page`) are 0-based indexes into the pages array, like lint.
import type { Cmd } from "./commandList.js";
import type { Project } from "./project.js";

export type RefKind =
  | "switch"
  | "variable"
  | "item"
  | "weapon"
  | "armor"
  | "skill"
  | "state"
  | "actor"
  | "class"
  | "enemy"
  | "troop"
  | "commonEvent"
  | "map";

export type RefRole = "read" | "write" | "use";

export interface Ref {
  kind: RefKind;
  id: number;
  role: RefRole;
}

export interface Where {
  source: "map" | "commonEvent" | "troop" | "database" | "system";
  mapId?: number;
  /** Map event id, common event id, or troop id. */
  eventId?: number;
  /** 0-based page index. */
  page?: number;
  /** 0-based index into the command list. */
  index?: number;
  /** Database file without extension, e.g. "Enemies". */
  table?: string;
  recordId?: number;
  field?: string;
}

export interface IndexedRef extends Ref {
  where: Where;
}

/** The MV page condition fields; all optional so partial or hand-written data type-checks. */
export interface PageConditions {
  switch1Valid?: boolean;
  switch1Id?: number;
  switch2Valid?: boolean;
  switch2Id?: number;
  variableValid?: boolean;
  variableId?: number;
  variableValue?: number;
  itemValid?: boolean;
  itemId?: number;
  actorValid?: boolean;
  actorId?: number;
  selfSwitchValid?: boolean;
  selfSwitchCh?: string;
}

export interface EventPage {
  kind: "map" | "commonEvent" | "troop";
  mapId?: number;
  /** Map event id, common event id, or troop id. */
  eventId: number;
  /** 0-based page index (always 0 for common events). */
  page: number;
  list: Cmd[];
  /**
   * Map pages: `page.conditions` as stored. Troop pages: only the switch and actor conditions, mapped onto
   * `switch1*` and `actor*`. Common events: trigger 1/2 with a valid `switchId` gives `switch1Valid` +
   * `switch1Id`; otherwise undefined (trigger 0 means the event only runs when a 117 calls it).
   */
  conditions?: PageConditions;
  /** Map page trigger, or the common event's own trigger (0 none, 1 autorun, 2 parallel). */
  trigger?: number;
  name?: string;
}

export interface ProjectIndex {
  refs: IndexedRef[];
  pages: EventPage[];
  /** Every map id listed in MapInfos.json, ascending. */
  mapIds: number[];
  /** Listed maps whose file is missing or unreadable, ascending. */
  unreadableMaps: number[];
  startMapId: number;
  partyMembers: number[];
  /** Commands the index cannot resolve, counted over ALL pages (reachable or not). */
  hidden: {
    scriptCommands: number;
    pluginCommands: number;
    variableTransfers: number;
    variableBattles: number;
    /** 121/122 commands whose id range was longer than 1000 and therefore only partly indexed. */
    truncatedRanges: number;
  };
}

/** Longest 121/122 range expanded per command. */
export const MAX_RANGE = 1000;
/** Largest id accepted anywhere; protects against absurd values in damaged data. */
const MAX_ID = 2 ** 31 - 1;

const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_ID;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

const ref = (kind: RefKind, id: number, role: RefRole): Ref => ({ kind, id, role });
const GOODS: RefKind[] = ["item", "weapon", "armor"];

function rangeRefs(kind: RefKind, start: unknown, end: unknown, role: RefRole): Ref[] {
  if (!isId(start) || !isId(end)) return [];
  const out: Ref[] = [];
  const last = Math.min(end, start + MAX_RANGE - 1);
  for (let id = start; id <= last; id++) out.push(ref(kind, id, role));
  return out;
}

const TEXT_VARIABLE = /\\[Vv]\[(\d+)\]/g;
/** Most route entries scanned in one 205 command. */
const MAX_ROUTE_ENTRIES = 1000;

/** Variables named by `\V[n]` escapes in the given strings, each once, in order of appearance. */
function textVariableRefs(texts: unknown[]): Ref[] {
  const seen = new Set<number>();
  const out: Ref[] = [];
  for (const text of texts) {
    if (typeof text !== "string" || !text.includes("\\")) continue;
    for (const m of text.matchAll(TEXT_VARIABLE)) {
      const id = Number(m[1]);
      if (isId(id) && !seen.has(id)) {
        seen.add(id);
        out.push(ref("variable", id, "read"));
      }
    }
  }
  return out;
}

/** The first MAX_ROUTE_ENTRIES route commands of a 205 (empty when the route is malformed). */
function routeEntries(p: unknown[]): Record<string, unknown>[] {
  const route = p[1];
  if (typeof route !== "object" || route === null) return [];
  const list = (route as Record<string, unknown>).list;
  if (!Array.isArray(list)) return [];
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < list.length && i < MAX_ROUTE_ENTRIES; i++) {
    const entry = list[i];
    if (typeof entry === "object" && entry !== null) out.push(entry as Record<string, unknown>);
  }
  return out;
}

/** Number of script route commands (code 45) in a 205. */
function routeScriptCount(c: Cmd): number {
  if (typeof c !== "object" || c === null || c.code !== 205 || !Array.isArray(c.parameters)) return 0;
  return routeEntries(c.parameters).filter((e) => e.code === 45).length;
}

/** Adds a variable read when `v` is a valid id. */
function readVar(out: Ref[], v: unknown): void {
  if (isId(v)) out.push(ref("variable", v, "read"));
}

/**
 * The actor of a 311..318 command: p[0]=0 names the actor, p[0]=1 names a variable holding the actor id.
 * Adds nothing for any other designation.
 */
function actorOrVariable(out: Ref[], p: unknown[]): void {
  if (!isId(p[1])) return;
  if (p[0] === 0) out.push(ref("actor", p[1], "use"));
  else if (p[0] === 1) out.push(ref("variable", p[1], "read"));
}

/** True when a 121/122 range is valid but longer than MAX_RANGE ids (so only the first MAX_RANGE are indexed). */
function isTruncatedRange(c: Cmd): boolean {
  if (typeof c !== "object" || c === null || (c.code !== 121 && c.code !== 122) || !Array.isArray(c.parameters)) return false;
  const [start, end] = c.parameters;
  return isId(start) && isId(end) && end - start + 1 > MAX_RANGE;
}

/** Event commands (the plan's table plus variable operands, designations and text escapes) to references. Pure; tolerates malformed commands. */
export function commandRefs(c: Cmd): Ref[] {
  if (typeof c !== "object" || c === null) return [];
  const p = c.parameters;
  if (!Array.isArray(p)) return [];
  switch (c.code) {
    case 102:
      return Array.isArray(p[0]) ? textVariableRefs(p[0]) : [];
    case 401:
    case 405:
      return textVariableRefs([p[0]]);
    case 103:
    case 104:
      return isId(p[0]) ? [ref("variable", p[0], "write")] : [];
    case 111: {
      switch (p[0]) {
        case 0:
          return isId(p[1]) ? [ref("switch", p[1], "read")] : [];
        case 1: {
          const out: Ref[] = [];
          readVar(out, p[1]);
          if (p[2] === 1) readVar(out, p[3]);
          return out;
        }
        case 4:
          return isId(p[1]) ? [ref("actor", p[1], "read")] : [];
        case 8:
          return isId(p[1]) ? [ref("item", p[1], "read")] : [];
        case 9:
          return isId(p[1]) ? [ref("weapon", p[1], "read")] : [];
        case 10:
          return isId(p[1]) ? [ref("armor", p[1], "read")] : [];
        default:
          return [];
      }
    }
    case 117:
      return isId(p[0]) ? [ref("commonEvent", p[0], "use")] : [];
    case 121:
      return rangeRefs("switch", p[0], p[1], "write");
    case 122: {
      const out = rangeRefs("variable", p[0], p[1], "write");
      if (p[3] === 1) readVar(out, p[4]);
      return out;
    }
    case 125: {
      const out: Ref[] = [];
      if (p[1] === 1) readVar(out, p[2]);
      return out;
    }
    case 126:
    case 127:
    case 128: {
      const out: Ref[] = [];
      if (isId(p[0])) out.push(ref(GOODS[c.code - 126], p[0], "write"));
      if (p[2] === 1) readVar(out, p[3]);
      return out;
    }
    case 129:
      return isId(p[0]) ? [ref("actor", p[0], "write")] : [];
    case 201: {
      const out: Ref[] = [];
      if (p[0] === 0) {
        if (isId(p[1])) out.push(ref("map", p[1], "use"));
      } else if (p[0] === 1) {
        readVar(out, p[1]);
        readVar(out, p[2]);
        readVar(out, p[3]);
      }
      return out;
    }
    case 202: {
      const out: Ref[] = [];
      if (p[1] === 0) {
        if (isId(p[2])) out.push(ref("map", p[2], "use"));
      } else if (p[1] === 1) {
        readVar(out, p[2]);
        readVar(out, p[3]);
        readVar(out, p[4]);
      }
      return out;
    }
    case 203: {
      const out: Ref[] = [];
      if (p[1] === 1) {
        readVar(out, p[2]);
        readVar(out, p[3]);
      }
      return out;
    }
    case 205: {
      const out: Ref[] = [];
      for (const e of routeEntries(p)) {
        if ((e.code === 27 || e.code === 28) && Array.isArray(e.parameters) && isId(e.parameters[0])) {
          out.push(ref("switch", e.parameters[0], "write"));
        }
      }
      return out;
    }
    case 231: {
      const out: Ref[] = [];
      if (p[3] === 1) {
        readVar(out, p[4]);
        readVar(out, p[5]);
      }
      return out;
    }
    case 285: {
      const out: Ref[] = [];
      if (isId(p[0])) out.push(ref("variable", p[0], "write"));
      if (p[2] === 1) {
        readVar(out, p[3]);
        readVar(out, p[4]);
      }
      return out;
    }
    case 301: {
      const out: Ref[] = [];
      if (p[0] === 0) {
        if (isId(p[1])) out.push(ref("troop", p[1], "use"));
      } else if (p[0] === 1) {
        readVar(out, p[1]);
      }
      return out;
    }
    case 302:
    case 605: {
      const kind = typeof p[0] === "number" ? GOODS[p[0]] : undefined;
      return kind !== undefined && isId(p[1]) ? [ref(kind, p[1], "use")] : [];
    }
    case 311:
    case 312:
    case 315:
    case 316: {
      const out: Ref[] = [];
      actorOrVariable(out, p);
      if (p[3] === 1) readVar(out, p[4]);
      return out;
    }
    case 317: {
      const out: Ref[] = [];
      actorOrVariable(out, p);
      if (p[4] === 1) readVar(out, p[5]);
      return out;
    }
    case 313:
    case 318: {
      const out: Ref[] = [];
      actorOrVariable(out, p);
      if ((p[0] === 0 || p[0] === 1) && isId(p[3])) out.push(ref(c.code === 313 ? "state" : "skill", p[3], "write"));
      return out;
    }
    case 331:
    case 332: {
      const out: Ref[] = [];
      if (p[2] === 1) readVar(out, p[3]);
      return out;
    }
    case 321: {
      if (!isId(p[0])) return [];
      const out = [ref("actor", p[0], "use")];
      if (isId(p[1])) out.push(ref("class", p[1], "use"));
      return out;
    }
    case 322:
    case 303:
      return isId(p[0]) ? [ref("actor", p[0], "use")] : [];
    default:
      return [];
  }
}

/** References made by a page's conditions (valid flags only). */
export function conditionRefs(c: PageConditions | undefined): Ref[] {
  if (typeof c !== "object" || c === null) return [];
  const out: Ref[] = [];
  if (c.switch1Valid === true && isId(c.switch1Id)) out.push(ref("switch", c.switch1Id, "read"));
  if (c.switch2Valid === true && isId(c.switch2Id)) out.push(ref("switch", c.switch2Id, "read"));
  if (c.variableValid === true && isId(c.variableId)) out.push(ref("variable", c.variableId, "read"));
  if (c.itemValid === true && isId(c.itemId)) out.push(ref("item", c.itemId, "read"));
  if (c.actorValid === true && isId(c.actorId)) out.push(ref("actor", c.actorId, "read"));
  return out;
}

/**
 * Commands whose effect is only known at run time. 655 (script continuation) and 505 (route rows) are
 * deliberately not counted. A 205 is "script" when its route holds a script command (code 45).
 */
export function hiddenKind(c: Cmd): "script" | "plugin" | "variableTransfer" | "variableBattle" | null {
  if (typeof c !== "object" || c === null) return null;
  const p = c.parameters;
  switch (c.code) {
    case 355:
      return "script";
    case 356:
      return "plugin";
    case 111:
      return Array.isArray(p) && p[0] === 12 ? "script" : null;
    case 122:
      return Array.isArray(p) && p[3] === 4 ? "script" : null;
    case 205:
      return routeScriptCount(c) > 0 ? "script" : null;
    case 201:
      return Array.isArray(p) && p[0] === 1 ? "variableTransfer" : null;
    case 301:
      return Array.isArray(p) && (p[0] === 1 || p[0] === 2) ? "variableBattle" : null;
    default:
      return null;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Loads a data file; a missing, unreadable or invalid file gives undefined. */
async function tryRead(project: Project, name: string): Promise<unknown> {
  try {
    return await project.readJson(project.dataFile(name));
  } catch {
    return undefined;
  }
}

export async function buildProjectIndex(project: Project): Promise<ProjectIndex> {
  void project.root; // throws the standard "No project selected" error first
  const system = await tryRead(project, "System.json");
  const sys: Obj = isObj(system) ? system : {};
  const mapInfos = asArray(await tryRead(project, "MapInfos.json"));

  const index: ProjectIndex = {
    refs: [],
    pages: [],
    mapIds: [],
    unreadableMaps: [],
    startMapId: isInt(sys.startMapId) ? sys.startMapId : 0,
    partyMembers: asArray(sys.partyMembers).filter(isId),
    hidden: { scriptCommands: 0, pluginCommands: 0, variableTransfers: 0, variableBattles: 0, truncatedRanges: 0 },
  };
  const { refs, pages, hidden } = index;

  const addRefs = (list: Ref[], where: Where): void => {
    for (const r of list) refs.push({ ...r, where });
  };
  const addUse = (kind: RefKind, id: unknown, where: Where): void => {
    if (isId(id)) refs.push({ kind, id, role: "use", where });
  };

  /** Registers one page: its condition refs, every command's refs and the hidden counters. */
  const addPage = (pg: EventPage, base: Where): void => {
    pages.push(pg);
    addRefs(conditionRefs(pg.conditions), base);
    pg.list.forEach((command, i) => {
      const found = commandRefs(command);
      if (found.length > 0) addRefs(found, { ...base, index: i });
      if (isTruncatedRange(command)) hidden.truncatedRanges++;
      switch (hiddenKind(command)) {
        case "script":
          // A 205 counts once per script route command, every other command once.
          hidden.scriptCommands += command.code === 205 ? routeScriptCount(command) : 1;
          break;
        case "plugin":
          hidden.pluginCommands++;
          break;
        case "variableTransfer":
          hidden.variableTransfers++;
          break;
        case "variableBattle":
          hidden.variableBattles++;
          break;
      }
    });
  };

  // System.json
  addUse("map", sys.startMapId, { source: "system", field: "startMapId" });
  asArray(sys.partyMembers).forEach((id, i) => addUse("actor", id, { source: "system", field: "partyMembers", index: i }));

  // Maps
  for (const info of mapInfos) if (isObj(info) && isId(info.id)) index.mapIds.push(info.id);
  index.mapIds = [...new Set(index.mapIds)].sort((a, b) => a - b);
  for (const mapId of index.mapIds) {
    let map: unknown;
    try {
      map = await project.readJson(project.mapFile(mapId));
    } catch {
      map = undefined;
    }
    if (!isObj(map)) {
      index.unreadableMaps.push(mapId);
      continue;
    }
    for (const enc of asArray(map.encounterList)) {
      if (isObj(enc)) addUse("troop", enc.troopId, { source: "map", mapId, field: "encounterList" });
    }
    asArray(map.events).forEach((ev, evIndex) => {
      if (!isObj(ev)) return;
      const eventId = isInt(ev.id) ? ev.id : evIndex;
      asArray(ev.pages).forEach((raw, pageIndex) => {
        if (!isObj(raw) || !Array.isArray(raw.list)) return;
        const pg: EventPage = { kind: "map", mapId, eventId, page: pageIndex, list: raw.list as Cmd[] };
        if (isObj(raw.conditions)) pg.conditions = raw.conditions as PageConditions;
        if (typeof raw.trigger === "number") pg.trigger = raw.trigger;
        if (typeof ev.name === "string") pg.name = ev.name;
        addPage(pg, { source: "map", mapId, eventId, page: pageIndex });
      });
    });
  }

  // Common events
  asArray(await tryRead(project, "CommonEvents.json")).forEach((ce, i) => {
    if (!isObj(ce) || !Array.isArray(ce.list)) return;
    const eventId = isInt(ce.id) ? ce.id : i;
    const pg: EventPage = { kind: "commonEvent", eventId, page: 0, list: ce.list as Cmd[] };
    if (typeof ce.trigger === "number") pg.trigger = ce.trigger;
    if (typeof ce.name === "string") pg.name = ce.name;
    if ((ce.trigger === 1 || ce.trigger === 2) && isId(ce.switchId)) {
      pg.conditions = { switch1Valid: true, switch1Id: ce.switchId };
    }
    addPage(pg, { source: "commonEvent", eventId });
  });

  // Troops: members (database) and battle event pages
  asArray(await tryRead(project, "Troops.json")).forEach((troop, i) => {
    if (!isObj(troop)) return;
    const eventId = isInt(troop.id) ? troop.id : i;
    for (const m of asArray(troop.members)) {
      if (isObj(m)) addUse("enemy", m.enemyId, { source: "database", table: "Troops", recordId: eventId, field: "members" });
    }
    asArray(troop.pages).forEach((raw, pageIndex) => {
      if (!isObj(raw) || !Array.isArray(raw.list)) return;
      const pg: EventPage = { kind: "troop", eventId, page: pageIndex, list: raw.list as Cmd[] };
      if (isObj(raw.conditions)) {
        const cond = raw.conditions;
        const mapped: PageConditions = {};
        if (cond.switchValid === true) {
          mapped.switch1Valid = true;
          mapped.switch1Id = cond.switchId as number;
        }
        if (cond.actorValid === true) {
          mapped.actorValid = true;
          mapped.actorId = cond.actorId as number;
        }
        pg.conditions = mapped;
      }
      if (typeof troop.name === "string") pg.name = troop.name;
      addPage(pg, { source: "troop", eventId, page: pageIndex });
    });
  });

  // Database rows (role use)
  const eachRecord = async (file: string, fn: (rec: Obj, recordId: number) => void): Promise<void> => {
    asArray(await tryRead(project, file)).forEach((rec, i) => {
      if (isObj(rec)) fn(rec, isInt(rec.id) ? rec.id : i);
    });
  };
  const db = (table: string, recordId: number, field: string): Where => ({ source: "database", table, recordId, field });
  const effects = (rec: Obj, table: string, recordId: number): void => {
    for (const e of asArray(rec.effects)) {
      if (!isObj(e)) continue;
      const where = db(table, recordId, "effects");
      if (e.code === 21 || e.code === 22) addUse("state", e.dataId, where);
      else if (e.code === 43) addUse("skill", e.dataId, where);
      else if (e.code === 44) addUse("commonEvent", e.dataId, where);
    }
  };

  await eachRecord("Actors.json", (rec, id) => {
    addUse("class", rec.classId, db("Actors", id, "classId"));
    asArray(rec.equips).forEach((equip, slot) => addUse(slot === 0 ? "weapon" : "armor", equip, db("Actors", id, "equips")));
  });
  await eachRecord("Classes.json", (rec, id) => {
    for (const l of asArray(rec.learnings)) if (isObj(l)) addUse("skill", l.skillId, db("Classes", id, "learnings"));
  });
  await eachRecord("Enemies.json", (rec, id) => {
    for (const d of asArray(rec.dropItems)) {
      if (isObj(d) && typeof d.kind === "number" && d.kind >= 1 && d.kind <= 3) addUse(GOODS[d.kind - 1], d.dataId, db("Enemies", id, "dropItems"));
    }
    for (const a of asArray(rec.actions)) if (isObj(a)) addUse("skill", a.skillId, db("Enemies", id, "actions"));
  });
  await eachRecord("Items.json", (rec, id) => effects(rec, "Items", id));
  await eachRecord("Skills.json", (rec, id) => effects(rec, "Skills", id));

  return index;
}
